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

interface SandboxOptions {
  reviewMaxRounds: number;
  reviewRlMaxConsecutiveHits?: number;
  reviewMaxNoOpRounds?: number;
  reviewMaxRepeatDiffRounds?: number;
  reviewMaxReviewerFailures?: number;
}

function setup(opts: SandboxOptions): { cfg: Config; root: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-subloop-guards-"));
  const workspaceDir = resolve(root, ".ralphloop");
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(resolve(workspaceDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(workspaceDir, "tasks.md"),
    "## Phase X\n- [ ] **77** Subloop guard task\n",
  );
  writeFileSync(resolve(workspaceDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(workspaceDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));
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
    maxIterations: 2,
    stopMarker: "TASK_COMPLETE",
    claudeBin: FAKE_CLAUDE,
    claudeModel: "fake",
    claudeTimeoutMs: 5000,
    testTimeoutMs: 5000,
    gitTimeoutMs: 10_000,
    noChangeRetryLimit: 1,
    taskAttemptLimit: 5,
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
    reviewEnabled: true,
    reviewerBin: FAKE_REVIEWER,
    reviewerModel: "fake-opus",
    reviewerTimeoutMs: 5000,
    fixerBin: FAKE_FIXER,
    fixerModel: "fake-haiku",
    fixerTimeoutMs: 5000,
    reviewMaxRounds: opts.reviewMaxRounds,
    reviewRlMaxConsecutiveHits: opts.reviewRlMaxConsecutiveHits ?? 3,
    reviewMaxNoOpRounds: opts.reviewMaxNoOpRounds ?? 2,
    reviewMaxRepeatDiffRounds: opts.reviewMaxRepeatDiffRounds ?? 2,
    reviewMaxReviewerFailures: opts.reviewMaxReviewerFailures ?? 2,
    verbose: false,
    dryRun: false,
  };
  return { cfg, root };
}

function makeMainAgentFactory(root: string) {
  return (
    _c: Config,
    _logFile: string,
    _onLine: (s: "stdout" | "stderr", l: string) => void,
  ): AgentProcess => {
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

describe("review subloop — divergence guards", () => {
  let cfg: Config;
  let root: string;

  describe("rate-limit retries-per-round cap", () => {
    beforeEach(() => {
      const s = setup({ reviewMaxRounds: 5, reviewRlMaxConsecutiveHits: 2 });
      cfg = s.cfg;
      root = s.root;
    });

    test("reviewer always rate-limits → diverges after reviewRlMaxConsecutiveHits tries (loop keeps going)", async () => {
      let calls = 0;
      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) => {
          calls++;
          return new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: {
              FAKE_REVIEWER_VERDICT: "APPROVE",
              FAKE_REVIEWER_RATE_LIMIT: "rate limit exceeded",
              FAKE_REVIEWER_EXIT: "1",
            },
            logStream,
          });
        },
      });
      // Tests pass throughout, so subloop divergence resolves to
      // "committed-review-skipped" and the outer loop continues. With the
      // task already marked [x] there's nothing left, so exit 0.
      expect(code).toBe(0);
      // Reviewer was called exactly reviewRlMaxConsecutiveHits times in
      // round 1 before the safety cap was reached and the sub-loop bailed
      // out.
      expect(calls).toBe(cfg.reviewRlMaxConsecutiveHits);
    });

    test("reviewer RL-then-APPROVE → sub-loop converges; RL does not burn round budget", async () => {
      // Cap consecutive RL hits at 5 so it's higher than what we trigger.
      const s = setup({ reviewMaxRounds: 5, reviewRlMaxConsecutiveHits: 5 });
      cfg = s.cfg;
      root = s.root;
      let calls = 0;
      const RL_TIMES = 3;
      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) => {
          calls++;
          const isRl = calls <= RL_TIMES;
          return new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: isRl
              ? {
                  FAKE_REVIEWER_VERDICT: "APPROVE",
                  FAKE_REVIEWER_RATE_LIMIT: "rate limit exceeded",
                  FAKE_REVIEWER_EXIT: "1",
                }
              : {
                  FAKE_REVIEWER_VERDICT: "APPROVE",
                  FAKE_REVIEWER_EXIT: "0",
                },
            logStream,
          });
        },
      });
      // The first 3 calls rate-limited; the 4th approved. Round 1 converges
      // — divergence did NOT fire even though the old budget (3) would
      // have been exhausted.
      expect(code).toBe(0);
      expect(calls).toBe(RL_TIMES + 1);
    });
  });

  describe("no-op fixer streak", () => {
    beforeEach(() => {
      const s = setup({ reviewMaxRounds: 5, reviewMaxNoOpRounds: 2 });
      cfg = s.cfg;
      root = s.root;
    });

    test("fixer makes no changes for N rounds → diverges; loop accepts review-skipped (exit 0)", async () => {
      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
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
      // Tests pass → divergence path returns "committed-review-skipped"
      // and the outer loop keeps going.
      expect(code).toBe(0);
    });
  });

  describe("reviewer-failed streak (UNKNOWN verdict)", () => {
    beforeEach(() => {
      const s = setup({ reviewMaxRounds: 5, reviewMaxReviewerFailures: 2 });
      cfg = s.cfg;
      root = s.root;
    });

    test("reviewer never produces VERDICT line → diverges; loop accepts review-skipped (exit 0)", async () => {
      // We send an empty / non-conformant report by exiting the reviewer
      // with status 0 but printing nothing parseable. parseVerdict returns
      // UNKNOWN → the subloop counts it as reviewer-failed.
      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_CLAUDE, // intentionally wrong shim — produces a tiny output
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_CLAUDE_OUT: "x", FAKE_CLAUDE_EXIT: "0" },
            logStream,
          }),
      });
      // Tests pass → divergence path returns "committed-review-skipped"
      // and the outer loop keeps going.
      expect(code).toBe(0);
    });
  });
});
