/**
 * Persisted ralph state — `ralph/.state.json` (gitignored).
 *
 * The file holds a single `LoopState` blob and survives across runs so that:
 *   - Per-task attempt counters (used for the attempt-limit guard) keep
 *     monotonically incrementing even after a crash / Ctrl-C / reboot.
 *   - The "no-changes-accepted" decision isn't reset by a restart that would
 *     otherwise let the agent burn `noChangeRetryLimit` retries again.
 *   - Aggregate counters (successful tasks, blocked tasks, rate-limit hits)
 *     are durable for the run-summary printed at exit.
 *
 * Writes are atomic (tmp file + rename in the same FS) so a crash mid-write
 * never corrupts the JSON. Reads tolerate a missing or unparseable file by
 * starting from a fresh state.
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic.js";
import { emptyUsage, type AgentUsage } from "./types.js";

export interface TaskState {
  /** Total spawn attempts across all runs (used for the attempt-limit guard). */
  attempts: number;
  /** How many times this task has been marked done with no diff. */
  noChangeAttempts: number;
  /** ISO timestamp of the most recent attempt. */
  lastAttemptAt: string | null;
  /** True when the task has been moved to `[!]` in tasks.md. */
  blocked: boolean;
}

export interface AggregateCounters {
  iterations: number;
  committed: number;
  blocked: number;
  rateLimitHits: number;
  testFailures: number;
  reviewRoundsTotal: number;
}

export interface LoopState {
  /** Schema version. Bump when the shape changes incompatibly. */
  version: 1;
  tasks: Record<string, TaskState>;
  counters: AggregateCounters;
  /**
   * Lifetime cost across all runs (USD). Real figures under the `claude`
   * backend; token-derived estimates under `claude-p`.
   */
  totalCostUsd: number;
  /** Lifetime token usage across all runs. */
  totalUsage: AgentUsage;
}

const EMPTY_COUNTERS: AggregateCounters = {
  iterations: 0,
  committed: 0,
  blocked: 0,
  rateLimitHits: 0,
  testFailures: 0,
  reviewRoundsTotal: 0,
};

export function freshState(): LoopState {
  return {
    version: 1,
    tasks: {},
    counters: { ...EMPTY_COUNTERS },
    totalCostUsd: 0,
    totalUsage: emptyUsage(),
  };
}

/** Coerce an untrusted value into a well-formed AgentUsage (missing → 0). */
function sanitizeUsage(v: unknown): AgentUsage {
  const u = emptyUsage();
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const n = (k: string): number =>
      typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : 0;
    u.inputTokens = n("inputTokens");
    u.outputTokens = n("outputTokens");
    u.cacheReadInputTokens = n("cacheReadInputTokens");
    u.cacheCreationInputTokens = n("cacheCreationInputTokens");
  }
  return u;
}

export function loadState(path: string): LoopState {
  if (!existsSync(path)) return freshState();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return freshState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return freshState();
  }
  if (!isLoopStateLike(parsed)) return freshState();
  const extra = parsed as { totalCostUsd?: unknown; totalUsage?: unknown };
  return {
    version: 1,
    tasks: { ...parsed.tasks },
    counters: { ...EMPTY_COUNTERS, ...parsed.counters },
    totalCostUsd:
      typeof extra.totalCostUsd === "number" && Number.isFinite(extra.totalCostUsd)
        ? extra.totalCostUsd
        : 0,
    totalUsage: sanitizeUsage(extra.totalUsage),
  };
}

export function saveState(path: string, state: LoopState): void {
  atomicWriteFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function getTaskState(state: LoopState, id: string): TaskState {
  const existing = state.tasks[id];
  if (existing) return existing;
  const fresh: TaskState = {
    attempts: 0,
    noChangeAttempts: 0,
    lastAttemptAt: null,
    blocked: false,
  };
  state.tasks[id] = fresh;
  return fresh;
}

function isLoopStateLike(v: unknown): v is { tasks: Record<string, TaskState>; counters: AggregateCounters } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as { tasks?: unknown; counters?: unknown; version?: unknown };
  if (o.version !== 1) return false;
  if (typeof o.tasks !== "object" || o.tasks === null) return false;
  if (typeof o.counters !== "object" || o.counters === null) return false;
  return true;
}
