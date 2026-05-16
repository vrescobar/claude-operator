/**
 * Ralph iteration loop.
 *
 * Replaces the body of `loop.sh`. Pure orchestration over the small focused
 * helper modules in this directory. Every state transition surfaces as a
 * `Logger.stage(...)` line so the operator can follow what's happening
 * without grepping the per-iteration log file.
 */

import { execa } from "execa";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { AgentProcess } from "./AgentProcess.js";
import { buildInvocation, previewInvocation } from "./AgentBackend.js";
import type { Config } from "./Config.js";
import {
  cleanupFailedAttempt,
  commitTask,
  currentHeadSha,
  detectInProgressOperation,
  ensureIdentity,
  ensureRepo,
  hasChanges,
  resetToSha,
} from "./GitOps.js";
import { humanDuration, Logger } from "./Logger.js";
import { Lockfile, LockfileBusyError } from "./Lockfile.js";
import { archiveClosedPhases } from "./PhaseArchive.js";
import { hasTaskComplete, rotateProgressIfTooLarge } from "./ProgressFile.js";
import { loadIterationPrompt } from "./promptTemplate.js";
import { computeSleepUntil, sleepUntil } from "./RateLimit.js";
import { runReviewSubloop } from "./review/subloop.js";
import type { RunFixerOptions } from "./review/Fixer.js";
import type { RunReviewerOptions } from "./review/Reviewer.js";
import { getTaskState, loadState, saveState, type AggregateCounters, type LoopState } from "./State.js";
import {
  countOpenTasks,
  findNextOpenTask,
  isTaskMarkedDone,
  markTaskBlocked,
  revertTaskToPending,
} from "./TaskFile.js";
import { formatLocal as formatLocalTs } from "./time.js";
import { addUsage, emptyUsage, type AgentResult, type AgentUsage, type IterationOutcome, type TaskRef, type TestRunResult } from "./types.js";
import { emptySubloopUsage, type SubloopUsage } from "./review/types.js";

export interface LoopHooks {
  /** Skip claude / tests / commits and return the iteration plan instead. */
  dryRun?: boolean;
  /** Override the agent factory (used by tests with a fake-claude shim). */
  agentFactory?: (
    cfg: Config,
    logFile: string,
    onLine: (s: "stdout" | "stderr", l: string) => void,
  ) => AgentProcess;
  /** Override the test runner (used by tests). */
  runTests?: (cfg: Config, log: Logger) => Promise<TestRunResult>;
  /** Override the reviewer's `AgentProcess` (used by tests). */
  reviewerAgentFactory?: RunReviewerOptions["agentFactory"];
  /** Override the fixer's `AgentProcess` (used by tests). */
  fixerAgentFactory?: RunFixerOptions["agentFactory"];
}

export async function runLoop(cfg: Config, hooks: LoopHooks = {}): Promise<number> {
  // Pre-flight ──────────────────────────────────────────────────────────────
  for (const f of [cfg.tasksFile, cfg.progressFile]) {
    if (!existsSync(f)) {
      process.stderr.write(`ralph: required file missing: ${f}\n`);
      return 1;
    }
  }
  // promptFile is optional — if absent, we fall back to the bundled
  // `prompts/iteration.md` shipped with the submodule.
  // tasks.md and progress.md must be writable — the loop revert/append
  // bookkeeping fails opaquely with EACCES otherwise (e.g., when ralph runs
  // under a different UID than the operator who created the files).
  for (const f of [cfg.tasksFile, cfg.progressFile]) {
    try {
      accessSync(f, fsConstants.W_OK);
    } catch {
      process.stderr.write(`ralph: required file not writable: ${f}\n`);
      return 1;
    }
  }
  mkdirSync(cfg.logsDir, { recursive: true });
  // Sentinel write to prove the logs directory is writable. We don't keep the
  // file — only a true write goes through to disk.
  try {
    const sentinel = resolve(cfg.logsDir, ".ralph-write-check");
    appendFileSync(sentinel, "");
    unlinkSync(sentinel);
  } catch (err) {
    process.stderr.write(
      `ralph: logs dir not writable (${cfg.logsDir}): ${(err as Error).message}\n`,
    );
    return 1;
  }

  pruneOldLogs(cfg.logsDir, cfg.logRetentionDays);
  const archived = rotateProgressIfTooLarge(
    cfg.progressFile,
    cfg.progressMaxBytes,
    cfg.progressTailKeepBytes,
    () => new Date(),
    cfg.archiveDir,
  );
  if (archived) {
    process.stdout.write(`ralph: progress.md rotated → ${archived}\n`);
  }
  if (cfg.autoArchiveClosedPhases) {
    const phaseArchive = archiveClosedPhases({
      tasksFile: cfg.tasksFile,
      archiveDir: cfg.archiveDir,
    });
    if (phaseArchive.archivedCount > 0) {
      process.stdout.write(
        `ralph: archived ${phaseArchive.archivedCount} closed phase(s) → ` +
          `${phaseArchive.archivePath}\n`,
      );
      for (const h of phaseArchive.archivedHeadings) {
        process.stdout.write(`         · ${h}\n`);
      }
    }
  }

  await ensureRepo({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });
  await ensureIdentity({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });

  const inProgress = await detectInProgressOperation({
    cwd: cfg.repoRoot,
    timeoutMs: cfg.gitTimeoutMs,
  });
  if (inProgress) {
    process.stderr.write(
      `ralph: repository has an in-progress operation (${inProgress}). ` +
        `Resolve or abort it before running ralph.\n`,
    );
    return 1;
  }

  const log = new Logger({ verbose: cfg.verbose });
  log.info(`ralph starting (model=${cfg.claudeModel}, max=${cfg.maxIterations})`);
  if (cfg.dryRun) log.warn("dry-run mode: no claude / tests / commits");

  let lock: Lockfile;
  try {
    lock = Lockfile.acquire(cfg.lockFile);
  } catch (err) {
    if (err instanceof LockfileBusyError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }

  let activeAgent: AgentProcess | null = null;
  const abortCtl = new AbortController();
  let shuttingDown = false;
  const sigintHandler = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn("SIGINT received — shutting down agent and releasing lock");
    // Aborts any in-flight rate-limit sleep so we don't have to wait an hour
    // for the loop to wake up before exiting.
    abortCtl.abort(new Error("ralph: shutting down"));
    const agent = activeAgent;
    if (agent) {
      try {
        await agent.kill("SIGTERM");
        // Wait up to killGrace + 5s for the child to actually exit before we
        // tear our own process down. AgentProcess uses execa's
        // forceKillAfterDelay (default 30s) so SIGKILL is automatic if
        // SIGTERM is ignored.
        const grace = 35_000;
        await Promise.race([
          agent.exited(),
          new Promise<void>((resolve) => setTimeout(resolve, grace)),
        ]);
      } catch {
        // Best effort — never throw out of a signal handler.
      }
    }
    lock.release();
    process.exit(130);
  };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigintHandler);

  const state = loadState(cfg.stateFile);
  // Snapshot lifetime counters at start so the run-summary can show both the
  // per-run diff and the durable totals. Lives in memory only.
  const startedCounters: AggregateCounters = { ...state.counters };
  const persist = (): void => saveState(cfg.stateFile, state);

  // Cost / token usage accumulated by THIS run. Lifetime totals live durably
  // in `state` (totalCostUsd / totalUsage); these track just the current run
  // for the per-iteration "run total" line and the final summary.
  let runCostUsd = 0;
  let runUsage: AgentUsage = emptyUsage();

  // Final terminal state — captured so the summary printer in the `finally`
  // block knows which message to render and whether to return 0 vs 1.
  let runResult: RunResult = "cap";

  // In-memory list of every iteration outcome this run produced. Used by
  // `exitCodeForResult` to decide whether a cap-reached exit is clean
  // ("we just ran out of budget") or dirty ("the agent kept failing").
  const runOutcomes: IterationOutcome[] = [];

  // Consecutive rate-limit hits for the *current* task. Resets when the
  // task id changes or any non-rate-limited outcome occurs. Used by the
  // exponential fallback in `computeSleepUntil` so a sustained 429 doesn't
  // pin the loop at a flat 5 min retry.
  let rlStreakTaskId: string | null = null;
  let rlStreak = 0;

  try {
    for (let iter = 1; iter <= cfg.maxIterations; iter++) {
      log.iterationHeader(iter, cfg.maxIterations);
      state.counters.iterations++;

      if (hasTaskComplete(cfg.progressFile, cfg.stopMarker)) {
        log.info(`stop marker '${cfg.stopMarker}' present — halting`);
        persist();
        runResult = "complete-marker";
        return 0;
      }

      const task = findNextOpenTask(cfg.tasksFile);
      if (!task) {
        log.info("no [ ] tasks remaining — done");
        persist();
        runResult = "complete-empty";
        return 0;
      }

      // Reset the RL streak when we move to a different task — the
      // exponential backoff is per-task, not per-loop.
      if (rlStreakTaskId !== task.id) {
        rlStreakTaskId = task.id;
        rlStreak = 0;
      }

      const taskState = getTaskState(state, task.id);

      if (taskState.attempts >= cfg.taskAttemptLimit) {
        const lastDisplay = taskState.lastAttemptAt
          ? formatLocalTs(new Date(taskState.lastAttemptAt))
          : "unknown";
        const reason =
          `attempt limit ${cfg.taskAttemptLimit} reached — moving on. ` +
          `Latest attempt at ${lastDisplay}.`;
        log.error(`task #${task.id} blocked — ${reason}`);
        markTaskBlocked(cfg.tasksFile, task.id);
        appendProgressNote(
          cfg.progressFile,
          `- task #${task.id} blocked: ${reason}`,
        );
        taskState.blocked = true;
        state.counters.blocked++;
        persist();
        continue;
      }

      const attempt = taskState.attempts + 1;
      const logFile = openIterationLogFilePath(cfg.logsDir, task.id, attempt);

      const remainingOpen = safeCountOpenTasks(cfg.tasksFile);
      const remainingNote = remainingOpen >= 1 ? `  (${remainingOpen} pending)` : "";
      log.detail("task", `#${task.id} — ${task.title}${remainingNote}`);
      log.detail("attempt", `#${attempt}`);
      log.detail("model", cfg.claudeModel);
      log.detail("log", relativePath(cfg.repoRoot, logFile));
      log.detail(
        "cmd",
        `[${cfg.agentBackend}] ` +
          previewInvocation(cfg.agentBackend, {
            roleBin: cfg.claudeBin,
            claudePBin: cfg.claudePBin,
            model: cfg.claudeModel,
          }),
      );

      if (hooks.dryRun || cfg.dryRun) {
        log.info("dry-run: skipping spawn / tests / commit");
        return 0;
      }

      taskState.attempts = attempt;
      taskState.lastAttemptAt = new Date().toISOString();
      persist();
      const iterStartedAt = Date.now();

      // Next consecutive RL hit number for THIS iteration's agent call —
      // 1 on first hit for the task, 2 on the second, etc. Used inside
      // `runIteration` to grow the no-reset-time fallback.
      const nextRlHitNumber = rlStreak + 1;

      const iterResult = await runIteration({
        cfg,
        task,
        attempt,
        logFile,
        log,
        hooks,
        state,
        persist,
        abortSignal: abortCtl.signal,
        registerAgent: (a) => {
          activeAgent = a;
        },
        clearAgent: () => {
          activeAgent = null;
        },
        rlHitNumber: nextRlHitNumber,
      });
      const outcome = iterResult.outcome;

      // Maintain the streak: only "rate-limited" extends it, everything
      // else resets to zero (including a clean iteration).
      if (outcome === "rate-limited") rlStreak++;
      else rlStreak = 0;

      runOutcomes.push(outcome);
      persist();
      const iterDurationMs = Date.now() - iterStartedAt;
      // Pre-compute roll-up totals so they're cheap to read straight from
      // the JSONL (no client-side summation across reviewer/fixer/agent).
      const totalUsage: AgentUsage = addUsage(
        addUsage(iterResult.agent.usage, iterResult.subloop.reviewerUsage),
        iterResult.subloop.fixerUsage,
      );
      const totalCostUsd =
        iterResult.agent.costUsd +
        iterResult.subloop.reviewerCostUsd +
        iterResult.subloop.fixerCostUsd;
      runCostUsd += totalCostUsd;
      runUsage = addUsage(runUsage, totalUsage);
      state.totalCostUsd += totalCostUsd;
      state.totalUsage = addUsage(state.totalUsage, totalUsage);

      const costEstimated = iterResult.agent.costEstimated;
      appendMetric(cfg.metricsFile, {
        iteration: iter,
        taskId: task.id,
        attempt,
        outcome,
        durationMs: iterDurationMs,
        finishedAt: new Date().toISOString(),
        agent: iterResult.agent,
        review: iterResult.subloop,
        totalCostUsd,
        totalUsage,
        costEstimated,
        cumulativeCostUsd: state.totalCostUsd,
        cumulativeUsage: state.totalUsage,
      });
      // End-of-iteration human summary on the operator's terminal. `≈$`
      // flags a token-derived estimate (claude-p) vs a claude-reported cost.
      const c$ = costEstimated ? "≈$" : "$";
      log.info(
        `iter ${iter} done — outcome=${outcome} ` +
          `wall=${humanDuration(iterDurationMs)} ` +
          `cost=${c$}${totalCostUsd.toFixed(4)} ` +
          `(agent ${c$}${iterResult.agent.costUsd.toFixed(4)}, ` +
          `review ${c$}${(iterResult.subloop.reviewerCostUsd + iterResult.subloop.fixerCostUsd).toFixed(4)}) ` +
          `tokens=${formatUsageInline(totalUsage)}`,
      );
      log.info(
        `run total — cost=${c$}${runCostUsd.toFixed(4)} ` +
          `tokens=${formatUsageInline(runUsage)}` +
          (costEstimated ? "  (cost estimated from tokens — claude-p backend)" : ""),
      );

      if (outcome === "stop-marker") {
        runResult = "complete-marker";
        return 0;
      }
      if (outcome === "no-tasks") {
        runResult = "complete-empty";
        return 0;
      }
    }
    runResult = "cap";
    // Exit code is decided once we've seen the per-run diff below; deferred
    // to the `finally` printer so the message and the exit code can't drift.
    return exitCodeForResult(runResult, startedCounters, state.counters, runOutcomes);
  } finally {
    persist();
    printFinalStatus({
      log,
      cfg,
      runResult,
      started: startedCounters,
      ended: state.counters,
      outcomes: runOutcomes,
      runCostUsd,
      runUsage,
      lifetimeCostUsd: state.totalCostUsd,
      lifetimeUsage: state.totalUsage,
    });
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigintHandler);
    lock.release();
  }
}

/**
 * Terminal state for a ralph run:
 *  - `complete-marker`: agent wrote `TASK_COMPLETE` to progress.md.
 *  - `complete-empty`: no `[ ]` tasks left in tasks.md.
 *  - `cap`: iteration budget exhausted before either of the above.
 */
type RunResult = "complete-marker" | "complete-empty" | "cap";

/**
 * Iteration outcomes that mean the agent didn't make forward progress.
 * Rate-limit and the two "successful completion" outcomes are excluded —
 * rate-limit is recoverable (just wait), and successful completions don't
 * even reach the cap-reached branch.
 */
const DIRTY_OUTCOMES: ReadonlySet<IterationOutcome> = new Set([
  "agent-failed",
  "tests-failed",
  "no-changes-retry",
  "task-not-marked",
]);

function exitCodeForResult(
  result: RunResult,
  started: AggregateCounters,
  ended: AggregateCounters,
  outcomes: ReadonlyArray<IterationOutcome>,
): number {
  if (result !== "cap") return 0;
  const failedThisRun = ended.testFailures - started.testFailures;
  const blockedThisRun = ended.blocked - started.blocked;
  if (failedThisRun !== 0 || blockedThisRun !== 0) return 1;
  // Even if the durable counters didn't move, an agent-failed or
  // task-not-marked outcome means the iteration was wasted — that's still
  // a dirty cap-reached and should exit 1.
  if (outcomes.some((o) => DIRTY_OUTCOMES.has(o))) return 1;
  return 0;
}

interface IterationCtx {
  cfg: Config;
  task: TaskRef;
  attempt: number;
  logFile: string;
  log: Logger;
  hooks: LoopHooks;
  state: LoopState;
  persist: () => void;
  abortSignal: AbortSignal;
  registerAgent: (a: AgentProcess) => void;
  clearAgent: () => void;
  /**
   * Consecutive rate-limit hits for this task INCLUDING the current
   * iteration if it ends up rate-limited. Used to drive the exponential
   * fallback in `computeSleepUntil` when no reset epoch is surfaced. Always
   * >= 1.
   */
  rlHitNumber: number;
}

interface IterationResult {
  outcome: IterationOutcome;
  /** Token / cost / wall / api numbers from the main agent call. */
  agent: AgentMetrics;
  /** Sub-loop totals — zero-valued when the review sub-loop didn't run. */
  subloop: SubloopUsage;
}

interface AgentMetrics {
  usage: AgentUsage;
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
  numTurns: number | null;
  /** Where the usage figures came from — see `AgentResult.usageSource`. */
  usageSource: AgentResult["usageSource"];
  /** True when `costUsd` is a token-derived estimate (claude-p backend). */
  costEstimated: boolean;
}

function metricsFromAgent(r: AgentResult): AgentMetrics {
  return {
    usage: r.usage ?? emptyUsage(),
    costUsd: r.costUsd ?? 0,
    durationMs: r.durationMs,
    apiDurationMs: r.apiDurationMs ?? 0,
    numTurns: r.numTurns,
    usageSource: r.usageSource,
    costEstimated: r.costEstimated,
  };
}

async function runIteration(ctx: IterationCtx): Promise<IterationResult> {
  const { cfg, task, attempt, logFile, log, hooks } = ctx;
  const stream = createWriteStream(logFile, { flags: "a" });
  // Default-zero so every return path below produces a well-formed
  // IterationResult — even paths that never spawn the agent (rate-limit
  // abort) or that bail before the sub-loop runs.
  let agentMetrics: AgentMetrics = {
    usage: emptyUsage(),
    costUsd: 0,
    durationMs: 0,
    apiDurationMs: 0,
    numTurns: null,
    usageSource: null,
    costEstimated: false,
  };
  let subloop: SubloopUsage = emptySubloopUsage();
  const mk = (outcome: IterationOutcome): IterationResult => ({
    outcome,
    agent: agentMetrics,
    subloop,
  });
  try {
    const promptText = buildPrompt(cfg, task, attempt);

    log.stage("agent.spawn", `pid pending — timeout ${humanDuration(cfg.claudeTimeoutMs)}`);

    const factory =
      hooks.agentFactory ??
      ((c, _f, onLine) => {
        const inv = buildInvocation(c.agentBackend, {
          roleBin: c.claudeBin,
          claudePBin: c.claudePBin,
          repoRoot: c.repoRoot,
          timeoutMs: c.claudeTimeoutMs,
        });
        return new AgentProcess({
          command: inv.command,
          extraArgs: inv.extraArgs,
          promptViaStdin: inv.promptViaStdin,
          sessionId: inv.sessionId,
          recoverUsage: c.agentBackend === "claude-p",
          model: c.claudeModel,
          timeoutMs: c.claudeTimeoutMs,
          cwd: c.repoRoot,
          logStream: stream,
          onLine,
          maxBufferBytes: c.agentMaxBufferBytes,
        });
      });
    const agent = factory(cfg, logFile, log.streamAgentLine);
    ctx.registerAgent(agent);

    const result = await agent.run(promptText);
    ctx.clearAgent();
    agentMetrics = metricsFromAgent(result);

    log.stage(
      "agent.exit",
      `code=${result.exitCode ?? "null"} signal=${result.signal ?? "-"} ` +
        `timedOut=${result.timedOut} duration=${humanDuration(result.durationMs)}`,
    );
    logAgentUsage(log, result);

    if (result.rateLimit) {
      ctx.state.counters.rateLimitHits++;
      const sleep = computeSleepUntil(
        result.rateLimit,
        cfg.rateLimitFallbackMs,
        cfg.rateLimitJitterMs,
        () => new Date(),
        cfg.minRateLimitSleepMs,
        ctx.rlHitNumber,
        cfg.rateLimitFallbackCapMs,
      );
      log.rateLimit(result.rateLimit.until, result.rateLimit.reason, sleep.sleepMs);
      try {
        await sleepUntil(sleep.target, ctx.abortSignal);
      } catch (err) {
        // sleepUntil rejects with "aborted" when the parent shuts down via
        // SIGINT. Surface it as agent-failed so the iteration ends cleanly.
        const e = err as Error;
        log.warn(`rate-limit sleep aborted: ${e.message}`);
        return mk("agent-failed");
      }
      return mk("rate-limited");
    }

    if (result.timedOut) {
      log.warn(`claude hit ${humanDuration(cfg.claudeTimeoutMs)} timeout — retrying next iteration`);
      return mk("agent-failed");
    }
    if (result.exitCode !== 0) {
      log.warn(`claude exited ${result.exitCode} — retrying next iteration`);
      return mk("agent-failed");
    }

    if (hasTaskComplete(cfg.progressFile, cfg.stopMarker)) {
      log.info(`stop marker '${cfg.stopMarker}' written by agent — halting`);
      return mk("stop-marker");
    }

    if (!isTaskMarkedDone(cfg.tasksFile, task.id)) {
      log.warn(`task #${task.id} not marked [x] yet — retrying next iteration`);
      return mk("task-not-marked");
    }

    log.stage("tests.run");
    const runner = hooks.runTests ?? defaultRunTests;
    const tests = await runner(cfg, log);
    if (!tests.ok) {
      ctx.state.counters.testFailures++;
      log.warn(`tests failed (${humanDuration(tests.durationMs)}) — reverting #${task.id} → [ ]`);
      revertTaskToPending(cfg.tasksFile, task.id);
      await dropDirtyTree(ctx, "tests-failed");
      return mk("tests-failed");
    }
    log.stage("tests.ok", `${tests.summary} (${humanDuration(tests.durationMs)})`);

    const taskState = getTaskState(ctx.state, task.id);
    const dirty = await hasChanges({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });
    if (!dirty) {
      const tries = taskState.noChangeAttempts + 1;
      taskState.noChangeAttempts = tries;
      if (tries <= cfg.noChangeRetryLimit) {
        log.warn(
          `task #${task.id} marked [x] but no git changes ` +
            `(no-change retry ${tries}/${cfg.noChangeRetryLimit}) — reverting and retrying`,
        );
        revertTaskToPending(cfg.tasksFile, task.id);
        return mk("no-changes-retry");
      }
      log.info(`task #${task.id} accepted as a no-op after ${tries} attempts`);
      return mk("no-changes-accepted");
    }
    taskState.noChangeAttempts = 0;

    log.stage("git.commit");
    const c = await commitTask(
      { cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs },
      task.id,
      task.title,
      cfg.commitTaskPrefix,
    );
    if (!c.ok) {
      log.warn(`commit failed (exit ${c.exitCode}) — reverting #${task.id} → [ ]`);
      revertTaskToPending(cfg.tasksFile, task.id);
      await dropDirtyTree(ctx, "commit-failed");
      return mk("tests-failed");
    }
    ctx.state.counters.committed++;
    log.done(`committed ${cfg.commitTaskPrefix}(${task.id}): ${task.title}`);

    if (cfg.reviewEnabled) {
      const originalSha = await currentHeadSha({
        cwd: cfg.repoRoot,
        timeoutMs: cfg.gitTimeoutMs,
      });
      const subloopOutcome = await runReviewSubloop({
        cfg,
        task,
        log,
        originalSha,
        abortSignal: ctx.abortSignal,
        runTests: () => (hooks.runTests ?? defaultRunTests)(cfg, log),
        registerAgent: ctx.registerAgent,
        clearAgent: ctx.clearAgent,
        reviewerAgentFactory: hooks.reviewerAgentFactory,
        fixerAgentFactory: hooks.fixerAgentFactory,
      });
      // Capture sub-loop usage onto the closure so `mk()` includes it in the
      // IterationResult regardless of which return path fires below.
      subloop = subloopOutcome.usage;

      if (subloopOutcome.kind === "diverged") {
        // The sub-loop gave up but we don't halt the main loop. Two recovery
        // paths, mirroring how the outer loop already handles tests-failed:
        //
        //  - If tests pass at HEAD now, the review just couldn't reach
        //    "APPROVE+ok" within budget. The task itself is sound — accept
        //    the partial review chain and move on.
        //  - If tests are still red, the review chain only added broken
        //    commits. Reset HEAD back to the task commit, revert the task
        //    to `[ ]` (so the main agent retries on the next iteration with
        //    full context), and surface this as a tests-failed outcome.
        //    The per-task attempt limit eventually escalates to `[!]`
        //    blocked, so we never spin forever.
        log.warn(
          `review sub-loop did not converge — ${subloopOutcome.reason} ` +
            `(rounds=${subloopOutcome.rounds}, tests=${subloopOutcome.testsOkAtEnd ? "ok" : "fail"})`,
        );

        if (subloopOutcome.testsOkAtEnd) {
          log.info(
            `tests pass at HEAD — accepting task #${task.id} commit chain without review polish`,
          );
          return mk("committed-review-skipped");
        }

        if (originalSha) {
          const r = await resetToSha(
            { cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs },
            originalSha,
          );
          if (r.ok) {
            log.stage("git.reset", `HEAD → ${originalSha.slice(0, 8)} (drop failed review chain)`);
          } else {
            log.warn(`git reset to ${originalSha.slice(0, 8)} failed: ${r.detail}`);
          }
        } else {
          log.warn("no originalSha captured — cannot reset; leaving HEAD as-is");
        }

        // Now reset *past* the task commit too, so the main agent's next
        // attempt rebuilds the task from scratch instead of duplicating it.
        const beforeTask = await execa(
          "git",
          [
            "-c",
            "commit.gpgsign=false",
            "rev-parse",
            "HEAD~1",
          ],
          {
            cwd: cfg.repoRoot,
            timeout: cfg.gitTimeoutMs,
            reject: false,
            stdin: "ignore",
          },
        );
        const parentSha =
          beforeTask.exitCode === 0
            ? (typeof beforeTask.stdout === "string" ? beforeTask.stdout : String(beforeTask.stdout ?? "")).trim()
            : "";
        if (parentSha.length === 40) {
          const r2 = await resetToSha(
            { cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs },
            parentSha,
          );
          if (r2.ok) {
            log.stage("git.reset", `HEAD → ${parentSha.slice(0, 8)} (drop task commit; will retry)`);
          } else {
            log.warn(`git reset to ${parentSha.slice(0, 8)} failed: ${r2.detail}`);
          }
        }

        ctx.state.counters.testFailures++;
        revertTaskToPending(cfg.tasksFile, task.id);
        await dropDirtyTree(ctx, "review-diverged");
        appendProgressNote(
          cfg.progressFile,
          `- task #${task.id} review sub-loop diverged: ${subloopOutcome.reason} — reset and queued for retry`,
        );
        return mk("tests-failed");
      }
    }
    return mk("committed");
  } finally {
    stream.end();
    ctx.clearAgent();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function timestamp(): string {
  // YYYYMMDD-HHMMSS-mmm-rand in local time. Adding milliseconds + a random
  // hex suffix prevents collision when two iterations (or the subloop and
  // main loop) generate filenames within the same second.
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

function openIterationLogFilePath(logsDir: string, taskId: string, attempt: number): string {
  return resolve(logsDir, `task-${taskId}-attempt-${attempt}-${timestamp()}.log`);
}

interface MetricLine {
  iteration: number;
  taskId: string;
  attempt: number;
  outcome: string;
  /** Wall-clock duration of the whole iteration (agent + tests + review). */
  durationMs: number;
  finishedAt: string;
  /** Main iteration agent metrics (zero-valued when the agent never spawned). */
  agent: AgentMetrics;
  /** Reviewer + fixer aggregate metrics across every sub-loop round. */
  review: SubloopUsage;
  /** Pre-computed roll-up so dashboards can `jq '.totalCostUsd' metrics.jsonl`. */
  totalCostUsd: number;
  /** Pre-computed roll-up of every model call in this iteration. */
  totalUsage: AgentUsage;
  /** True when `totalCostUsd` is a token-derived estimate (claude-p backend). */
  costEstimated: boolean;
  /** Lifetime cost across all runs, AFTER this iteration (USD). */
  cumulativeCostUsd: number;
  /** Lifetime token usage across all runs, AFTER this iteration. */
  cumulativeUsage: AgentUsage;
}

function appendMetric(metricsFile: string, line: MetricLine): void {
  try {
    appendFileSync(metricsFile, JSON.stringify(line) + "\n");
  } catch {
    // Metrics are best-effort — never fail the loop on a metric write.
  }
}

/**
 * Inline usage line right after `agent.exit`. Skipped silently in plain-text
 * mode (fake-claude in tests): no usage data → no line. Mirrors the format
 * used inside the review sub-loop so operators see one consistent shape.
 */
function logAgentUsage(log: Logger, r: AgentResult): void {
  if (!r.usage && r.costUsd == null) return;
  const u = r.usage;
  const wall = humanDuration(r.durationMs);
  const api = r.apiDurationMs != null ? humanDuration(r.apiDurationMs) : "?";
  const cost = r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : "$?";
  const tokens = u
    ? `in=${u.inputTokens} out=${u.outputTokens} cache-r=${u.cacheReadInputTokens} cache-c=${u.cacheCreationInputTokens}`
    : "n/a";
  log.detail("agent usage", `${tokens} cost=${cost} wall=${wall} api=${api}`);
}

function formatUsageInline(u: AgentUsage): string {
  return (
    `in=${u.inputTokens} out=${u.outputTokens} ` +
    `cache-r=${u.cacheReadInputTokens} cache-c=${u.cacheCreationInputTokens}`
  );
}

interface FinalStatusCtx {
  log: Logger;
  cfg: Config;
  runResult: RunResult;
  started: AggregateCounters;
  ended: AggregateCounters;
  outcomes: ReadonlyArray<IterationOutcome>;
  /** Cost / usage accumulated by this run. */
  runCostUsd: number;
  runUsage: AgentUsage;
  /** Lifetime cost / usage across all runs (from state.json). */
  lifetimeCostUsd: number;
  lifetimeUsage: AgentUsage;
}

function diffCounters(s: AggregateCounters, e: AggregateCounters): AggregateCounters {
  return {
    iterations: e.iterations - s.iterations,
    committed: e.committed - s.committed,
    blocked: e.blocked - s.blocked,
    rateLimitHits: e.rateLimitHits - s.rateLimitHits,
    testFailures: e.testFailures - s.testFailures,
    reviewRoundsTotal: e.reviewRoundsTotal - s.reviewRoundsTotal,
  };
}

function formatCounters(c: AggregateCounters): string {
  return (
    `iterations=${c.iterations} committed=${c.committed} ` +
    `blocked=${c.blocked} test-failures=${c.testFailures} rate-limit-hits=${c.rateLimitHits}`
  );
}

/**
 * End-of-run status block. Replaces the old single-line summary with a
 * structured report so the operator can tell at a glance:
 *  - whether the run finished cleanly, ran out of budget cleanly, or ran out
 *    of budget due to failures;
 *  - how many tasks remain to do;
 *  - what this run did vs. the lifetime totals carried in `.state.json`.
 */
function printFinalStatus(ctx: FinalStatusCtx): void {
  const { log, cfg, runResult, started, ended, outcomes } = ctx;
  const perRun = diffCounters(started, ended);
  const remaining = safeCountOpenTasks(cfg.tasksFile);

  switch (runResult) {
    case "complete-marker":
      log.done(`ralph finished — '${cfg.stopMarker}' present in progress.md`);
      break;
    case "complete-empty":
      log.done("ralph finished — all tasks checked off");
      break;
    case "cap": {
      const dirty =
        perRun.testFailures !== 0 ||
        perRun.blocked !== 0 ||
        outcomes.some((o) => DIRTY_OUTCOMES.has(o));
      if (!dirty) {
        log.info(
          `iteration cap reached (${cfg.maxIterations}) — every iteration succeeded · ` +
            `${remaining} task${remaining === 1 ? "" : "s"} still pending · re-run to continue`,
        );
      } else {
        log.warn(
          `iteration cap reached (${cfg.maxIterations}) — ${perRun.testFailures} test failure(s), ` +
            `${perRun.blocked} blocked task(s) this run · ${remaining} task${remaining === 1 ? "" : "s"} still pending · ` +
            `inspect ${relativePath(cfg.repoRoot, cfg.logsDir)}/`,
        );
      }
      break;
    }
  }

  log.info(`this run:  ${formatCounters(perRun)}`);
  log.info(`lifetime:  ${formatCounters(ended)}`);
  // Cost prefixed `~` — the claude-p backend reports estimates; the claude
  // backend reports real figures. We don't track which per run, so the `~`
  // stays as an honest "may include estimates" marker.
  log.info(
    `run cost:  ~$${ctx.runCostUsd.toFixed(4)}  tokens ${formatUsageInline(ctx.runUsage)}`,
  );
  log.info(
    `lifetime cost: ~$${ctx.lifetimeCostUsd.toFixed(4)}  tokens ${formatUsageInline(ctx.lifetimeUsage)}`,
  );
}

function safeCountOpenTasks(path: string): number {
  try {
    return countOpenTasks(path);
  } catch {
    return 0;
  }
}

function pruneOldLogs(logsDir: string, retentionDays: number): void {
  if (retentionDays <= 0) return;
  if (!existsSync(logsDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const full = resolve(logsDir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) unlinkSync(full);
    } catch {
      // Best effort — never fail pre-flight on a missing/unreadable log.
    }
  }
}

async function dropDirtyTree(ctx: IterationCtx, reason: string): Promise<void> {
  if (ctx.cfg.failResetMode === "leave") return;
  const label =
    `ralph-fail/${reason}/task-${ctx.task.id}-attempt-${ctx.attempt}-` +
    new Date().toISOString().replace(/[:.]/g, "-");
  const r = await cleanupFailedAttempt(
    { cwd: ctx.cfg.repoRoot, timeoutMs: ctx.cfg.gitTimeoutMs },
    ctx.cfg.failResetMode,
    label,
  );
  if (r.ok) {
    ctx.log.stage("tree.cleanup", `${r.mode} (${r.detail})`);
  } else {
    ctx.log.warn(`tree.cleanup failed (${r.mode}): ${r.detail}`);
  }
}

function appendProgressNote(progressFile: string, note: string): void {
  // Best-effort — failure here must not crash the loop.
  try {
    const existing = existsSync(progressFile) ? readFileSync(progressFile, "utf8") : "";
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    const stamped = `${sep}${note}  _(ralph @ ${formatLocalTs(new Date())})_\n`;
    appendFileSync(progressFile, stamped);
  } catch {
    // Swallow: progress.md is informational, never load-bearing for control flow.
  }
}

function relativePath(repoRoot: string, abs: string): string {
  if (abs.startsWith(repoRoot + "/")) return abs.slice(repoRoot.length + 1);
  return abs;
}

function buildPrompt(cfg: Config, task: TaskRef, attempt: number): string {
  const base = loadIterationPrompt(cfg);
  return [
    base,
    "",
    "─".repeat(72),
    "Loop runtime context (provided by the ralphloop driver, not by you):",
    `  Current task: #${task.id} — ${task.title}`,
    `  Attempt for this task: #${attempt}`,
    `  Loop driver: ralphloop`,
    "─".repeat(72),
    "",
  ].join("\n");
}

async function defaultRunTests(
  cfg: Config,
  _log: Logger,
): Promise<TestRunResult> {
  const pkg = resolve(cfg.repoRoot, "package.json");
  if (!existsSync(pkg)) return { ok: true, durationMs: 0, summary: "no package.json — skipped", output: "" };
  let pkgJson: { scripts?: Record<string, string> };
  try {
    pkgJson = JSON.parse(readFileSync(pkg, "utf8"));
  } catch {
    return { ok: true, durationMs: 0, summary: "package.json unparseable — skipped", output: "" };
  }
  const scripts = pkgJson.scripts ?? {};
  const hasTypecheck = typeof scripts["typecheck"] === "string";
  const hasTest = typeof scripts["test"] === "string";
  if (!hasTest && !hasTypecheck) {
    return { ok: true, durationMs: 0, summary: 'no "test"/"typecheck" scripts — skipped', output: "" };
  }

  const started = Date.now();

  if (cfg.typecheckEnabled && hasTypecheck) {
    const tc = await runBunScript(cfg, "typecheck", cfg.testTimeoutMs);
    if (tc.kind === "missing-bun") {
      return {
        ok: false,
        durationMs: Date.now() - started,
        summary:
          "bun not on PATH but project declares scripts — install bun or override RALPH_TYPECHECK_ENABLED=0",
        output: "",
      };
    }
    if (!tc.ok) {
      return {
        ok: false,
        durationMs: Date.now() - started,
        summary: `typecheck failed (exit ${tc.exitCode})`,
        output: tailOutput(`$ bun run typecheck\n${tc.stdout}\n${tc.stderr}`),
      };
    }
  }

  if (!hasTest) {
    return { ok: true, durationMs: Date.now() - started, summary: 'no "test" script — typecheck-only', output: "" };
  }

  const t = await runBunScript(cfg, "test", cfg.testTimeoutMs);
  if (t.kind === "missing-bun") {
    return {
      ok: false,
      durationMs: Date.now() - started,
      summary: "bun not on PATH but a test script is declared — install bun",
      output: "",
    };
  }
  return {
    ok: t.ok,
    durationMs: Date.now() - started,
    summary: t.ok ? "ok" : `exit ${t.exitCode}`,
    output: t.ok ? "" : tailOutput(`$ bun run test\n${t.stdout}\n${t.stderr}`),
  };
}

interface BunScriptResult {
  kind: "ran" | "missing-bun";
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runBunScript(
  cfg: Config,
  script: string,
  timeoutMs: number,
): Promise<BunScriptResult> {
  try {
    const result = await execa("bun", ["run", script], {
      cwd: cfg.repoRoot,
      timeout: timeoutMs,
      reject: false,
      stdin: "ignore",
    });
    const ok = result.exitCode === 0;
    return {
      kind: "ran",
      ok,
      exitCode: result.exitCode ?? 1,
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? ""),
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { kind: "missing-bun", ok: false, exitCode: 127, stdout: "", stderr: "" };
    return { kind: "ran", ok: false, exitCode: 1, stdout: "", stderr: (e.message ?? "") };
  }
}

const TEST_OUTPUT_TAIL_BYTES = 8 * 1024;

function tailOutput(s: string): string {
  if (s.length <= TEST_OUTPUT_TAIL_BYTES) return s.trimEnd();
  return "[…truncated…]\n" + s.slice(s.length - TEST_OUTPUT_TAIL_BYTES).trimEnd();
}
