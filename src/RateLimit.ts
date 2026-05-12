/**
 * Rate-limit detection over the `claude` subprocess output.
 *
 * Pattern table (case-insensitive, in priority order):
 *   1. Explicit reset time, e.g. "Your usage limit will reset at 2026-05-09T15:00:00Z"
 *      → returns `{ until: <that Date>, reason }`.
 *   2. Relative retry hint, e.g. "rate limit … retry after 47m12s"
 *      → returns `{ until: now + delta, reason }`.
 *   3. Generic limit text ("quota exceeded", "usage limit reached", "rate limit
 *      exceeded") with no time → returns `{ until: null, reason }` and the loop
 *      uses `Config.rateLimitFallbackMs`.
 *   4. No match → `null`.
 *
 * `AgentProcess` calls `detect()` on the combined stdout+stderr after the
 * process exits and stamps the result on `AgentResult.rateLimit`.
 */

import type { RateLimitInfo } from "./types.js";

interface Pattern {
  /** Regex run over the combined output. */
  re: RegExp;
  /** Build the result from a successful match. May return null to skip. */
  build: (m: RegExpMatchArray) => RateLimitInfo | null;
}

// ── Pattern 1: explicit reset timestamp ─────────────────────────────────────
const RESET_AT_PATTERNS: Pattern[] = [
  {
    re: /(?:reset|resume|available again|try again)[^\n]{0,40}?(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i,
    build: (m) => {
      const d = parseIsoDate(m[1]!);
      if (!d) return null;
      return { until: d, reason: `reset at ${m[1]}` };
    },
  },
  {
    // unix-epoch seconds, e.g. "X-RateLimit-Reset: 1736539200"
    re: /reset[^\n]{0,30}?(\d{10,13})/i,
    build: (m) => {
      const n = Number.parseInt(m[1]!, 10);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return null;
      return { until: d, reason: `reset epoch ${m[1]}` };
    },
  },
];

// ── Pattern 2: relative retry-after ─────────────────────────────────────────
const RETRY_AFTER_PATTERNS: Pattern[] = [
  {
    re: /(?:retry after|try again in|wait)\s+((?:\d+\s*[hms]\s*)+)/i,
    build: (m) => {
      const ms = parseDuration(m[1]!);
      if (ms === null) return null;
      return { until: new Date(Date.now() + ms), reason: `retry after ${m[1]!.trim()}` };
    },
  },
  {
    // bare seconds: "Retry-After: 3600"
    re: /retry-after:\s*(\d+)/i,
    build: (m) => {
      const sec = Number.parseInt(m[1]!, 10);
      return { until: new Date(Date.now() + sec * 1000), reason: `retry after ${sec}s` };
    },
  },
];

// ── Pattern 3: generic, no time ─────────────────────────────────────────────
const GENERIC_LIMIT_RE =
  /(rate limit (?:exceeded|reached|hit)|usage limit (?:exceeded|reached)|quota (?:exceeded|reached)|429 (?:too many requests|rate)|too many requests)/i;

/**
 * How many trailing lines of the agent output we feed into the detector.
 * Real rate-limit messages from claude land near the end of the stream,
 * whereas an agent reading source / tests can mention "rate limit" anywhere
 * in the *middle* of its output. Capping the scan to the tail eliminates
 * false-positives from the body of a long agent transcript.
 */
const RATE_LIMIT_TAIL_LINES = 200;

/**
 * Run the pattern table against the tail of stdout / stderr. Code blocks
 * (lines fenced by ```) are stripped before scanning so that an agent that
 * writes a markdown explanation of rate-limit handling does not accidentally
 * trigger detection.
 *
 * The caller (AgentProcess) is also expected to invoke this only when the
 * process exited non-zero or hit its timeout; a successful agent run can
 * mention "rate limit" all it wants in its output without consequence.
 */
export function detectRateLimit(output: string): RateLimitInfo | null {
  const sanitised = sanitiseForRateLimitScan(output);

  // 1. explicit reset
  for (const p of RESET_AT_PATTERNS) {
    const m = p.re.exec(sanitised);
    if (m) {
      const r = p.build(m);
      if (r) return r;
    }
  }
  // 2. relative
  for (const p of RETRY_AFTER_PATTERNS) {
    const m = p.re.exec(sanitised);
    if (m) {
      const r = p.build(m);
      if (r) return r;
    }
  }
  // 3. generic — no time
  const g = GENERIC_LIMIT_RE.exec(sanitised);
  if (g) {
    return { until: null, reason: g[0]!.toLowerCase() };
  }
  return null;
}

function sanitiseForRateLimitScan(output: string): string {
  const lines = output.split("\n");
  // 1. Drop content inside fenced code blocks (```...```).
  const stripped: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (/^[\t ]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) stripped.push(line);
  }
  // 2. Keep only the last N lines.
  const tail = stripped.slice(-RATE_LIMIT_TAIL_LINES);
  return tail.join("\n");
}

/**
 * Floor on the actual sleep that fires when a rate-limit is detected. Even
 * with a past `until` and zero jitter we want a non-trivial pause so we don't
 * hot-spin against the upstream API. 10s is short enough to keep tests quick
 * and long enough that the loop never busy-loops.
 */
const MIN_RATE_LIMIT_SLEEP_MS = 10_000;

/**
 * Compute the actual sleep target.
 *
 * - When `info.until` is non-null, that timestamp is used verbatim — the
 *   API already told us when to come back, so we trust it.
 * - When `info.until` is null (generic "rate limit" text with no time), we
 *   fall back to an exponential curve `min(fallbackCapMs, fallbackBaseMs *
 *   3^(consecutiveHits-1))`. The first hit waits `fallbackBaseMs`; each
 *   consecutive hit on the *same* task triples that, capped at
 *   `fallbackCapMs`. This avoids both extremes — a flat 5-min retry that
 *   hammers a budget-style limit, and a flat 1-hour wait when the limit
 *   would have lifted in 5 min.
 *
 * A small jitter is added to avoid thundering-herd retries against the API
 * at the exact reset second.
 *
 * The result is clamped to at least `minSleepMs` from `now` — this is the
 * soft-loop guard against `until` already in the past combined with
 * `jitterMs=0`. Tests can pass `minSleepMs=0` explicitly to bypass the
 * floor when verifying rate-limit handling without slowing the test suite.
 */
export function computeSleepUntil(
  info: RateLimitInfo,
  fallbackBaseMs: number,
  jitterMs: number,
  now: () => Date = () => new Date(),
  minSleepMs: number = MIN_RATE_LIMIT_SLEEP_MS,
  consecutiveHits: number = 1,
  fallbackCapMs: number = 60 * 60 * 1000,
): { target: Date; sleepMs: number } {
  const baseline = now().getTime();
  let targetMs: number;
  if (info.until) {
    targetMs = info.until.getTime();
  } else {
    const n = Math.max(1, consecutiveHits);
    const grown = fallbackBaseMs * Math.pow(3, n - 1);
    const fallback = Math.min(fallbackCapMs, grown);
    targetMs = baseline + fallback;
  }
  const jitter = Math.floor(Math.random() * Math.max(0, jitterMs));
  const floor = baseline + Math.max(0, minSleepMs);
  const finalMs = Math.max(baseline, targetMs, floor) + jitter;
  return { target: new Date(finalMs), sleepMs: finalMs - baseline };
}

/** Sleep until the given time using a single setTimeout. Caps each timer at ~24d. */
export async function sleepUntil(target: Date, signal?: AbortSignal): Promise<void> {
  while (true) {
    const remaining = target.getTime() - Date.now();
    if (remaining <= 0) return;
    const slice = Math.min(remaining, 2_000_000_000);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, slice);
      const onAbort = (): void => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      if (signal) {
        if (signal.aborted) {
          clearTimeout(t);
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function parseIsoDate(raw: string): Date | null {
  // Accept "2026-05-09 15:00" by upgrading the space to T.
  const fixed = raw.includes("T") ? raw : raw.replace(" ", "T");
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDuration(raw: string): number | null {
  const re = /(\d+)\s*([hms])/gi;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matched = true;
    const n = Number.parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    if (unit === "h") total += n * 3600;
    else if (unit === "m") total += n * 60;
    else if (unit === "s") total += n;
  }
  return matched ? total * 1000 : null;
}
