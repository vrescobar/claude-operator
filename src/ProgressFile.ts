/**
 * Helpers for `ralph/progress.md`.
 *
 * The agent writes `TASK_COMPLETE` on its own line at the bottom of this
 * file when the entire phase is done. Detection must be anchored — the
 * marker can also appear in prose, code blocks and commit-message context
 * elsewhere in the file, and we must NOT halt on those false positives.
 */

import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic.js";

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
 * archived to `progress.archive-<ts>.md` (gitignored) and replaced with a
 * stub that contains the trailing `tailKeepBytes` (so the agent still sees
 * the most recent decisions). No-op when the file is below the threshold or
 * the archive path can't be created.
 *
 * Returns the archive path when a rotation happened, or null otherwise.
 */
export function rotateProgressIfTooLarge(
  path: string,
  maxBytes: number,
  tailKeepBytes: number,
  now: () => Date = () => new Date(),
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

  const ts = now()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "-")
    .replace("Z", "");
  const archive = resolve(dirname(path), `progress.archive-${ts}.md`);
  const original = readFileSync(path, "utf8");
  const tail = tailKeepBytes > 0 ? original.slice(-tailKeepBytes) : "";
  const stub =
    `# progress (rotated ${now().toISOString()})\n\n` +
    `> Earlier entries archived to \`${archive.split("/").pop()}\` ` +
    `(${size} bytes). Showing tail only.\n\n` +
    tail;

  try {
    renameSync(path, archive);
  } catch {
    // Best effort — if rename fails, leave the original alone.
    return null;
  }
  atomicWriteFileSync(path, stub);
  return archive;
}
