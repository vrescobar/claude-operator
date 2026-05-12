/**
 * Shared types for the reviewer/fixer sub-loop.
 */

/** Verdict parsed from the trailing `VERDICT:` line of a review report. */
export type ReviewVerdict = "APPROVE" | "NEEDS_CHANGES" | "UNKNOWN";

/** Item counts derived from a review report's body. */
export interface ReviewCounts {
  blockers: number;
  nits: number;
  tests: number;
}

/** Output of one round of the sub-loop, exposed for tests. */
export type SubloopOutcome =
  | { kind: "converged"; rounds: number }
  | { kind: "exceeded"; rounds: number }
  /**
   * Sub-loop ran out of fix opportunities (round cap, no-op streak,
   * repeat-diff streak, RL exhaustion, or reviewer crash streak) without
   * tests being green. The outer loop should reset to the original task
   * commit, revert the task to `[ ]`, and let the main agent retry —
   * instead of halting the whole run.
   */
  | { kind: "diverged"; reason: string; testsOkAtEnd: boolean; rounds: number };
