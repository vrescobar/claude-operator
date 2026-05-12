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

function setupSandbox(opts: { reviewMaxRounds: number; reviewEnabled?: boolean }): Sandbox {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-subloop-"));
  const ralphDir = resolve(root, "ralph");
  mkdirSync(ralphDir);
  mkdirSync(resolve(ralphDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(ralphDir, "tasks.md"),
    `## Phase X\n- [ ] **77** Subloop smoke task\n`,
  );
  writeFileSync(resolve(ralphDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(ralphDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));

  execaSync("git", ["init", "-q"], { cwd: root });
  execaSync("git", ["config", "user.email", "smoke@test.local"], { cwd: root });
  execaSync("git", ["config", "user.name", "Smoke Test"], { cwd: root });
  execaSync("git", ["add", "-A"], { cwd: root });
  execaSync("git", ["commit", "--no-verify", "-m", "init"], { cwd: root });

  const cfg: Config = {
    repoRoot: root,
    ralphDir,
    tasksFile: resolve(ralphDir, "tasks.md"),
    progressFile: resolve(ralphDir, "progress.md"),
    promptFile: resolve(ralphDir, "prompt.md"),
    logsDir: resolve(ralphDir, "logs"),
    lockFile: resolve(ralphDir, ".lock"),
    stateFile: resolve(ralphDir, ".state.json"),
    metricsFile: resolve(ralphDir, ".metrics.jsonl"),
    maxIterations: 2,
    stopMarker: "TASK_COMPLETE",
    claudeBin: FAKE_CLAUDE,
    claudeModel: "fake-model",
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
    reviewEnabled: opts.reviewEnabled ?? true,
    reviewerBin: FAKE_REVIEWER,
    reviewerModel: "fake-opus",
    reviewerTimeoutMs: 5000,
    fixerBin: FAKE_FIXER,
    fixerModel: "fake-haiku",
    fixerTimeoutMs: 5000,
    reviewMaxRounds: opts.reviewMaxRounds,
    reviewRlMaxConsecutiveHits: 3,
    reviewMaxNoOpRounds: 2,
    reviewMaxRepeatDiffRounds: 2,
    reviewMaxReviewerFailures: 2,
    verbose: false,
    dryRun: false,
  };
  return { cfg, root };
}

/**
 * Main-loop agent factory. Always succeeds: marks the task done and writes a
 * file so the commitTask path runs.
 */
function makeMainAgentFactory(root: string) {
  return (
    _c: Config,
    _logFile: string,
    _onLine: (s: "stdout" | "stderr", l: string) => void,
  ): AgentProcess => {
    const tasksPath = resolve(root, "ralph/tasks.md");
    const before = readFileSync(tasksPath, "utf8");
    writeFileSync(tasksPath, before.replace("- [ ] **77**", "- [x] **77**"));
    writeFileSync(resolve(root, "subject.ts"), "export const x = 1;\n");
    return new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: root,
      env: { FAKE_CLAUDE_OUT: "main agent ran", FAKE_CLAUDE_EXIT: "0" },
    });
  };
}

describe("review subloop", () => {
  let cfg: Config;
  let root: string;

  describe("convergence in one fix round", () => {
    beforeEach(() => {
      const s = setupSandbox({ reviewMaxRounds: 5 });
      cfg = s.cfg;
      root = s.root;
    });

    test("reviewer NEEDS_CHANGES → fixer mutates → reviewer APPROVE", async () => {
      // Reviewer counts how many times it has been called via a shared file.
      const callsFile = resolve(root, ".reviewer-calls");
      writeFileSync(callsFile, "0");

      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) => {
          const calls = Number.parseInt(readFileSync(callsFile, "utf8"), 10);
          writeFileSync(callsFile, String(calls + 1));
          const env =
            calls === 0
              ? {
                  FAKE_REVIEWER_VERDICT: "NEEDS_CHANGES",
                  FAKE_REVIEWER_BLOCKERS: "1",
                }
              : { FAKE_REVIEWER_VERDICT: "APPROVE" };
          return new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env,
            logStream,
          });
        },
        fixerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_FIXER,
            model: "fake-haiku",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_FIXER_TOUCH: resolve(root, "subject.ts") },
            logStream,
          }),
      });
      expect(code).toBe(0);

      // Two calls to the reviewer (round 1 NEEDS_CHANGES, round 2 APPROVE).
      expect(readFileSync(callsFile, "utf8")).toBe("2");

      // git log should show: init, task(77), review(77, round 1)
      const log = execaSync("git", ["log", "--oneline"], { cwd: root });
      const lines = log.stdout.trim().split("\n");
      expect(lines.find((l) => l.includes("task(77): Subloop smoke task"))).toBeDefined();
      expect(
        lines.find((l) => l.includes("review(77, round 1): apply review feedback")),
      ).toBeDefined();
    });
  });

  describe("divergence → recoverable", () => {
    beforeEach(() => {
      const s = setupSandbox({ reviewMaxRounds: 2 });
      cfg = s.cfg;
      root = s.root;
    });

    test("reviewer always NEEDS_CHANGES + tests ok → diverges, loop continues to exit 0", async () => {
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
            env: { FAKE_FIXER_TOUCH: resolve(root, "subject.ts") },
            logStream,
          }),
      });
      // Tests pass throughout, so divergence resolves to
      // "committed-review-skipped" — the outer loop accepts the chain and
      // continues. With the task already marked [x] there are no more
      // tasks left, so we exit 0 instead of halting at 2.
      expect(code).toBe(0);

      // The original task commit must still be present.
      const log = execaSync("git", ["log", "--oneline"], { cwd: root });
      expect(log.stdout).toContain("task(77): Subloop smoke task");
    });
  });

  describe("rate limit retries the same round", () => {
    beforeEach(() => {
      const s = setupSandbox({ reviewMaxRounds: 2 });
      cfg = s.cfg;
      root = s.root;
    });

    test("reviewer rate-limits once → loop sleeps → next call APPROVE", async () => {
      const callsFile = resolve(root, ".reviewer-calls");
      writeFileSync(callsFile, "0");

      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: (logStream) => {
          const calls = Number.parseInt(readFileSync(callsFile, "utf8"), 10);
          writeFileSync(callsFile, String(calls + 1));
          if (calls === 0) {
            return new AgentProcess({
              command: FAKE_REVIEWER,
              model: "fake-opus",
              timeoutMs: 5000,
              cwd: root,
              env: {
                FAKE_REVIEWER_VERDICT: "NEEDS_CHANGES",
                FAKE_REVIEWER_RATE_LIMIT:
                  "rate limit exceeded — please slow down",
                FAKE_REVIEWER_EXIT: "1",
              },
              logStream,
            });
          }
          return new AgentProcess({
            command: FAKE_REVIEWER,
            model: "fake-opus",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_REVIEWER_VERDICT: "APPROVE" },
            logStream,
          });
        },
        fixerAgentFactory: (logStream) =>
          new AgentProcess({
            command: FAKE_FIXER,
            model: "fake-haiku",
            timeoutMs: 5000,
            cwd: root,
            env: { FAKE_FIXER_TOUCH: resolve(root, "subject.ts") },
            logStream,
          }),
      });
      expect(code).toBe(0);
      // Reviewer was called twice — same round, rate-limited then APPROVE.
      expect(readFileSync(callsFile, "utf8")).toBe("2");
    });
  });

  describe("subloop disabled", () => {
    beforeEach(() => {
      const s = setupSandbox({ reviewMaxRounds: 5, reviewEnabled: false });
      cfg = s.cfg;
      root = s.root;
    });

    test("--no-review path: reviewer never spawned, loop returns 0", async () => {
      let reviewerCalled = false;
      const code = await runLoop(cfg, {
        agentFactory: makeMainAgentFactory(root),
        runTests: async () => ({ ok: true, durationMs: 5, summary: "stub", output: "" }),
        reviewerAgentFactory: () => {
          reviewerCalled = true;
          throw new Error("must not be called");
        },
      });
      expect(code).toBe(0);
      expect(reviewerCalled).toBe(false);
      // No review commit was created.
      const log = execaSync("git", ["log", "--oneline"], { cwd: root });
      expect(log.stdout).not.toContain("review(77");
    });
  });
});
