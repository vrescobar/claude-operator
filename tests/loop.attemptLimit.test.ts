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
  const ralphDir = resolve(root, "ralph");
  mkdirSync(ralphDir);
  mkdirSync(resolve(ralphDir, "logs"), { recursive: true });

  writeFileSync(
    resolve(ralphDir, "tasks.md"),
    [
      "## Phase X",
      "- [ ] **77** Always-fails task",
      "- [ ] **78** Reachable after #77 is blocked",
      "",
    ].join("\n"),
  );
  writeFileSync(resolve(ralphDir, "progress.md"), "# notes\n");
  writeFileSync(resolve(ralphDir, "prompt.md"), "you are a test agent.\n");
  writeFileSync(resolve(root, "package.json"), JSON.stringify({ name: "smoke" }));

  execaSync("git", ["init", "-q"], { cwd: root });
  execaSync("git", ["config", "user.email", "smoke@test.local"], { cwd: root });
  execaSync("git", ["config", "user.name", "Smoke"], { cwd: root });
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
    maxIterations: 10,
    stopMarker: "TASK_COMPLETE",
    claudeBin: FAKE_CLAUDE,
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

describe("ralph loop — attempt limit", () => {
  let cfg: Config;
  let root: string;

  beforeEach(() => {
    const s = setup();
    cfg = s.cfg;
    root = s.root;
  });

  test("a task that always fails gets blocked after taskAttemptLimit attempts", async () => {
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

    // Loop ran out of iterations after handling task 77 + reaching 78.
    expect([0, 1]).toContain(code);

    // Both tasks always fail, so each is attempted up to taskAttemptLimit (3)
    // times before being blocked. Total agent spawns must not exceed 2 ×
    // taskAttemptLimit; the iteration cap (10) is a safety net we should not hit.
    expect(agentCalls).toBeLessThanOrEqual(2 * cfg.taskAttemptLimit);
    expect(agentCalls).toBeGreaterThan(cfg.taskAttemptLimit);

    // Task 77 must be marked [!] in tasks.md and isTaskBlocked must agree.
    const after = readFileSync(resolve(root, "ralph/tasks.md"), "utf8");
    expect(after).toContain("- [!] **77** Always-fails task");

    // Progress note must record the block.
    const progress = readFileSync(resolve(root, "ralph/progress.md"), "utf8");
    expect(progress).toContain("task #77 blocked");

    // Persistent state should reflect attempts >= limit and blocked=true.
    const state = JSON.parse(readFileSync(resolve(root, "ralph/.state.json"), "utf8"));
    expect(state.tasks["77"].attempts).toBeGreaterThanOrEqual(cfg.taskAttemptLimit);
    expect(state.tasks["77"].blocked).toBe(true);
    expect(state.counters.blocked).toBeGreaterThanOrEqual(1);
  });
});
