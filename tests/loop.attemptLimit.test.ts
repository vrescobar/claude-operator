import { beforeEach, describe, expect, test } from "bun:test";
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

function setup(): { cfg: Config; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-attempt-cap-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    [
      "## Phase X",
      "- [ ] **77** Always-fails task",
      "- [ ] **78** Reachable after #77 is blocked",
      "",
    ].join("\n"),
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));

  execaSync("git", ["init", "-q"], { cwd: root });
  execaSync("git", ["config", "user.email", "smoke@test.local"], { cwd: root });
  execaSync("git", ["config", "user.name", "Smoke"], { cwd: root });
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
    maxIterations: 10,
    claudeBin: FAKE_CLAUDE,
    agentBackend: "claude",
    claudePBin: "claude-p",
    serverErrorRetryBaseMs: 0,
    serverErrorRetryCapMs: 0,
    serverErrorMaxConsecutive: 20,
    blockedRetryCooldownHours: 6,
    runMode: "normal",
    claudeModel: "fake",
    claudeTimeoutMs: 5000,
    testTimeoutMs: 5000,
    gitTimeoutMs: 10_000,
    noChangeRetryLimit: 1,
    taskAttemptLimit: 3,
    failResetMode: "leave",
    rateLimitFallbackMs: 0,
    rateLimitFallbackCapMs: 0,
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
    reviewerModel: "fake",
    reviewerTimeoutMs: 5000,
    fixerBin: FAKE_CLAUDE,
    fixerModel: "fake",
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

describe("ralph loop — attempt limit", () => {
  let cfg: Config;
  let root: string;

  beforeEach(() => {
    const s = setup();
    cfg = s.cfg;
    root = s.root;
  });

  test("a phase that always fails gets its tasks blocked after taskAttemptLimit attempts", async () => {
    let agentCalls = 0;
    const code = await runLoop(cfg, {
      agentFactory: () => {
        agentCalls++;
        return new AgentProcess({
          command: FAKE_CLAUDE,
          model: "fake",
          timeoutMs: 5000,
          cwd: root,
          env: { FAKE_CLAUDE_OUT: "fail", FAKE_CLAUDE_EXIT: "5" },
        });
      },
      runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
    });

    // Loop exits cleanly: the single phase exceeds its attempt budget and the
    // loop blocks every remaining task at once, then finds no open phases.
    expect([0, 1]).toContain(code);

    // Phase-level retry: ONE phase containing both tasks, attempted up to
    // taskAttemptLimit (3) times — never more. The iteration cap (10) is a
    // safety net we must not hit.
    expect(agentCalls).toBe(cfg.taskAttemptLimit);

    // Both tasks in the phase must be marked [!] in tasks.md.
    const after = readFileSync(resolve(root, ".ralphloop/tasks.md"), "utf8");
    expect(after).toContain("- [!] **77** Always-fails task");
    expect(after).toContain("- [!] **78** Reachable after #77 is blocked");

    // Progress note must record the phase block.
    const progress = readFileSync(resolve(root, ".ralphloop/progress.md"), "utf8");
    expect(progress).toContain("Phase X blocked");

    // Persistent state should record the phase entry under its phase key.
    const state = JSON.parse(readFileSync(resolve(root, ".ralphloop/state.json"), "utf8"));
    const phaseEntry = state.tasks["phase:## Phase X"];
    expect(phaseEntry).toBeDefined();
    expect(phaseEntry.attempts).toBeGreaterThanOrEqual(cfg.taskAttemptLimit);
    expect(phaseEntry.blocked).toBe(true);
    expect(state.counters.blocked).toBeGreaterThanOrEqual(2);
  });
});
