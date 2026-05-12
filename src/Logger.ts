/**
 * Stage-aware console logger for the ralph loop.
 *
 * Goal: every state transition becomes a single, readable, greppable line on
 * the operator's terminal. The per-iteration log file (in `ralph/logs/`)
 * captures the full agent stream regardless of verbosity, so debugging a
 * hung process is always `tail -f` away.
 */

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function color(code: string, text: string): string {
  if (process.stdout.isTTY !== true) return text;
  return `${code}${text}${ANSI.reset}`;
}

export interface LoggerOptions {
  /** When true, every claude output line is streamed via streamAgentLine(). */
  verbose: boolean;
}

export class Logger {
  constructor(private readonly opts: LoggerOptions) {}

  private now(): string {
    const d = new Date();
    return d.toISOString().slice(11, 19);
  }

  private write(line: string): void {
    process.stdout.write(line + "\n");
  }

  bar(): void {
    this.write(color(ANSI.dim, "─".repeat(72)));
  }

  iterationHeader(iter: number, max: number): void {
    this.write("");
    this.write(
      color(ANSI.bold, "━━━ ralph iteration ") +
        color(ANSI.bold + ANSI.cyan, `${iter}/${max}`) +
        color(ANSI.bold, " ━━━") +
        color(ANSI.dim, `  ${this.now()}`),
    );
  }

  /** A single key/value detail line under the header. */
  detail(key: string, value: string): void {
    const k = key.padEnd(12);
    this.write("  " + color(ANSI.dim, k) + value);
  }

  /**
   * Loop stage transition. The stage name is the canonical event id
   * ("agent.spawn", "agent.exit", "tests.run", "git.commit", "iteration.done").
   */
  stage(name: string, detail?: string): void {
    const arrow = color(ANSI.cyan, "  ↳");
    const tag = color(ANSI.bold, name.padEnd(14));
    this.write(`${arrow} ${tag} ${detail ?? ""}`);
  }

  done(detail?: string): void {
    this.write(color(ANSI.green, "  ✓ done") + (detail ? "  " + color(ANSI.dim, detail) : ""));
  }

  info(msg: string): void {
    this.write(color(ANSI.dim, "  · ") + msg);
  }

  warn(msg: string): void {
    this.write(color(ANSI.yellow, "  ! ") + msg);
  }

  error(msg: string): void {
    this.write(color(ANSI.red, "  ✗ ") + msg);
  }

  rateLimit(until: Date | null, reason: string, sleepMs: number): void {
    const human = humanDuration(sleepMs);
    const target = until ? formatIsoWithLocal(until) : `now + ${human}`;
    this.write(
      color(ANSI.yellow, "  ⏸ rate-limited") +
        ` until ${color(ANSI.bold, target)} ` +
        color(ANSI.dim, `(sleeping ${human})`) +
        color(ANSI.dim, ` — ${reason}`),
    );
  }

  /**
   * Called once per line of agent stdout/stderr. Only prints under verbose.
   */
  streamAgentLine = (stream: "stdout" | "stderr", line: string): void => {
    if (!this.opts.verbose) return;
    const tag = stream === "stderr" ? color(ANSI.red, "[err]") : color(ANSI.dim, "[claude]");
    this.write(`    ${tag} ${line}`);
  };
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad2 = (n: number): string => n.toString().padStart(2, "0");
  if (d > 0) return `${d}d${pad2(h)}h${pad2(m)}m${pad2(s)}s`;
  if (h > 0) return `${h}h${pad2(m)}m${pad2(s)}s`;
  if (m > 0) return `${m}m${pad2(s)}s`;
  return `${s}s`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Render a Date both as ISO (canonical, sortable) and as local-time so the
 * operator doesn't have to do the timezone math at 02:13 in the morning.
 */
export function formatIsoWithLocal(d: Date): string {
  const local = d.toLocaleString(undefined, { hour12: false });
  return `${d.toISOString()} (${local})`;
}
