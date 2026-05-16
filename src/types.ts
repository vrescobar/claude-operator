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

/**
 * Result of a transient server-error (HTTP 5xx / overloaded) detection pass.
 * Unlike a rate-limit, a 5xx never carries a reset time — the loop always
 * falls back to an exponential backoff curve. A 5xx is infrastructure, not the
 * task's fault, so it must NOT consume the task's attempt budget.
 */
export interface ServerErrorInfo {
  /** Human-readable reason — used for the console log line. */
  reason: string;
}

/**
 * Token / cost usage for one agent invocation. Populated when claude is
 * invoked with `--output-format stream-json` and the final `result` event is
 * parsed; null when the run produced plain-text output (e.g. fake-claude in
 * tests, or stream-json parsing failed).
 *
 * Fields mirror the `usage` block emitted by `claude --print --output-format
 * stream-json` so callers can map straight to the public Anthropic billing
 * shape without bespoke math.
 */
export interface AgentUsage {
  /** Net new input tokens (not counting cache reads/creations). */
  inputTokens: number;
  /** Output tokens emitted by the model. */
  outputTokens: number;
  /** Tokens served from a prior prompt cache (cheap reads). */
  cacheReadInputTokens: number;
  /** Tokens that wrote into the prompt cache during this run. */
  cacheCreationInputTokens: number;
}

/** Result of one `AgentProcess.run(prompt)` invocation. */
export interface AgentResult {
  /** Process exit code; null when the process was killed before exit. */
  exitCode: number | null;
  /** Signal name when killed; null otherwise. */
  signal: NodeJS.Signals | null;
  /** Full captured stdout (raw — in stream-json mode this is JSON-per-line). */
  stdout: string;
  /** Full captured stderr. */
  stderr: string;
  /**
   * Final assistant text. In stream-json mode this is the `result` field of
   * the trailing `result` event (i.e. the agent's last assistant message).
   * In plain-text mode it equals `stdout`. Reviewer/fixer callers should read
   * `text`, not `stdout`, so the format switch stays a one-class change.
   */
  text: string;
  /** Wall-clock duration in milliseconds (measured by the loop driver). */
  durationMs: number;
  /**
   * API-side duration claude reports in its `result` event — excludes
   * tool execution time. Null when not available (text mode, parse failure).
   */
  apiDurationMs: number | null;
  /** Total cost in USD reported by claude. Null when not available. */
  costUsd: number | null;
  /** Number of agent turns / tool-use cycles. Null when not available. */
  numTurns: number | null;
  /** Token usage breakdown. Null when not available. */
  usage: AgentUsage | null;
  /** True iff the timeout fired and the process was terminated by it. */
  timedOut: boolean;
  /** True iff `kill()` was called externally. */
  killed: boolean;
  /** Populated when rate-limit text was detected in stdout/stderr. */
  rateLimit: RateLimitInfo | null;
  /**
   * True when the trailing stream-json `result` event reported `is_error`.
   * A machine-readable signal (not the agent merely discussing errors).
   */
  isError: boolean;
  /**
   * Populated when a transient server error (HTTP 5xx / overloaded) was
   * detected — `isError` plus a 5xx pattern in the output. Drives a
   * backoff-and-retry that does not consume the task's attempt budget.
   */
  serverError: ServerErrorInfo | null;
  /**
   * Session id this run was launched with (the `claude-p` backend forces one
   * via `--session-id`). Null for the `claude` backend. Surfaced so callers
   * can record it and locate the persisted transcript.
   */
  sessionId: string | null;
  /**
   * Where `usage` came from:
   *  - `"stream-json"` — claude's own `result` event (the `claude` backend).
   *  - `"session-jsonl"` — recovered from the persisted session transcript
   *    because the backend (`claude-p`) reports placeholder usage.
   *  - `null` — no usage available (plain-text / fake-claude).
   */
  usageSource: "stream-json" | "session-jsonl" | null;
  /**
   * True when `costUsd` is an estimate computed from token counts × a local
   * price table (`Pricing.ts`) rather than a figure claude reported itself.
   * Always true under the `claude-p` backend when usage was recovered.
   */
  costEstimated: boolean;
}

/** Zero-initialised usage block — useful when summing across rounds. */
export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

/** Sum two usage blocks. Null operands are treated as zero. */
export function addUsage(a: AgentUsage | null, b: AgentUsage | null): AgentUsage {
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadInputTokens: (a?.cacheReadInputTokens ?? 0) + (b?.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (a?.cacheCreationInputTokens ?? 0) + (b?.cacheCreationInputTokens ?? 0),
  };
}

/** Outcome of a single loop iteration — used by tests + the smoke runner. */
export type IterationOutcome =
  | "stop-marker"
  | "no-tasks"
  | "rate-limited"
  /** Transient HTTP 5xx / overloaded error — retried, does not consume an attempt. */
  | "server-error"
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
