/**
 * Reviewer → Fixer review sub-loop.
 *
 * Runs after each successful `task(NN): …` commit. Iterates until
 *   `verdict === APPROVE && tests pass`
 * or rounds are exhausted (in which case the main loop halts).
 *
 * Per-round trace lives at:
 *   ralph/logs/task-NN-review-K-reviewer-<ts>.log   (contains the report)
 *   ralph/logs/task-NN-review-K-fixer-<ts>.log
 *
 * Per-round commit (only if the fixer touched anything):
 *   review(NN, round K): <"apply review feedback" | "WIP review fix (tests failing)">
 */

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AgentProcess } from "../AgentProcess.js";
import type { Config } from "../Config.js";
import { commitReviewRound, hasChanges } from "../GitOps.js";
import { humanDuration, type Logger } from "../Logger.js";
import { computeSleepUntil, sleepUntil } from "../RateLimit.js";
import { addUsage, type AgentResult, type TaskRef, type TestRunResult } from "../types.js";
import { runFixer, type RunFixerOptions } from "./Fixer.js";
import { countItems, parseVerdict } from "./parseReport.js";
import { runReviewer, type RunReviewerOptions } from "./Reviewer.js";
import { emptySubloopUsage, type ReviewVerdict, type SubloopOutcome, type SubloopUsage } from "./types.js";

/**
 * @deprecated The sub-loop no longer throws this. It returns
 * `SubloopOutcome` with `kind: "diverged"` so the outer loop can recover
 * (reset HEAD, revert task, retry). Kept exported for callers that still
 * `instanceof`-check it; safe to delete once nothing references it.
 */
export class ReviewSubloopExceededError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: string,
  ) {
    super(`review sub-loop halted for task #${taskId}: ${reason}`);
    this.name = "ReviewSubloopExceededError";
  }
}

export interface SubloopCtx {
  cfg: Config;
  task: TaskRef;
  log: Logger;
  /**
   * SHA of the task commit at the start of the sub-loop. Pinning it gives the
   * reviewer a stable scope across rounds: round 1 sees the same diff as
   * round K, instead of comparing against the previous fix-commit (HEAD~1).
   * Null when HEAD couldn't be resolved — the reviewer falls back to HEAD.
   */
  originalSha: string | null;
  /**
   * Forwarded from the main loop so the rate-limit `sleepUntil` calls inside
   * the sub-loop also wake up on SIGINT instead of blocking the operator's
   * Ctrl-C. Optional for backwards compatibility with tests that drive the
   * sub-loop directly.
   */
  abortSignal?: AbortSignal;
  /** Run tests and report the outcome (passed in by the main loop). */
  runTests: () => Promise<TestRunResult>;
  registerAgent: (a: AgentProcess) => void;
  clearAgent: () => void;
  /** Test-only override for the reviewer's `AgentProcess`. */
  reviewerAgentFactory?: RunReviewerOptions["agentFactory"];
  /** Test-only override for the fixer's `AgentProcess`. */
  fixerAgentFactory?: RunFixerOptions["agentFactory"];
  /** Test-only override of the timestamp used in log filenames. */
  timestamp?: () => string;
  /**
   * Alternate reviewer prompt (absolute path). The integration review passes
   * `prompts/integration-review.md`; normal runs leave it unset.
   */
  reviewerPromptFile?: string;
  /** Extra context appended to reviewer + fixer prompts (e.g. the design spec). */
  extraContext?: string;
}

export async function runReviewSubloop(ctx: SubloopCtx): Promise<SubloopOutcome> {
  const { cfg, task, log } = ctx;
  const ts = ctx.timestamp ?? defaultTimestamp;

  let consecutiveNoOpRounds = 0;
  let consecutiveReviewerFailures = 0;
  const lastDiffHashes: string[] = [];
  // Most recent test outcome — used to populate the `testsOkAtEnd` field of
  // the diverged outcome so the outer loop knows whether it can keep the
  // partial review chain or has to reset to the original SHA.
  let lastTests: TestRunResult | null = null;
  // Token / cost / time totals accumulated across every reviewer + fixer
  // call in this sub-loop. Surfaced on every SubloopOutcome variant so the
  // outer loop's metrics writer can record the full sub-loop spend without
  // recomputing anything.
  const usage: SubloopUsage = emptySubloopUsage();

  const accumulate = (which: "reviewer" | "fixer", r: AgentResult): void => {
    if (which === "reviewer") {
      usage.reviewerUsage = addUsage(usage.reviewerUsage, r.usage);
      usage.reviewerCostUsd += r.costUsd ?? 0;
      usage.reviewerDurationMs += r.durationMs;
      usage.reviewerApiDurationMs += r.apiDurationMs ?? 0;
    } else {
      usage.fixerUsage = addUsage(usage.fixerUsage, r.usage);
      usage.fixerCostUsd += r.costUsd ?? 0;
      usage.fixerDurationMs += r.durationMs;
      usage.fixerApiDurationMs += r.apiDurationMs ?? 0;
    }
  };

  const diverge = (reason: string, rounds: number): SubloopOutcome => {
    log.warn(`review sub-loop diverged for task #${task.id}: ${reason}`);
    return {
      kind: "diverged",
      reason,
      rounds,
      testsOkAtEnd: lastTests?.ok ?? false,
      usage,
    };
  };

  for (let round = 1; round <= cfg.reviewMaxRounds; round++) {
    log.stage("review.start", `round ${round}/${cfg.reviewMaxRounds}`);

    // 1. Tests up-front. Convergence requires tests.ok.
    const tests = await ctx.runTests();
    lastTests = tests;

    // 2. Reviewer (Opus). Stdout is the report. Bounded RL retries within
    //    this round so a permanently-rate-limited reviewer cannot decrement
    //    `round` forever.
    const reviewerOutcome = await runReviewerWithRlBudget(ctx, round, tests.ok, ts);
    if (reviewerOutcome.kind === "rl-exhausted") {
      return diverge(
        `reviewer rate-limited ${reviewerOutcome.tries} times in round ${round}`,
        round,
      );
    }
    const { result: reviewerResult, report } = reviewerOutcome;
    accumulate("reviewer", reviewerResult);
    logUsageLine(log, "reviewer", reviewerResult);

    // Reviewer crash / unparseable verdict / empty report → reviewer-failed.
    // Two such failures in a row halt the sub-loop instead of feeding the
    // fixer a garbage report.
    const reviewerFailed =
      reviewerResult.timedOut ||
      reviewerResult.exitCode !== 0 ||
      report.trim().length < 50 ||
      parseVerdict(report) === "UNKNOWN";
    if (reviewerFailed) {
      consecutiveReviewerFailures++;
      log.warn(
        `reviewer failed (code=${reviewerResult.exitCode} timedOut=${reviewerResult.timedOut} ` +
          `bytes=${report.length} verdict=${parseVerdict(report)}) — ` +
          `streak=${consecutiveReviewerFailures}/${cfg.reviewMaxReviewerFailures}`,
      );
      if (consecutiveReviewerFailures >= cfg.reviewMaxReviewerFailures) {
        return diverge(
          `reviewer produced no usable report ${consecutiveReviewerFailures} rounds in a row`,
          round,
        );
      }
      continue;
    }
    consecutiveReviewerFailures = 0;

    const verdict = parseVerdict(report);
    const counts = countItems(report);
    const verdictTag: ReviewVerdict = verdict === "UNKNOWN" ? "NEEDS_CHANGES" : verdict;
    log.stage(
      "review.verdict",
      `${verdictTag} (${counts.blockers} blockers, ${counts.tests} tests, tests=${tests.ok ? "ok" : "fail"})`,
    );

    // 3. Convergence check.
    if (verdictTag === "APPROVE" && tests.ok) {
      log.stage("review.converged", `after ${round - 1} fix round(s)`);
      logSubloopTotal(log, usage);
      return { kind: "converged", rounds: round, usage };
    }

    // 4. Fixer (Sonnet) with the report. Even on APPROVE we still invoke the
    //    fixer when tests are failing — its prompt explicitly mandates fixing
    //    test/typecheck failures whether or not the reviewer flagged them.
    const fixerOutcome = await runFixerWithRlBudget(
      ctx,
      round,
      report,
      tests.ok,
      tests.output,
      ts,
    );
    if (fixerOutcome.kind === "rl-exhausted") {
      return diverge(
        `fixer rate-limited ${fixerOutcome.tries} times in round ${round}`,
        round,
      );
    }
    const { result: fixerResult } = fixerOutcome;
    accumulate("fixer", fixerResult);
    logUsageLine(log, "fixer", fixerResult);
    if (fixerResult.timedOut || fixerResult.exitCode !== 0) {
      log.warn(
        `fixer failed (code=${fixerResult.exitCode}) — next round's reviewer will see the broken state`,
      );
      // Intentionally fall through: commit any partial changes, then retry.
    }

    // 5. Re-run tests, commit any changes, and check for stuck/no-op patterns.
    const dirty = await hasChanges({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });
    if (!dirty) {
      consecutiveNoOpRounds++;
      log.warn(
        `fixer made no changes (no-op streak ${consecutiveNoOpRounds}/${cfg.reviewMaxNoOpRounds})`,
      );
      if (consecutiveNoOpRounds >= cfg.reviewMaxNoOpRounds) {
        return diverge(
          `fixer produced no diff ${consecutiveNoOpRounds} rounds in a row`,
          round,
        );
      }
      continue;
    }
    consecutiveNoOpRounds = 0;

    // Hash of the staged diff so we can detect "fixer applied the same change
    // twice" — a sneaky form of non-progress that otherwise burns the round
    // budget without any forward motion.
    const diffHash = await currentDiffHash(cfg);
    lastDiffHashes.push(diffHash);
    if (lastDiffHashes.length > cfg.reviewMaxRepeatDiffRounds) lastDiffHashes.shift();
    if (
      lastDiffHashes.length === cfg.reviewMaxRepeatDiffRounds &&
      lastDiffHashes.every((h) => h === lastDiffHashes[0])
    ) {
      return diverge(
        `fixer produced the same diff ${lastDiffHashes.length} rounds in a row`,
        round,
      );
    }

    const postTests = await ctx.runTests();
    lastTests = postTests;
    const status = postTests.ok ? "apply review feedback" : "WIP review fix (tests failing)";
    const c = await commitReviewRound(
      { cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs },
      task.id,
      round,
      status,
      cfg.commitReviewPrefix,
    );
    if (c.ok) {
      log.stage("git.commit", `${cfg.commitReviewPrefix}(${task.id}, round ${round}): ${status}`);
    } else {
      log.warn(`commit failed (exit ${c.exitCode}) — leaving working tree dirty`);
    }
  }

  logSubloopTotal(log, usage);
  return diverge(
    `review sub-loop did not converge after ${cfg.reviewMaxRounds} rounds`,
    cfg.reviewMaxRounds,
  );
}

/**
 * One-line per-call usage trace. Lives on the operator's terminal so they
 * can see at a glance "round 2 reviewer cost $0.12, fixer cost $0.04" without
 * grepping `metrics.jsonl`. Skipped entirely when claude ran in plain-text
 * mode (fake-claude in tests): no usage data → no line.
 */
function logUsageLine(log: Logger, kind: "reviewer" | "fixer", r: AgentResult): void {
  if (!r.usage && r.costUsd == null) return;
  const u = r.usage;
  const wall = humanDuration(r.durationMs);
  const api = r.apiDurationMs != null ? humanDuration(r.apiDurationMs) : "?";
  const cost = r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "$?";
  const tokens = u
    ? `in=${u.inputTokens} out=${u.outputTokens} cache-r=${u.cacheReadInputTokens} cache-c=${u.cacheCreationInputTokens}`
    : "n/a";
  log.detail(`${kind} usage`, `${tokens} cost=${cost} wall=${wall} api=${api}`);
}

/**
 * Sub-loop close-out line: cumulative reviewer + fixer spend. Emitted right
 * before `runReviewSubloop` returns so it always pairs with the per-round
 * usage lines. Caller can decide whether to also emit the same totals on the
 * iteration's final summary line — they're already part of `SubloopOutcome`.
 */
function logSubloopTotal(log: Logger, u: SubloopUsage): void {
  const totalCost = u.reviewerCostUsd + u.fixerCostUsd;
  const totalWall = u.reviewerDurationMs + u.fixerDurationMs;
  if (totalCost === 0 && totalWall === 0) return;
  log.detail(
    "review total",
    `cost=$${totalCost.toFixed(4)} ` +
      `(reviewer $${u.reviewerCostUsd.toFixed(4)} / fixer $${u.fixerCostUsd.toFixed(4)}) ` +
      `wall=${humanDuration(totalWall)}`,
  );
}

interface ReviewerSuccess {
  kind: "ok";
  result: Awaited<ReturnType<typeof runReviewer>>["result"];
  report: string;
}
interface FixerSuccess {
  kind: "ok";
  result: Awaited<ReturnType<typeof runFixer>>["result"];
}
interface RlExhausted {
  kind: "rl-exhausted";
  tries: number;
}

async function runReviewerWithRlBudget(
  ctx: SubloopCtx,
  round: number,
  testsOk: boolean,
  ts: () => string,
): Promise<ReviewerSuccess | RlExhausted> {
  const { cfg, task, log } = ctx;
  // Rate-limit retries are no longer a round-burning resource — we wait out
  // the API window and try again, letting the exponential fallback curve in
  // `computeSleepUntil` lengthen the sleep on consecutive hits. The cap below
  // is only a safety stop so we don't hang forever if the agent is
  // permanently rate-limited.
  for (let tries = 1; tries <= cfg.reviewRlMaxConsecutiveHits; tries++) {
    const reviewerLog = resolve(
      cfg.logsDir,
      `task-${task.id}-review-${round}-reviewer-${ts()}.log`,
    );
    log.stage(
      "reviewer.spawn",
      `model=${cfg.reviewerModel} timeout=${humanDuration(cfg.reviewerTimeoutMs)}`,
    );
    const { result, report } = await runReviewer({
      cfg,
      task,
      round,
      testsOk,
      originalSha: ctx.originalSha,
      logFile: reviewerLog,
      log,
      registerAgent: ctx.registerAgent,
      clearAgent: ctx.clearAgent,
      agentFactory: ctx.reviewerAgentFactory,
      promptFile: ctx.reviewerPromptFile,
      extraContext: ctx.extraContext,
    });
    log.stage(
      "reviewer.exit",
      `code=${result.exitCode ?? "null"} timedOut=${result.timedOut} ` +
        `duration=${humanDuration(result.durationMs)}`,
    );
    if (!result.rateLimit) return { kind: "ok", result, report };
    log.warn(`reviewer rate-limited (try ${tries}/${cfg.reviewRlMaxConsecutiveHits})`);
    await handleRateLimit(cfg, result.rateLimit, log, ctx.abortSignal, tries);
  }
  return { kind: "rl-exhausted", tries: cfg.reviewRlMaxConsecutiveHits };
}

async function runFixerWithRlBudget(
  ctx: SubloopCtx,
  round: number,
  report: string,
  testsOk: boolean,
  testOutput: string,
  ts: () => string,
): Promise<FixerSuccess | RlExhausted> {
  const { cfg, task, log } = ctx;
  for (let tries = 1; tries <= cfg.reviewRlMaxConsecutiveHits; tries++) {
    const fixerLog = resolve(
      cfg.logsDir,
      `task-${task.id}-review-${round}-fixer-${ts()}.log`,
    );
    log.stage(
      "fixer.spawn",
      `model=${cfg.fixerModel} timeout=${humanDuration(cfg.fixerTimeoutMs)}`,
    );
    const { result } = await runFixer({
      cfg,
      task,
      round,
      report,
      testsOk,
      testOutput,
      logFile: fixerLog,
      log,
      registerAgent: ctx.registerAgent,
      clearAgent: ctx.clearAgent,
      agentFactory: ctx.fixerAgentFactory,
      extraContext: ctx.extraContext,
    });
    log.stage(
      "fixer.exit",
      `code=${result.exitCode ?? "null"} timedOut=${result.timedOut} ` +
        `duration=${humanDuration(result.durationMs)}`,
    );
    if (!result.rateLimit) return { kind: "ok", result };
    log.warn(`fixer rate-limited (try ${tries}/${cfg.reviewRlMaxConsecutiveHits})`);
    await handleRateLimit(cfg, result.rateLimit, log, ctx.abortSignal, tries);
  }
  return { kind: "rl-exhausted", tries: cfg.reviewRlMaxConsecutiveHits };
}

async function currentDiffHash(cfg: Config): Promise<string> {
  const { execa } = await import("execa");
  const r = await execa(
    "git",
    ["-c", "commit.gpgsign=false", "diff", "--no-color", "HEAD", "--"],
    {
      cwd: cfg.repoRoot,
      timeout: cfg.gitTimeoutMs,
      reject: false,
      stdin: "ignore",
    },
  );
  const text = typeof r.stdout === "string" ? r.stdout : String(r.stdout ?? "");
  return createHash("sha256").update(text).digest("hex");
}

async function handleRateLimit(
  cfg: Config,
  info: { until: Date | null; reason: string },
  log: Logger,
  abortSignal?: AbortSignal,
  consecutiveHits: number = 1,
): Promise<void> {
  const sleep = computeSleepUntil(
    info,
    cfg.rateLimitFallbackMs,
    cfg.rateLimitJitterMs,
    () => new Date(),
    cfg.minRateLimitSleepMs,
    consecutiveHits,
    cfg.rateLimitFallbackCapMs,
  );
  log.rateLimit(info.until, info.reason, sleep.sleepMs);
  await sleepUntil(sleep.target, abortSignal);
}

function defaultTimestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  const ms = pad(d.getMilliseconds(), 3);
  const rand = Math.floor(Math.random() * 0x1000)
    .toString(16)
    .padStart(3, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${ms}-${rand}`
  );
}
