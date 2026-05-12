/**
 * Shared types for the ralph TS loop.
 *
 * Plain data — no behaviour. Lives at the root of `ralph/` so every module
 * can import it without back-references.
 */

/** A pending task pulled from `ralph/tasks.md`. */
export interface TaskRef {
  /** Numeric id, zero-padded as authored ("01", "40", …). */
  id: string;
  /** Title text after `- [ ] **NN** `, trimmed. */
  title: string;
  /** 1-based line number in `tasks.md`. */
  lineNumber: number;
}

/** Result of a single rate-limit detection pass over agent output. */
export interface RateLimitInfo {
  /** Absolute time at which the limit is expected to reset, or null if unknown. */
  until: Date | null;
  /** Human-readable reason — used for the console log line. */
  reason: string;
}

/** Result of one `AgentProcess.run(prompt)` invocation. */
export interface AgentResult {
  /** Process exit code; null when the process was killed before exit. */
  exitCode: number | null;
  /** Signal name when killed; null otherwise. */
  signal: NodeJS.Signals | null;
  /** Full captured stdout. */
  stdout: string;
  /** Full captured stderr. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True iff the timeout fired and the process was terminated by it. */
  timedOut: boolean;
  /** True iff `kill()` was called externally. */
  killed: boolean;
  /** Populated when rate-limit text was detected in stdout/stderr. */
  rateLimit: RateLimitInfo | null;
}

/** Outcome of a single loop iteration — used by tests + the smoke runner. */
export type IterationOutcome =
  | "stop-marker"
  | "no-tasks"
  | "rate-limited"
  | "agent-failed"
  | "tests-failed"
  | "no-changes-retry"
  | "no-changes-accepted"
  | "committed"
  /**
   * Review sub-loop ran every fix round but never produced a clean tree.
   * Tests pass at the post-subloop HEAD though, so the task itself is
   * accepted; we only forfeited the review polish.
   */
  | "committed-review-skipped"
  | "task-not-marked";

/**
 * Outcome of a single test-gate invocation. `output` is a tail of the failed
 * command's stdout+stderr, capped to a few KB — large enough to read the
 * actual error, small enough to embed in a fixer prompt. Empty when tests
 * passed.
 */
export interface TestRunResult {
  ok: boolean;
  durationMs: number;
  /** Short human-readable label ("ok", "exit 1", "typecheck failed (exit 2)"). */
  summary: string;
  /** Tail of stdout+stderr from the failing step. Empty when ok=true. */
  output: string;
}
