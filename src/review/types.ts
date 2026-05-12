/**
 * Shared types for the reviewer/fixer sub-loop.
 */

import type { AgentUsage } from "../types.js";

/** Verdict parsed from the trailing `VERDICT:` line of a review report. */
export type ReviewVerdict = "APPROVE" | "NEEDS_CHANGES" | "UNKNOWN";

/** Item counts derived from a review report's body. */
export interface ReviewCounts {
  blockers: number;
  nits: number;
  tests: number;
}

/**
 * Aggregated token/cost usage across every reviewer + fixer round of one
 * sub-loop. Always present in `SubloopOutcome` so the outer loop can write
 * it straight to `metrics.jsonl` without juggling option types.
 *
 * `reviewerUsage` and `fixerUsage` may be all-zero in plain-text mode
 * (fake-claude in tests) or when claude's `result` event was malformed.
 */
export interface SubloopUsage {
  reviewerUsage: AgentUsage;
  fixerUsage: AgentUsage;
  reviewerCostUsd: number;
  fixerCostUsd: number;
  reviewerDurationMs: number;
  fixerDurationMs: number;
  reviewerApiDurationMs: number;
  fixerApiDurationMs: number;
}

/** Output of one round of the sub-loop, exposed for tests. */
export type SubloopOutcome =
  | { kind: "converged"; rounds: number; usage: SubloopUsage }
  | { kind: "exceeded"; rounds: number; usage: SubloopUsage }
  /**
   * Sub-loop ran out of fix opportunities (round cap, no-op streak,
   * repeat-diff streak, RL exhaustion, or reviewer crash streak) without
   * tests being green. The outer loop should reset to the original task
   * commit, revert the task to `[ ]`, and let the main agent retry —
   * instead of halting the whole run.
   */
  | { kind: "diverged"; reason: string; testsOkAtEnd: boolean; rounds: number; usage: SubloopUsage };

/** Zero-initialised sub-loop usage block — useful for the never-spawned case. */
export function emptySubloopUsage(): SubloopUsage {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  return {
    reviewerUsage: { ...zero },
    fixerUsage: { ...zero },
    reviewerCostUsd: 0,
    fixerCostUsd: 0,
    reviewerDurationMs: 0,
    fixerDurationMs: 0,
    reviewerApiDurationMs: 0,
    fixerApiDurationMs: 0,
  };
}
