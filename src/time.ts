/**
 * Time formatting helpers — operator-facing output in local time.
 *
 * **Canonical state** (state.json, metrics.jsonl, git stash refs, log
 * filenames) stays ISO-8601 UTC. Those are sortable, comparable, and parsed
 * by tooling — never displayed raw to the operator.
 *
 * **Operator-facing output** (logger headers, rate-limit banners, rotation
 * stub headers, progress notes, archive listings) goes through these
 * helpers and renders in the host's local timezone with the offset
 * included so a copy-paste of the line is unambiguous.
 *
 * The TZ name comes from `Intl.DateTimeFormat().resolvedOptions().timeZone`
 * (e.g. "Europe/Berlin") on the host running the loop. The offset string
 * comes from a positional `Intl.DateTimeFormat` with `timeZoneName:
 * "shortOffset"`.
 */

let cachedTzName: string | null = null;

function resolvedTimeZone(): string {
  if (cachedTzName !== null) return cachedTzName;
  try {
    cachedTzName = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    cachedTzName = "UTC";
  }
  return cachedTzName;
}

/** "GMT+2" / "GMT-5" / "UTC" — short offset for the given instant. */
export function shortOffset(d: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: "shortOffset",
    }).formatToParts(d);
    const tz = parts.find((p) => p.type === "timeZoneName")?.value;
    return tz ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** "HH:MM:SS" in local time. Used by `Logger.now()` for iteration headers. */
export function nowLocalHms(d: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * "YYYY-MM-DD HH:MM:SS GMT+2" — human-readable local timestamp.
 *
 * Use this in any line that's logged to stdout or appended to progress.md.
 * Sortable within a single timezone; for cross-zone sorting use
 * `formatIsoWithLocal` instead.
 */
export function formatLocal(d: Date): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
    shortOffset(d)
  );
}

/**
 * "<ISO-UTC> (<local YYYY-MM-DD HH:MM:SS GMT+X>)" — useful when the line
 * may be machine-parsed AND read by humans. Examples: rate-limit banners
 * that go into both progress.md and the operator's terminal.
 */
export function formatIsoWithLocal(d: Date): string {
  return `${d.toISOString()} (${formatLocal(d)})`;
}

/** "Europe/Berlin" — the IANA TZ name the host is configured to use. */
export function localTimeZoneName(): string {
  return resolvedTimeZone();
}

/**
 * Local-time slug suitable for archive filenames:
 * "YYYYMMDD-HHMMSS" (no separators that confuse filesystems, no offset).
 * Sortable lexically within a single timezone. For cross-zone sorting use
 * the ISO-UTC string instead.
 */
export function localFileStamp(d: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
