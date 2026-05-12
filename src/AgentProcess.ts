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
import { detectRateLimit } from "./RateLimit.js";
import type { AgentResult } from "./types.js";

export interface AgentProcessOptions {
  /** Path or name of the binary. Default: 'claude'. */
  command?: string;
  /** Model name passed via `--model`. */
  model: string;
  /**
   * Args inserted before `--model`. Default mirrors `loop.sh:42`:
   * `['--print', '--dangerously-skip-permissions']`. Override only for
   * testing (e.g. to point at a fake-claude shim).
   */
  extraArgs?: string[];
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
    const extraArgs = this.opts.extraArgs ?? ["--print", "--dangerously-skip-permissions"];
    const args = [...extraArgs, "--model", this.opts.model];

    this.startedAt = Date.now();
    this.explicitlyKilled = false;

    const child = execa(command, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      timeout: this.opts.timeoutMs,
      killSignal: "SIGTERM",
      forceKillAfterDelay: this.opts.killGraceMs ?? 30_000,
      input: prompt,
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

    // Live tee/onLine — runs alongside execa's buffer. We only use these for
    // realtime side-effects; the authoritative full strings come from
    // result.stdout / result.stderr below.
    const stdoutSplitter = new LineSplitter((line) => {
      this.opts.logStream?.write(stripAnsi(line) + "\n");
      this.opts.onLine?.("stdout", line);
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
    const rateLimit = failed
      ? detectRateLimit(`${stdout}\n${stderr}`)
      : null;

    return {
      exitCode,
      signal,
      stdout,
      stderr,
      durationMs,
      timedOut,
      killed,
      rateLimit,
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
