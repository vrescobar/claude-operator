/**
 * Auto-archive closed phases from `tasks.md`.
 *
 * Each iteration of the loop reads `tasks.md` and `progress.md` end-to-end
 * to find the next `[ ]` task. Once dozens of phases have been completed,
 * those files balloon into tens of kilobytes of `[x]` history — context
 * the agent doesn't need to make a decision about the active phase, but
 * which still gets tokenised on every iteration.
 *
 * This module rotates **closed** phases (every `[ ]`/`[!]` line resolved)
 * out to `<archiveDir>/tasks-phases-archived.md`, leaving only the file
 * header + currently-open phase(s) in `tasks.md`. Triggered automatically
 * at the start of each `runLoop` call when the config flag
 * `autoArchiveClosedPhases` is on (default).
 *
 * Safety guarantees:
 *
 * - We **always preserve the last `## Phase` heading** even if all its tasks
 *   are `[x]`. Operators want to see "phase 24 just finished, write phase
 *   25 next" rather than discover an empty `tasks.md`.
 * - File header (everything above the first `## Phase`) is preserved
 *   byte-for-byte.
 * - Archive writes are append-only: existing archive content is kept and
 *   the new phases land at the bottom with a date-stamped separator.
 * - On any I/O failure we abort the rotation and leave the source file
 *   untouched. Auto-archive is informational, never load-bearing.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWriteFileSync } from "./atomic.js";
import { formatLocal } from "./time.js";

const PHASE_HEADING_RE = /^##\s+Phase\b.*$/;
const OPEN_TASK_RE = /^[\t ]*-[\t ]+\[\s\][\t ]+/;
const BLOCKED_TASK_RE = /^[\t ]*-[\t ]+\[!\][\t ]+/;

interface PhaseSection {
  /** 0-based start line (the `## Phase` heading itself). */
  start: number;
  /** 0-based exclusive end line (first line of the next phase, or EOF). */
  end: number;
  /** The heading line, e.g. "## Phase 23 — Dashboard usability hardening". */
  heading: string;
  /** True iff every checkbox in the section is `[x]`. */
  closed: boolean;
}

/** Split a tasks.md body into header + phase sections. */
function parsePhases(lines: string[]): { headerEnd: number; phases: PhaseSection[] } {
  const phaseStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (PHASE_HEADING_RE.test(lines[i]!)) phaseStarts.push(i);
  }
  if (phaseStarts.length === 0) {
    return { headerEnd: lines.length, phases: [] };
  }
  const phases: PhaseSection[] = [];
  for (let i = 0; i < phaseStarts.length; i++) {
    const start = phaseStarts[i]!;
    const end = i + 1 < phaseStarts.length ? phaseStarts[i + 1]! : lines.length;
    let closed = true;
    for (let j = start; j < end; j++) {
      const ln = lines[j]!;
      if (OPEN_TASK_RE.test(ln) || BLOCKED_TASK_RE.test(ln)) {
        closed = false;
        break;
      }
    }
    phases.push({ start, end, heading: lines[start]!, closed });
  }
  return { headerEnd: phaseStarts[0]!, phases };
}

export interface ArchiveResult {
  /** Number of phases moved to the archive on this call. 0 = no-op. */
  archivedCount: number;
  /** Absolute path of the archive file, when something was archived. */
  archivePath?: string;
  /** Phase headings that were moved (for logging). */
  archivedHeadings: string[];
}

/**
 * Detect and archive closed phases. No-op when there's nothing to archive
 * or when archiving would leave `tasks.md` without any phase heading.
 */
export function archiveClosedPhases(opts: {
  tasksFile: string;
  archiveDir: string;
  now?: () => Date;
}): ArchiveResult {
  const now = opts.now ?? (() => new Date());
  const empty: ArchiveResult = { archivedCount: 0, archivedHeadings: [] };

  if (!existsSync(opts.tasksFile)) return empty;

  let raw: string;
  try {
    raw = readFileSync(opts.tasksFile, "utf8");
  } catch {
    return empty;
  }

  // Preserve the trailing newline (or absence thereof) byte-for-byte.
  const trailingNl = raw.endsWith("\n");
  const lines = raw.split("\n");
  // split() on "\n" leaves an empty trailing element when the input ends
  // with \n. Strip it so phase parsing isn't confused, then re-add at the
  // end with the same trailingNl decision.
  if (trailingNl) lines.pop();

  const { headerEnd, phases } = parsePhases(lines);
  if (phases.length === 0) return empty;

  // Find the *last* closed phase index. Anything before it that's also
  // closed gets archived too. We keep the very last phase heading no matter
  // what (operators want to see "phase X just finished" until they write
  // phase X+1).
  const lastIdx = phases.length - 1;
  const archivable: PhaseSection[] = [];
  for (let i = 0; i < phases.length; i++) {
    if (i === lastIdx) continue; // never archive the trailing phase
    if (phases[i]!.closed) archivable.push(phases[i]!);
  }
  if (archivable.length === 0) return empty;

  const archivePath = resolve(opts.archiveDir, "tasks-phases-archived.md");
  try {
    mkdirSync(opts.archiveDir, { recursive: true });
  } catch {
    return empty;
  }

  // Compose the archive payload: a date-stamped separator + each phase.
  const stamp = formatLocal(now());
  const archiveChunks: string[] = [`\n<!-- archived ${stamp} -->\n`];
  for (const ph of archivable) {
    archiveChunks.push(lines.slice(ph.start, ph.end).join("\n"));
    if (!archiveChunks[archiveChunks.length - 1]!.endsWith("\n")) {
      archiveChunks.push("\n");
    }
  }
  const archiveText = archiveChunks.join("");

  // Compose the new tasks.md body: header + non-archived phases.
  const archivedSet = new Set(archivable.map((p) => p.start));
  const keptLines: string[] = lines.slice(0, headerEnd);
  for (const ph of phases) {
    if (archivedSet.has(ph.start)) continue;
    keptLines.push(...lines.slice(ph.start, ph.end));
  }
  // Strip any consecutive trailing empty lines from the kept body so we
  // don't accumulate blank lines on each successive archive call.
  while (keptLines.length > 1 && keptLines[keptLines.length - 1] === "") {
    keptLines.pop();
  }
  const newBody = keptLines.join("\n") + (trailingNl ? "\n" : "");

  // Best-effort append to archive, then atomic-rewrite the tasks file.
  try {
    if (existsSync(archivePath)) {
      appendFileSync(archivePath, archiveText);
    } else {
      writeFileSync(
        archivePath,
        `# Archived phases\n\n` +
          `> Phases auto-archived from \`tasks.md\` by ralphloop. ` +
          `Each section below was complete (all tasks \`[x]\`) at the ` +
          `time of archiving. Read top-to-bottom for chronological order.\n` +
          archiveText,
      );
    }
  } catch {
    return empty;
  }
  try {
    atomicWriteFileSync(opts.tasksFile, newBody);
  } catch {
    // tasks.md unchanged on failure — archive may have a partial write but
    // that's recoverable manually. The loop continues without the rotation.
    return empty;
  }

  return {
    archivedCount: archivable.length,
    archivePath,
    archivedHeadings: archivable.map((p) => p.heading),
  };
}
