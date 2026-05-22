import { describe, test, expect, beforeEach } from "bun:test";
import { execaSync } from "execa";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "../src/AgentProcess.js";
import type { Config } from "../src/Config.js";
import { runLoop } from "../src/loop.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dir, "fixtures", "bin", "fake-claude");

function setupSandbox(): { cfg: Config; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-loop-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    `## Phase X\n- [ ] **77** Smoke test task\n`,
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent. do nothing.\n");
  // Minimal package.json with no test script so defaultRunTests skips.
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));

  // Initialise as a git repo for ensureRepo to be a no-op and commit to work.
  // Plain `git init -q` (no `-b main`) for compatibility with older git
  // versions in CI / on this host.
  execaSync("git", ["init", "-q"], { cwd: root });
  execaSync("git", ["config", "user.email", "smoke@test.local"], { cwd: root });
  execaSync("git", ["config", "user.name", "Smoke Test"], { cwd: root });
  // One initial commit so HEAD exists (otherwise `git diff` against HEAD is awkward).
  execaSync("git", ["add", "-A"], { cwd: root });
  execaSync("git", ["commit", "--no-verify", "-m", "init"], { cwd: root });

  const cfg: Config = {
    repoRoot: root,
    workspaceDir,
    goalFile: resolve(root, "GOAL.md"),
    archiveDir: resolve(workspaceDir, "archive"),
    commitTaskPrefix: "task",
    commitReviewPrefix: "review",
    tasksFile: resolve(workspaceDir, "tasks.md"),
    progressFile: resolve(workspaceDir, "progress.md"),
    promptFile: resolve(workspaceDir, "prompt.md"),
    logsDir: resolve(workspaceDir, "logs"),
    lockFile: resolve(workspaceDir, "lock"),
    stateFile: resolve(workspaceDir, "state.json"),
    metricsFile: resolve(workspaceDir, "metrics.jsonl"),
    // 2 iterations: one to commit the single task, the next to notice the
    // task list is empty and exit 0 cleanly.
    maxIterations: 2,
    stopMarker: "TASK_COMPLETE",
    claudeBin: FAKE_CLAUDE,
    agentBackend: "claude",
    claudePBin: "claude-p",
    serverErrorRetryBaseMs: 0,
    serverErrorRetryCapMs: 0,
    serverErrorMaxConsecutive: 20,
    blockedRetryCooldownHours: 6,
    runMode: "normal",
    claudeModel: "fake-model",
    claudeTimeoutMs: 5000,
    testTimeoutMs: 5000,
    gitTimeoutMs: 10_000,
    noChangeRetryLimit: 1,
    taskAttemptLimit: 5,
    failResetMode: "leave",
    rateLimitFallbackMs: 60_000,
    rateLimitFallbackCapMs: 60_000,
    rateLimitJitterMs: 0,
    minRateLimitSleepMs: 0,
    agentMaxBufferBytes: 1024 * 1024,
    typecheckEnabled: false,
    logRetentionDays: 0,
    progressMaxBytes: 1024 * 1024,
    progressTailKeepBytes: 8 * 1024,
    autoArchiveClosedPhases: false,
    reviewEnabled: false,
    reviewerBin: FAKE_CLAUDE,
    reviewerModel: "fake-model",
    reviewerTimeoutMs: 5000,
    fixerBin: FAKE_CLAUDE,
    fixerModel: "fake-model",
    fixerTimeoutMs: 5000,
    reviewMaxRounds: 2,
    reviewRlMaxConsecutiveHits: 3,
    reviewMaxNoOpRounds: 2,
    reviewMaxRepeatDiffRounds: 2,
    reviewMaxReviewerFailures: 2,
    finishMerge: false,
    finishMergeTargetBranch: "main",
    verbose: false,
    dryRun: false,
  };
  return { cfg, root };
}

describe("ralph loop (smoke)", () => {
  let cfg: Config;
  let root: string;

  beforeEach(() => {
    const setup = setupSandbox();
    cfg = setup.cfg;
    root = setup.root;
  });

  test("happy path: agent marks task done, file changes, commit succeeds", async () => {
    // Agent factory: simulate the agent by marking the task done and
    // creating a file change in the sandbox. No real claude is needed.
    const agentFactory = (
      _c: Config,
      _logFile: string,
      _onLine: (s: "stdout" | "stderr", l: string) => void,
    ): AgentProcess => {
      // Stub: still uses FAKE_CLAUDE for the spawn (so AgentProcess is real),
      // but the side-effects (markTaskDone, file write) happen here before
      // the spawn so the loop sees a finished task afterward.
      const tasksPath = resolve(root, ".ralphloop/tasks.md");
      const before = readFileSync(tasksPath, "utf8");
      writeFileSync(tasksPath, before.replace("- [ ] **77**", "- [x] **77**"));
      writeFileSync(resolve(root, "smoke-output.txt"), "produced by agent\n");
      return new AgentProcess({
        command: FAKE_CLAUDE,
        model: "fake-model",
        timeoutMs: 5000,
        cwd: root,
        env: { FAKE_CLAUDE_OUT: "agent ran", FAKE_CLAUDE_EXIT: "0" },
      });
    };

    const code = await runLoop(cfg, {
      agentFactory,
      runTests: async () => ({ ok: true, durationMs: 10, summary: "stub", output: "" }),
    });
    expect(code).toBe(0);

    // Task marked done in tasks.md
    const tasksAfter = readFileSync(resolve(root, ".ralphloop/tasks.md"), "utf8");
    expect(tasksAfter).toContain("- [x] **77**");

    // A commit was created
    const log = execaSync("git", ["log", "--oneline"], { cwd: root });
    expect(log.stdout).toContain("task(77): Smoke test task");
  });

  test("agent failure: non-zero exit retries the same task", async () => {
    const agentFactory = (
      _c: Config,
      _logFile: string,
      _onLine: (s: "stdout" | "stderr", l: string) => void,
    ): AgentProcess =>
      new AgentProcess({
        command: FAKE_CLAUDE,
        model: "fake-model",
        timeoutMs: 5000,
        cwd: root,
        env: { FAKE_CLAUDE_OUT: "fail", FAKE_CLAUDE_EXIT: "3" },
      });

    const code = await runLoop({ ...cfg, maxIterations: 1 }, {
      agentFactory,
      runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
    });
    // Loop hit max iterations without finishing — exit 1 mirrors loop.sh.
    expect(code).toBe(1);

    // Task is still open; nothing committed.
    const tasksAfter = readFileSync(resolve(root, ".ralphloop/tasks.md"), "utf8");
    expect(tasksAfter).toContain("- [ ] **77**");
  });

  test("rate limit causes the loop to sleep and re-attempt — stub returns rate-limited", async () => {
    // Generic "rate limit exceeded" with no time -> the loop falls back to
    // `rateLimitFallbackMs` (set to 0 below) and sleeps ~0 ms, completing
    // the iteration as a "rate-limited" outcome (returning before tests /
    // commit).
    const agentFactory = (
      _c: Config,
      _logFile: string,
      _onLine: (s: "stdout" | "stderr", l: string) => void,
    ): AgentProcess =>
      new AgentProcess({
        command: FAKE_CLAUDE,
        model: "fake-model",
        timeoutMs: 5000,
        cwd: root,
        env: {
          FAKE_CLAUDE_OUT: "rate limit exceeded — please slow down",
          FAKE_CLAUDE_EXIT: "1",
        },
      });

    const before = Date.now();
    const code = await runLoop(
      { ...cfg, maxIterations: 1, rateLimitFallbackMs: 0, rateLimitFallbackCapMs: 0 },
      {
        agentFactory,
        runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
      },
    );
    const took = Date.now() - before;

    // Hit max iterations after the rate-limit handling. Rate-limit is a
    // recoverable outcome, so a cap reached purely due to a single RL hit
    // exits 0 ("cap-clean") under the new exit-code logic.
    expect(code).toBe(0);
    // Should NOT take the fallback hour.
    expect(took).toBeLessThan(60_000);
  });

  test("stop marker present at start exits 0 immediately", async () => {
    writeFileSync(resolve(root, ".ralphloop/progress.md"), "TASK_COMPLETE\n");
    const code = await runLoop(cfg, {
      agentFactory: () => {
        throw new Error("must not spawn agent");
      },
    });
    expect(code).toBe(0);
  });

  test("no open tasks exits 0 immediately", async () => {
    writeFileSync(resolve(root, ".ralphloop/tasks.md"), "- [x] **01** Done\n");
    const code = await runLoop(cfg, {
      agentFactory: () => {
        throw new Error("must not spawn agent");
      },
    });
    expect(code).toBe(0);
  });
});
