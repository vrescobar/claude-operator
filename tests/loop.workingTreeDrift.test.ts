import { describe, expect, test } from "bun:test";
import { execaSync } from "execa";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "../src/AgentProcess.js";
import type { Config } from "../src/Config.js";
import { runLoop } from "../src/loop.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dir, "fixtures", "bin", "fake-claude");

function setup(failResetMode: "stash" | "reset" | "leave"): { cfg: Config; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-drift-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    "## Phase X\n- [ ] **77** Drift task\n",
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));
  // Mirror real project .gitignore so ralph runtime files don't pollute status.
  writeFileSync(
    resolve(root, ".gitignore"),
    ".ralphloop/lock\n.ralphloop/state.json\n.ralphloop/state.json.tmp\n.ralphloop/metrics.jsonl\n.ralphloop/logs/\n.ralphloop/archive/\n",
  );

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
    maxIterations: 1,
    stopMarker: "TASK_COMPLETE",
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
    taskAttemptLimit: 5,
    failResetMode,
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
    verbose: false,
    dryRun: false,
  };
  return { cfg, root };
}

function makeAgent(root: string) {
  return (
    _c: Config,
    _logFile: string,
    _onLine: (s: "stdout" | "stderr", l: string) => void,
  ): AgentProcess => {
    const tasksPath = resolve(root, ".ralphloop/tasks.md");
    const before = readFileSync(tasksPath, "utf8");
    writeFileSync(tasksPath, before.replace("- [ ] **77**", "- [x] **77**"));
    // Touch a tracked-style file so dirty=true.
    writeFileSync(resolve(root, "drift.ts"), "export const x = 1;\n");
    return new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: root,
      env: { FAKE_CLAUDE_OUT: "ran", FAKE_CLAUDE_EXIT: "0" },
    });
  };
}

describe("working-tree drift cleanup", () => {
  test("failResetMode=stash: tests-failed → working tree clean for next iteration", async () => {
    const { cfg, root } = setup("stash");
    const code = await runLoop(cfg, {
      agentFactory: makeAgent(root),
      runTests: async () => ({ ok: false, durationMs: 5, summary: "stub-fail", output: "" }),
    });
    // Hit max iterations after the failed iteration → exit 1.
    expect(code).toBe(1);

    // Working tree must be clean afterwards (file was stashed).
    const status = execaSync("git", ["status", "--porcelain"], { cwd: root }).stdout;
    expect(status.trim()).toBe("");

    // The stashed change must still be retrievable.
    const stash = execaSync("git", ["stash", "list"], { cwd: root }).stdout;
    expect(stash).toContain("ralph-fail/tests-failed/task-77");

    // Tasks.md must show the task reverted to [ ].
    const tasks = readFileSync(resolve(root, ".ralphloop/tasks.md"), "utf8");
    expect(tasks).toContain("- [ ] **77**");
    // drift.ts should NOT be present in the working tree (it's in the stash).
    expect(existsSync(resolve(root, "drift.ts"))).toBe(false);
  });

  test("failResetMode=reset: tests-failed → working tree hard-reset", async () => {
    const { cfg, root } = setup("reset");
    const code = await runLoop(cfg, {
      agentFactory: makeAgent(root),
      runTests: async () => ({ ok: false, durationMs: 5, summary: "stub-fail", output: "" }),
    });
    expect(code).toBe(1);
    const status = execaSync("git", ["status", "--porcelain"], { cwd: root }).stdout;
    expect(status.trim()).toBe("");
    expect(existsSync(resolve(root, "drift.ts"))).toBe(false);
    // No stash created in this mode.
    const stash = execaSync("git", ["stash", "list"], { cwd: root }).stdout;
    expect(stash.trim()).toBe("");
  });

  test("failResetMode=leave: tests-failed → working tree retains the drift (legacy)", async () => {
    const { cfg, root } = setup("leave");
    await runLoop(cfg, {
      agentFactory: makeAgent(root),
      runTests: async () => ({ ok: false, durationMs: 5, summary: "stub-fail", output: "" }),
    });
    expect(existsSync(resolve(root, "drift.ts"))).toBe(true);
  });
});
