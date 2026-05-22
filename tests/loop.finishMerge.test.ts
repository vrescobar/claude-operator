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

/**
 * Sandbox repo on a `main` base branch with a `work` branch checked out and a
 * single open task. The loop commits the task on `work`; the finish-merge step
 * (when enabled) is expected to fold `work` back into `main`.
 */
function setupSandbox(): { cfg: Config; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-finish-merge-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    `## Phase X\n- [ ] **77** Finish-merge task\n`,
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent. do nothing.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "finish-merge" }));
  // Mirror a real consumer repo: the loop's runtime files under .ralphloop/
  // are gitignored, so a successful run leaves a clean working tree.
  writeFileSync(
    resolve(root, ".gitignore"),
    [
      ".ralphloop/state.json",
      ".ralphloop/state.json.tmp",
      ".ralphloop/lock",
      ".ralphloop/metrics.jsonl",
      ".ralphloop/logs/",
      ".ralphloop/archive/",
      "",
    ].join("\n"),
  );

  const git = (...args: string[]): void => {
    execaSync("git", args, { cwd: root });
  };
  // Plain `git init` for compatibility with git < 2.28 (no `-b`); the default
  // branch is then renamed to `main` after the first commit exists.
  git("init", "-q");
  git("config", "user.email", "fm@test.local");
  git("config", "user.name", "Finish Merge Test");
  git("add", "-A");
  git("commit", "--no-verify", "-m", "init");
  git("branch", "-M", "main");
  // Run the loop from a dedicated work branch so the merge has somewhere to go.
  git("checkout", "-q", "-b", "work");

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

/** Agent factory that marks the single task done and writes a file. */
function completingAgentFactory(root: string) {
  return (
    _c: Config,
    _logFile: string,
    _onLine: (s: "stdout" | "stderr", l: string) => void,
  ): AgentProcess => {
    const tasksPath = resolve(root, ".ralphloop/tasks.md");
    const before = readFileSync(tasksPath, "utf8");
    writeFileSync(tasksPath, before.replace("- [ ] **77**", "- [x] **77**"));
    writeFileSync(resolve(root, "fm-output.txt"), "produced by agent\n");
    return new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: root,
      env: { FAKE_CLAUDE_OUT: "agent ran", FAKE_CLAUDE_EXIT: "0" },
    });
  };
}

function currentBranch(root: string): string {
  return execaSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root }).stdout.trim();
}

describe("finish-merge", () => {
  let cfg: Config;
  let root: string;

  beforeEach(() => {
    const setup = setupSandbox();
    cfg = setup.cfg;
    root = setup.root;
  });

  test("disabled (default): stays on the work branch, main untouched", async () => {
    const code = await runLoop(cfg, {
      agentFactory: completingAgentFactory(root),
      runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
    });
    expect(code).toBe(0);
    expect(currentBranch(root)).toBe("work");
    // main has only the init commit (no merge happened).
    const mainLog = execaSync("git", ["log", "--oneline", "main"], { cwd: root });
    expect(mainLog.stdout).not.toContain("task(77)");
  });

  test("enabled: merges work into main with --no-ff and leaves us on main", async () => {
    const code = await runLoop(
      { ...cfg, finishMerge: true, finishMergeTargetBranch: "main" },
      {
        agentFactory: completingAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
      },
    );
    expect(code).toBe(0);
    // Ended on the target branch.
    expect(currentBranch(root)).toBe("main");
    // main now contains the task commit AND a merge commit.
    const mainLog = execaSync("git", ["log", "--oneline", "main"], { cwd: root });
    expect(mainLog.stdout).toContain("task(77)");
    expect(mainLog.stdout).toMatch(/Merge ralph branch 'work' into main/);
    // --no-ff always records a merge commit (2 parents).
    const head = execaSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root });
    expect(head.stdout.trim().split(/\s+/).length).toBe(3);
    // The work branch is preserved.
    const branches = execaSync("git", ["branch", "--list", "work"], { cwd: root });
    expect(branches.stdout).toContain("work");
  });

  test("enabled but already on the target branch: no-op, no merge commit", async () => {
    // Switch the run onto main itself before starting.
    execaSync("git", ["checkout", "-q", "main"], { cwd: root });
    const code = await runLoop(
      { ...cfg, finishMerge: true, finishMergeTargetBranch: "main" },
      {
        agentFactory: completingAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
      },
    );
    expect(code).toBe(0);
    expect(currentBranch(root)).toBe("main");
    const mainLog = execaSync("git", ["log", "--oneline", "main"], { cwd: root });
    // The task was committed directly on main; there must be no merge commit.
    expect(mainLog.stdout).toContain("task(77)");
    expect(mainLog.stdout).not.toMatch(/Merge ralph branch/);
  });

  test("enabled but target branch missing: skips, stays on work branch", async () => {
    const code = await runLoop(
      { ...cfg, finishMerge: true, finishMergeTargetBranch: "release" },
      {
        agentFactory: completingAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 0, summary: "stub", output: "" }),
      },
    );
    expect(code).toBe(0);
    expect(currentBranch(root)).toBe("work");
  });
});
