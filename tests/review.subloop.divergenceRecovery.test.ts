/**
 * Sub-loop divergence recovery tests.
 *
 * The original behaviour was: if the review sub-loop runs out of fix
 * opportunities without converging, throw `ReviewSubloopExceededError` and
 * have the outer loop halt with exit code 2. That left the user staring at
 * a broken HEAD with no automatic recovery — exactly the situation the user
 * reported when ralph stopped on task #42.
 *
 * The new contract is symmetric with `tests-failed` in the main loop:
 *   - tests pass at HEAD when sub-loop gives up → accept the task as
 *     `committed-review-skipped`, keep going.
 *   - tests fail at HEAD when sub-loop gives up → discard the failed
 *     commit chain (`git reset --hard <originalSha>~1`), revert the task
 *     checkbox to `[ ]`, drop the dirty tree, surface as `tests-failed`
 *     so the next iteration retries the task with the main agent.
 *
 * We exercise both branches end-to-end through `runLoop` so we catch any
 * regression in either the subloop's outcome shape or the outer loop's
 * recovery glue.
 */

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
const FAKE_REVIEWER = resolve(__dir, "fixtures", "bin", "fake-reviewer");
const FAKE_FIXER = resolve(__dir, "fixtures", "bin", "fake-fixer");

interface Sandbox {
  cfg: Config;
  root: string;
}

function setupSandbox(maxIterations: number): Sandbox {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-divergence-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    "## Phase X\n- [ ] **77** Divergence-recovery task\n",
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "div" }));
  writeFileSync(
    resolve(root, ".gitignore"),
    ".ralphloop/lock\n.ralphloop/state.json\n.ralphloop/state.json.tmp\n.ralphloop/metrics.jsonl\n.ralphloop/logs/\n.ralphloop/archive/\n",
  );

  execaSync("git", ["init", "-q"], { cwd: root });
  execaSync("git", ["config", "user.email", "div@test.local"], { cwd: root });
  execaSync("git", ["config", "user.name", "Divergence"], { cwd: root });
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
    maxIterations,
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
    failResetMode: "reset",
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
    reviewEnabled: true,
    reviewerBin: FAKE_REVIEWER,
    reviewerModel: "fake-opus",
    reviewerTimeoutMs: 5000,
    fixerBin: FAKE_FIXER,
    fixerModel: "fake-haiku",
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

/**
 * Wraps the main-agent factory so we can flip a flag every time the agent
 * is spawned. The runTests stub uses the flag to return ok=true exactly
 * once per iteration (for the test gate the main loop runs before
 * commit) and ok=false thereafter (so the sub-loop sees failing tests).
 */
function makeAgentFactoryWithFlag(root: string, flag: { mainJustRan: boolean }) {
  return (
    _c: Config,
    _logFile: string,
    _onLine: (s: "stdout" | "stderr", l: string) => void,
  ): AgentProcess => {
    flag.mainJustRan = true;
    const tasksPath = resolve(root, ".ralphloop/tasks.md");
    const before = readFileSync(tasksPath, "utf8");
    writeFileSync(tasksPath, before.replace("- [ ] **77**", "- [x] **77**"));
    writeFileSync(resolve(root, "subject.ts"), "export const x = 1;\n");
    return new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: root,
      env: { FAKE_CLAUDE_OUT: "ran", FAKE_CLAUDE_EXIT: "0" },
    });
  };
}

describe("review sub-loop divergence recovery", () => {
  let cfg: Config;
  let root: string;

  describe("tests fail throughout sub-loop → reset + revert + retry", () => {
    beforeEach(() => {
      const s = setupSandbox(2);
      cfg = s.cfg;
      root = s.root;
    });

    test("HEAD resets past the task commit and the task is back to [ ]", async () => {
      const flag = { mainJustRan: false };
      let testCalls = 0;
      const code = await runLoop(cfg, {
        agentFactory: makeAgentFactoryWithFlag(root, flag),
        runTests: async () => {
          testCalls++;
          if (flag.mainJustRan) {
            flag.mainJustRan = false;
            return { ok: true, durationMs: 1, summary: "stub-ok", output: "" };
          }
          return {
            ok: false,
            durationMs: 1,
            summary: "stub-fail",
            output: "Error: synthetic test failure",
          };
        },
        // Reviewer always wants more changes, fixer never produces a diff.
        // → no-op streak hits cap → diverges with testsOkAtEnd=false.
        reviewerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_REVIEWER_VERDICT: "NEEDS_CHANGES", FAKE_REVIEWER_BLOCKERS: "1" },
            logStream,
          }),
        fixerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_FIXER,
            model: "fake-haiku",
            timeoutMs: 5000,
            cwd: root,
            env: {} /* no FAKE_FIXER_TOUCH → no diff */,
            logStream,
          }),
      });

      // Two iterations of the same divergence pattern: the loop ran out of
      // iterations without converging, so exit 1 (max-iterations) — *not*
      // exit 2 (legacy halt). The whole point of this test.
      expect(code).toBe(1);

      // The main agent's task commit was reset out, leaving only the
      // initial commit. Otherwise the operator would be stuck with broken
      // commits in their branch.
      const log = execaSync("git", ["log", "--oneline"], { cwd: root });
      expect(log.stdout).not.toContain("task(phase-x):");
      expect(log.stdout).not.toContain("review(phase-x,");
      expect(log.stdout).toContain("init");

      // Task is back to `[ ]` so a future ralph run picks it up again.
      const tasks = readFileSync(resolve(root, ".ralphloop/tasks.md"), "utf8");
      expect(tasks).toContain("- [ ] **77**");
      expect(tasks).not.toContain("- [x] **77**");

      // The sub-loop ran more than once and tests were re-checked many
      // times — sanity check that the path was actually exercised.
      expect(testCalls).toBeGreaterThan(2);
    });
  });

  describe("tests pass at HEAD when sub-loop gives up → committed-review-skipped", () => {
    beforeEach(() => {
      const s = setupSandbox(2);
      cfg = s.cfg;
      root = s.root;
    });

    test("task commit is preserved and the loop continues to exit 0", async () => {
      const flag = { mainJustRan: false };
      const code = await runLoop(cfg, {
        agentFactory: makeAgentFactoryWithFlag(root, flag),
        // Tests always pass; sub-loop gives up only because the reviewer
        // keeps insisting on changes that the fixer can't make.
        runTests: async () => ({ ok: true, durationMs: 1, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_REVIEWER_VERDICT: "NEEDS_CHANGES", FAKE_REVIEWER_BLOCKERS: "1" },
            logStream,
          }),
        fixerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_FIXER,
            model: "fake-haiku",
            timeoutMs: 5000,
            cwd: root,
            env: {},
            logStream,
          }),
      });

      // Task got committed, no remaining tasks → exit 0.
      expect(code).toBe(0);

      const log = execaSync("git", ["log", "--oneline"], { cwd: root });
      expect(log.stdout).toContain("task(phase-x):");
    });
  });
});
