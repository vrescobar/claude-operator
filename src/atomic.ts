/**
 * Crash-safe file writes.
 *
 * `writeFileSync` truncates and writes in place; if ralph dies between
 * `truncate` and the last `write`, the file ends up half-written. For
 * `tasks.md` and `progress.md` (load-bearing for the loop's control flow on
 * restart) that's catastrophic. The helper here writes to `<path>.tmp` first
 * and then `renameSync` — which is atomic on POSIX file systems.
 */

import { renameSync, writeFileSync } from "node:fs";

export function atomicWriteFileSync(path: string, content: string | Buffer): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, { encoding: typeof content === "string" ? "utf8" : undefined });
  renameSync(tmp, path);
}
