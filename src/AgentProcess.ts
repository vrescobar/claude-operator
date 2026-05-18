/**
 * AgentProcess — wraps a single `claude -p` subprocess.
 *
 * The shell call is the part of the loop most likely to hang or be hard to
 * debug, so it gets the strongest abstraction:
 *
 *   - Hard wall-clock timeout (SIGTERM, then SIGKILL after `killGraceMs`).
 *   - Live line-by-line tee to the per-iteration log file and the (optional)
 *     `onLine` callback, plus authoritative final stdout/stderr strings
 *     captured by execa's own buffer.
 *   - No-throw contract: only ENOENT bubbles. Every other failure
 *     (timeout, signal, non-zero exit) is reported on `AgentResult`.
 *   - Rate-limit detection on the combined output, stamped on the result.
 *   - Idempotent `kill()` for SIGINT handlers.
 *
 * Design intent: this class is the only place in the loop that talks to
 * `execa`. Swapping `claude -p` for a PTY-backed interactive invocation
 * later is a one-class change.
 */

import { execa, type ResultPromise } from "execa";
import type { Writable } from "node:stream";
import { stripAnsi } from "./Logger.js";
import { estimateCostUsd } from "./Pricing.js";
import { detectRateLimit, detectServerError } from "./RateLimit.js";
import { readSessionUsage } from "./SessionUsage.js";
import type { AgentResult, AgentUsage } from "./types.js";

export interface AgentProcessOptions {
  /** Path or name of the binary. Default: 'claude'. */
  command?: string;
  /** Model name passed via `--model`. */
  model: string;
  /**
   * Args inserted before `--model`. Default:
   * `['--print', '--dangerously-skip-permissions', '--output-format',
   *   'stream-json', '--verbose']`.
   *
   * `--output-format stream-json --verbose` makes claude emit one JSON
   * event per line (assistant text, tool_use, tool_result, system init,
   * rate_limit, and a final `result` event with full `usage`, cost,
   * and api duration). The parser in `run()` consumes those to populate
   * `AgentResult.usage / .costUsd / .text / .apiDurationMs / .numTurns`
   * and renders each event to a single human-readable line on the
   * `logStream` / `onLine` callback, so `tail -f` of the iteration log
   * stays readable even though the wire format is JSON.
   *
   * Override only for testing (e.g. to point at a fake-claude shim that
   * emits plain text — the parser falls back to text mode in that case).
   */
  extraArgs?: string[];
  /**
   * When true (default) the prompt is piped to the child's stdin. When false
   * it is appended as the last positional argument instead — needed for
   * backends that take the prompt as an argv rather than reading stdin.
   */
  promptViaStdin?: boolean;
  /**
   * Session id this run was launched with (the `claude-p` backend forces one
   * via `--session-id`). When set together with `recoverUsage`, the persisted
   * transcript is read back after exit to recover real token usage.
   */
  sessionId?: string | null;
  /**
   * When true, and the stream-json `result` event carried no real usage
   * (zero / absent — as with `claude-p`), recover token counts from the
   * session transcript and estimate cost from `model`.
   */
  recoverUsage?: boolean;
  /** Wall-clock cap. SIGTERM at this point, SIGKILL `killGraceMs` later. */
  timeoutMs: number;
  /** Grace period between SIGTERM and SIGKILL. Default 30 s — matches `--kill-after=30s` in bash. */
  killGraceMs?: number;
  cwd: string;
  /** Extra env vars merged on top of `process.env`. Never logged. */
  env?: NodeJS.ProcessEnv;
  /** Tee target for the per-iteration log file (one line per agent line). */
  logStream?: Writable;
  /** Called once per agent line; used for live verbose console streaming. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Max bytes execa will buffer per stream. Default 50 MB. */
  maxBufferBytes?: number;
}

export class AgentProcess {
  private child: ResultPromise | null = null;
  private startedAt = 0;
  private explicitlyKilled = false;
  /**
   * Resolves the moment the underlying child process exits — either cleanly,
   * by signal, or via timeout. Replaces the spawn-then-fire-and-forget
   * pattern so SIGINT handlers can `await agent.exited()` before tearing
   * the parent down, instead of leaving an orphaned `claude` behind.
   */
  private exitedPromise: Promise<void> = Promise.resolve();

  constructor(private readonly opts: AgentProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** A promise that resolves when the most recent `run()` invocation's child
   * has fully exited. Always resolved (never rejected) so it's safe to `await`
   * without try/catch from a signal handler. */
  exited(): Promise<void> {
    return this.exitedPromise;
  }

  /**
   * Spawn `claude -p`, pipe `prompt` to stdin, and resolve when it exits
   * (or the timeout fires, or `kill()` is called).
   *
   * Throws ONLY when the binary is missing (ENOENT). All other failures
   * are reported via `AgentResult`.
   */
  async run(prompt: string): Promise<AgentResult> {
    const command = this.opts.command ?? "claude";
    const extraArgs = this.opts.extraArgs ?? [
      "--print",
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    // Default: prompt on stdin. When `promptViaStdin` is false the prompt is
    // the last positional argv instead (some backends don't read stdin).
    const promptViaStdin = this.opts.promptViaStdin ?? true;
    const args = promptViaStdin
      ? [...extraArgs, "--model", this.opts.model]
      : [...extraArgs, "--model", this.opts.model, prompt];

    this.startedAt = Date.now();
    this.explicitlyKilled = false;

    const child = execa(command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      timeout: this.opts.timeoutMs,
      killSignal: "SIGTERM",
      forceKillAfterDelay: this.opts.killGraceMs ?? 30_000,
      input: promptViaStdin ? prompt : undefined,
      reject: false,
      // buffer: true (the default) — execa accumulates stdout/stderr into
      // strings on the result. We separately attach 'data' listeners for
      // live tee, which Node.js Readable streams support concurrently.
      maxBuffer: this.opts.maxBufferBytes ?? 50 * 1024 * 1024,
    });
    this.child = child;
    // Materialise an always-resolves promise so signal handlers can await
    // exit without ever throwing.
    this.exitedPromise = child.then(
      () => undefined,
      () => undefined,
    );

    // Stream-json event aggregator. Captures the final `result` event so we
    // can fill `text` / `usage` / `costUsd` after the child exits. A pure
    // sink — does NOT touch the live tee path.
    const stream = new StreamJsonAggregator();

    // Live tee/onLine — runs alongside execa's buffer. Each stdout line goes
    // through the renderer: stream-json events come out as one human-readable
    // line each ("[assistant] …", "[tool] Bash(git …)", "[done] $0.42 in=…")
    // so `tail -f` of the iteration log stays readable. Plain-text lines
    // (fake-claude in tests, or a future text-mode override) pass through.
    const stdoutSplitter = new LineSplitter((line) => {
      const rendered = stream.consume(line);
      for (const out of rendered) {
        this.opts.logStream?.write(stripAnsi(out) + "\n");
        this.opts.onLine?.("stdout", out);
      }
    });
    const stderrSplitter = new LineSplitter((line) => {
      this.opts.logStream?.write("[stderr] " + stripAnsi(line) + "\n");
      this.opts.onLine?.("stderr", line);
    });

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutSplitter.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrSplitter.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    let result: Awaited<ResultPromise>;
    try {
      result = await child;
    } catch (err: unknown) {
      // Defensive: with reject:false execa shouldn't throw, but if it does
      // (e.g. an unhandled internal error), preserve ENOENT for callers.
      const e = err as NodeJS.ErrnoException;
      this.child = null;
      if (e.code === "ENOENT") throw wrapEnoent(command);
      throw err;
    }
    this.child = null;

    // ENOENT under reject:false comes back on the result rather than as a
    // thrown error. Translate it into a typed throw so callers can distinguish
    // "claude not installed" from a normal non-zero exit.
    const errCode = (result as { code?: string }).code;
    if (errCode === "ENOENT") {
      throw wrapEnoent(command);
    }

    // Flush any trailing partial line so the tee reflects the full output
    // even when the child didn't terminate the last line with \n.
    stdoutSplitter.flush();
    stderrSplitter.flush();

    const stdout = stringFrom(result.stdout);
    const stderr = stringFrom(result.stderr);
    const durationMs = Date.now() - this.startedAt;

    const timedOut = Boolean(result.timedOut);
    const killed = Boolean((result as { isCanceled?: boolean }).isCanceled) || this.explicitlyKilled;
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
    const signal = (result.signal as NodeJS.Signals | undefined) ?? null;

    // Only honour a rate-limit signal when the process did NOT exit cleanly.
    // A successful agent run cannot legitimately be rate-limited; treating
    // every output that mentions "rate limit" as one is the most common
    // false-positive when the agent is itself a coding agent reading or
    // writing code about rate limits.
    const failed = exitCode !== 0 || timedOut;
    const combinedOutput = `${stdout}\n${stderr}`;
    // A timed-out run consumed its *entire* wall-clock budget — the opposite
    // of a rate-limit, which makes claude exit fast. Scanning a timeout's
    // output for rate-limit text mis-reads a long stuck agent (which mentions
    // or emits "rate limit" telemetry in passing) as rate-limited and then
    // sleeps for hours. Timeouts are handled by the caller's timeout path.
    const rateLimit = failed && !timedOut ? detectRateLimit(combinedOutput) : null;

    // Pull usage + final assistant text out of the stream-json aggregator.
    // Fallback when no stream-json `result` event was seen: stdout-as-text,
    // null usage. That path is what fake-claude (tests) and any future
    // text-mode override hit.
    const final = stream.finalize();
    const text = final.text ?? stdout;

    let usage = final.usage;
    let costUsd = final.costUsd;
    let usageSource: AgentResult["usageSource"] = usage ? "stream-json" : null;
    let costEstimated = false;

    // The `claude-p` backend always emits placeholder usage in its stream
    // (`output_tokens: 1`, everything else null), so when recovery is enabled
    // we unconditionally prefer the real per-turn counts read back from the
    // persisted session transcript. `isZeroUsage` only guards against an
    // empty / not-yet-flushed transcript.
    if (this.opts.recoverUsage && this.opts.sessionId) {
      const recovered = readSessionUsage(this.opts.sessionId);
      if (recovered && !isZeroUsage(recovered)) {
        usage = recovered;
        usageSource = "session-jsonl";
      }
    }

    // No real cost from the backend → estimate from tokens × the price table.
    if (costUsd == null && usage) {
      const est = estimateCostUsd(this.opts.model, usage);
      if (est != null) {
        costUsd = est;
        costEstimated = true;
      }
    }

    // Transient server error (HTTP 5xx / overloaded). Gated on the
    // machine-readable `result.is_error` signal (a clean-exit error run, as
    // claude-p produces on a 5xx) or any non-clean exit, so the pattern scan
    // can't false-positive on an agent that merely writes about 5xx.
    const isError = final.isError;
    const serverError =
      isError || failed ? detectServerError(combinedOutput) : null;

    return {
      exitCode,
      signal,
      stdout,
      stderr,
      text,
      durationMs,
      apiDurationMs: final.apiDurationMs,
      costUsd,
      numTurns: final.numTurns,
      usage,
      timedOut,
      killed,
      rateLimit,
      isError,
      serverError,
      sessionId: this.opts.sessionId ?? null,
      usageSource,
      costEstimated,
    };
  }

  /**
   * Send a signal to the child. Idempotent — safe to call from a SIGINT
   * handler regardless of state. Default `SIGTERM`; execa's
   * `forceKillAfterDelay` escalates to SIGKILL after `killGraceMs`.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.explicitlyKilled = true;
    try {
      child.kill(signal);
    } catch {
      // Already exited / not yet spawned — ignore.
    }
  }
}

/**
 * Buffers chunks until a `\n` arrives, then emits one full line at a time.
 * Tolerates `\r\n` by stripping a trailing `\r` from each emitted line.
 */
class LineSplitter {
  private buf = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      this.onLine(line);
    }
  }

  flush(): void {
    if (this.buf.length > 0) {
      const line = this.buf.replace(/\r$/, "");
      this.buf = "";
      this.onLine(line);
    }
  }
}

/**
 * Stateful aggregator that consumes one stdout line at a time, renders it
 * to human-readable trace lines, and pulls usage/cost/final-text out of the
 * trailing `result` event.
 *
 * `consume(line)` returns the lines that should be written to the live tee
 * (one event can produce 0..N rendered lines). `finalize()` returns the
 * captured usage block once the stream is done — null when the input was
 * not stream-json (so callers fall back to treating stdout as plain text).
 *
 * Design intent: keep this class pure-data — no I/O, no config. The shape of
 * each event mirrors the documented Claude Code stream-json contract; new
 * event types fall through to a generic `[event:<type>]` line so we never
 * silently drop content the operator might want to see.
 */
class StreamJsonAggregator {
  private sawStreamJson = false;
  private finalText: string | null = null;
  private usage: AgentUsage | null = null;
  private costUsd: number | null = null;
  private apiDurationMs: number | null = null;
  private numTurns: number | null = null;
  private isError = false;

  consume(rawLine: string): string[] {
    const line = rawLine.trim();
    if (line.length === 0) return [""];
    if (!looksLikeJson(line)) {
      // Plain-text mode (fake-claude, future text override). Pass through
      // unchanged. We never flip `sawStreamJson` to true here, so finalize()
      // will return text=null and callers fall back to stdout.
      return [rawLine];
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return [rawLine];
    }
    if (!isStreamJsonEvent(event)) return [rawLine];
    this.sawStreamJson = true;
    return this.render(event);
  }

  finalize(): {
    text: string | null;
    usage: AgentUsage | null;
    costUsd: number | null;
    apiDurationMs: number | null;
    numTurns: number | null;
    isError: boolean;
  } {
    if (!this.sawStreamJson) {
      return {
        text: null,
        usage: null,
        costUsd: null,
        apiDurationMs: null,
        numTurns: null,
        isError: false,
      };
    }
    return {
      text: this.finalText,
      usage: this.usage,
      costUsd: this.costUsd,
      apiDurationMs: this.apiDurationMs,
      numTurns: this.numTurns,
      isError: this.isError,
    };
  }

  private render(event: StreamJsonEvent): string[] {
    switch (event.type) {
      case "system":
        // The init event is a noisy dump of tool registry + session id.
        // Render a one-liner so logs still show "claude started" without
        // burying the rest of the trace.
        if (event.subtype === "init") {
          const model = typeof event.model === "string" ? event.model : "?";
          return [`[system] init model=${model}`];
        }
        return [`[system] ${event.subtype ?? "event"}`];

      case "rate_limit_event": {
        const info = event.rate_limit_info;
        if (info && typeof info === "object") {
          const status = (info as { status?: string }).status ?? "?";
          const resets = (info as { resetsAt?: number }).resetsAt;
          const reset = typeof resets === "number" ? new Date(resets * 1000).toISOString() : "?";
          return [`[rate-limit] status=${status} resets=${reset}`];
        }
        return ["[rate-limit] (info unavailable)"];
      }

      case "assistant":
        return this.renderAssistant(event);

      case "user":
        return this.renderUserToolResults(event);

      case "result": {
        if (typeof event.result === "string") this.finalText = event.result;
        if (typeof event.duration_api_ms === "number") this.apiDurationMs = event.duration_api_ms;
        if (typeof event.total_cost_usd === "number") this.costUsd = event.total_cost_usd;
        if (typeof event.num_turns === "number") this.numTurns = event.num_turns;
        const u = event.usage;
        if (u && typeof u === "object") {
          this.usage = {
            inputTokens: numField(u, "input_tokens"),
            outputTokens: numField(u, "output_tokens"),
            cacheReadInputTokens: numField(u, "cache_read_input_tokens"),
            cacheCreationInputTokens: numField(u, "cache_creation_input_tokens"),
          };
        }
        const lines = [
          `[done] turns=${this.numTurns ?? "?"} ` +
            `cost=${formatCost(this.costUsd)} ` +
            `tokens=${formatUsageInline(this.usage)} ` +
            `api=${formatMs(this.apiDurationMs)}`,
        ];
        if (event.is_error) {
          this.isError = true;
          lines.push(`[error] ${event.api_error_status ?? "unknown"}`);
        }
        return lines;
      }

      default:
        return [`[event:${(event as { type?: string }).type ?? "?"}]`];
    }
  }

  private renderAssistant(event: StreamJsonEvent): string[] {
    const msg = (event as { message?: unknown }).message;
    if (!msg || typeof msg !== "object") return [];
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const t = (c as { type?: string }).type;
      if (t === "text") {
        const text = (c as { text?: string }).text;
        if (typeof text === "string" && text.length > 0) {
          for (const ln of text.split("\n")) out.push(`[assistant] ${ln}`);
        }
      } else if (t === "thinking") {
        const thinking = (c as { thinking?: string }).thinking;
        if (typeof thinking === "string" && thinking.length > 0) {
          // Thinking can be very long. Keep one compact preview so the log
          // shows that reasoning happened without drowning out everything
          // else. Operators who need the full text can read the raw model
          // transcript elsewhere.
          out.push(`[thinking] ${truncateOneLine(thinking, 200)}`);
        }
      } else if (t === "tool_use") {
        const name = (c as { name?: string }).name ?? "?";
        const input = (c as { input?: unknown }).input;
        out.push(`[tool] ${name}(${previewInput(input)})`);
      } else {
        out.push(`[content:${t ?? "?"}]`);
      }
    }
    return out;
  }

  private renderUserToolResults(event: StreamJsonEvent): string[] {
    // claude emits a `user` event for each tool_result the harness feeds back
    // into the conversation. We render just the type + a short preview so
    // tool output doesn't dominate the log; the full content is available
    // in the raw stdout buffer for deep debugging if needed.
    const msg = (event as { message?: unknown }).message;
    if (!msg || typeof msg !== "object") return [];
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const out: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const t = (c as { type?: string }).type;
      if (t === "tool_result") {
        const isErr = Boolean((c as { is_error?: boolean }).is_error);
        const body = (c as { content?: unknown }).content;
        const preview = previewToolResult(body);
        out.push(`[tool-result${isErr ? ":error" : ""}] ${preview}`);
      }
    }
    return out;
  }
}

interface StreamJsonEvent {
  type: string;
  subtype?: string;
  model?: string;
  rate_limit_info?: unknown;
  result?: unknown;
  duration_api_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  usage?: unknown;
  is_error?: boolean;
  api_error_status?: string | null;
}

function isStreamJsonEvent(v: unknown): v is StreamJsonEvent {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function looksLikeJson(line: string): boolean {
  return line.startsWith("{") && line.endsWith("}");
}

function isZeroUsage(u: AgentUsage): boolean {
  return (
    u.inputTokens === 0 &&
    u.outputTokens === 0 &&
    u.cacheReadInputTokens === 0 &&
    u.cacheCreationInputTokens === 0
  );
}

function numField(o: object, key: string): number {
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function previewInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return truncateOneLine(input, 120);
  try {
    return truncateOneLine(JSON.stringify(input), 120);
  } catch {
    return "<unserialisable>";
  }
}

function previewToolResult(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return truncateOneLine(body, 120);
  if (Array.isArray(body)) {
    // Vision and structured tool_result bodies are arrays of `{type, text}`
    // entries. Concatenate their `text` fields with single-space separators.
    const text = body
      .map((it) => (it && typeof it === "object" && typeof (it as { text?: string }).text === "string"
        ? (it as { text: string }).text
        : ""))
      .filter((s) => s.length > 0)
      .join(" ");
    return truncateOneLine(text, 120);
  }
  try {
    return truncateOneLine(JSON.stringify(body), 120);
  } catch {
    return "<unserialisable>";
  }
}

function formatCost(n: number | null): string {
  if (n == null) return "?";
  return `$${n.toFixed(4)}`;
}

function formatMs(n: number | null): string {
  if (n == null) return "?";
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function formatUsageInline(u: AgentUsage | null): string {
  if (!u) return "?";
  return (
    `in=${u.inputTokens} out=${u.outputTokens} ` +
    `cache-r=${u.cacheReadInputTokens} cache-c=${u.cacheCreationInputTokens}`
  );
}

function wrapEnoent(command: string): NodeJS.ErrnoException {
  const wrapped = new Error(
    `ralph: '${command}' not found in PATH (set RALPH_CLAUDE_BIN to override).`,
  ) as NodeJS.ErrnoException;
  wrapped.code = "ENOENT";
  return wrapped;
}

function stringFrom(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join("\n");
  if (v == null) return "";
  return String(v);
}
