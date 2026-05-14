/**
 * Helpers for `ralph/progress.md`.
 *
 * The agent writes `TASK_COMPLETE` on its own line at the bottom of this
 * file when the entire phase is done. Detection must be anchored — the
 * marker can also appear in prose, code blocks and commit-message context
 * elsewhere in the file, and we must NOT halt on those false positives.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic.js";
import { formatLocal, localFileStamp } from "./time.js";

/**
 * Returns true iff the file contains a line whose only content (modulo
 * surrounding whitespace) is the stop marker.
 */
export function hasTaskComplete(
  path: string,
  marker = "TASK_COMPLETE",
): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  // Mirrors the grep -E '^[[:space:]]*MARKER[[:space:]]*$' from loop.sh.
  const re = new RegExp(`^\\s*${escapeRe(marker)}\\s*$`, "m");
  return re.test(content);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rotate `progress.md` when it grows beyond `maxBytes`. The current file is
 * archived to `<archiveDir>/progress-<ts>.md` (gitignored) and replaced with a
 * stub that contains the trailing `tailKeepBytes` (so the agent still sees
 * the most recent decisions). No-op when the file is below the threshold or
 * the archive path can't be created.
 *
 * When `archiveDir` is omitted, archives land next to `path` (legacy
 * behaviour) under the name `progress.archive-<ts>.md`.
 *
 * Returns the archive path when a rotation happened, or null otherwise.
 */
export function rotateProgressIfTooLarge(
  path: string,
  maxBytes: number,
  tailKeepBytes: number,
  now: () => Date = () => new Date(),
  archiveDir?: string,
): string | null {
  if (maxBytes <= 0) return null;
  if (!existsSync(path)) return null;
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  if (size <= maxBytes) return null;

  // Local-time stamp for the archive filename so operators recognise it at
  // a glance; matches the convention used by per-iteration log files.
  const ts = localFileStamp(now());
  const archive = archiveDir
    ? resolve(archiveDir, `progress-${ts}.md`)
    : resolve(dirname(path), `progress.archive-${ts}.md`);
  const original = readFileSync(path, "utf8");
  const tail = tailKeepBytes > 0 ? original.slice(-tailKeepBytes) : "";
  const stub =
    `# progress (rotated ${formatLocal(now())})\n\n` +
    `> Earlier entries archived to \`${archive.split("/").pop()}\` ` +
    `(${size} bytes). Showing tail only.\n\n` +
    tail;

  if (archiveDir) {
    try {
      mkdirSync(archiveDir, { recursive: true });
    } catch {
      return null;
    }
  }
  try {
    renameSync(path, archive);
  } catch {
    // Best effort — if rename fails, leave the original alone.
    return null;
  }
  atomicWriteFileSync(path, stub);
  return archive;
}
