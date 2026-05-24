/**
 * Pure functions over `ralph/tasks.md`.
 *
 * The loop reads the first `- [ ] **NN** <title>` line as the next task,
 * marks it `[x]` after the agent succeeds, and reverts it back to `[ ]`
 * on test failure or no-changes retry. These helpers preserve every other
 * line of the file (formatting, indentation, trailing whitespace) byte for
 * byte.
 */

import { readFileSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic.js";
import type { TaskRef } from "./types.js";

// Tolerant of leading whitespace, multiple inner spaces / tabs, and the bold
// (`**…**`) markers being absent. The canonical form is still
// `- [ ] **NN** title`, but agents and operators sometimes drift slightly and
// we'd rather match than soft-loop on a "task-not-marked" outcome.
const OPEN_LINE_RE =
  /^[\t ]*-[\t ]+\[\s\][\t ]+(?:\*\*)?(\d+)(?:\*\*)?[\t ]+(.+?)\s*$/;
const DONE_LINE_RE =
  /^[\t ]*-[\t ]+\[x\][\t ]+(?:\*\*)?(\d+)(?:\*\*)?[\t ]+(.+?)\s*$/i;
const BLOCKED_LINE_RE =
  /^[\t ]*-[\t ]+\[!\][\t ]+(?:\*\*)?(\d+)(?:\*\*)?[\t ]+(.+?)\s*$/;
const PHASE_HEADING_RE = /^##\s+Phase\b.*$/;

/** Returns the first open task in the file, or null if none. */
export function findNextOpenTask(path: string): TaskRef | null {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_LINE_RE.exec(lines[i]!);
    if (m) {
      return { id: m[1]!, title: m[2]!.trim(), lineNumber: i + 1 };
    }
  }
  return null;
}

/** Returns true iff the file contains a `- [x] **<id>**` line for this id. */
export function isTaskMarkedDone(path: string, id: string): boolean {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.some((ln) => {
    const m = DONE_LINE_RE.exec(ln);
    return m !== null && m[1] === id;
  });
}

/** Flip `[x]` → `[ ]` for the task with this id. No-op if not found / already open. */
export function revertTaskToPending(path: string, id: string): void {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = DONE_LINE_RE.exec(lines[i]!);
    if (m && m[1] === id) {
      lines[i] = lines[i]!.replace(/\[x\]/i, "[ ]");
      mutated = true;
      break;
    }
  }
  if (mutated) atomicWriteFileSync(path, lines.join("\n"));
}

/** Flip `[ ]` → `[x]` for the task with this id. No-op if not found / already done. */
export function markTaskDone(path: string, id: string): void {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_LINE_RE.exec(lines[i]!);
    if (m && m[1] === id) {
      lines[i] = lines[i]!.replace(/\[\s\]/, "[x]");
      mutated = true;
      break;
    }
  }
  if (mutated) atomicWriteFileSync(path, lines.join("\n"));
}

/**
 * Flip `[ ]` → `[!]` for the task with this id and return the line index that
 * was mutated. The blocked sentinel is excluded from `findNextOpenTask`, so
 * the loop will skip the task on the next iteration without burning more
 * attempts on it.
 */
export function markTaskBlocked(path: string, id: string): boolean {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_LINE_RE.exec(lines[i]!);
    if (m && m[1] === id) {
      lines[i] = lines[i]!.replace(/\[\s\]/, "[!]");
      mutated = true;
      break;
    }
  }
  if (mutated) atomicWriteFileSync(path, lines.join("\n"));
  return mutated;
}

/** True iff the file has a `[!]` line for this task id. */
export function isTaskBlocked(path: string, id: string): boolean {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.some((ln) => {
    const m = BLOCKED_LINE_RE.exec(ln);
    return m !== null && m[1] === id;
  });
}

/**
 * Flip `[!]` → `[ ]` for the task with this id, requeueing it for the loop.
 * No-op if not found / not blocked. Returns true iff a line was mutated.
 * Used by `ralphloop retry-blocked`.
 */
export function reopenBlockedTask(path: string, id: string): boolean {
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = BLOCKED_LINE_RE.exec(lines[i]!);
    if (m && m[1] === id) {
      lines[i] = lines[i]!.replace("[!]", "[ ]");
      mutated = true;
      break;
    }
  }
  if (mutated) atomicWriteFileSync(path, lines.join("\n"));
  return mutated;
}

/** Ids of every `[!]` blocked task line, in file order. */
export function listBlockedTaskIds(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const ids: string[] = [];
  for (const ln of lines) {
    const m = BLOCKED_LINE_RE.exec(ln);
    if (m) ids.push(m[1]!);
  }
  return ids;
}

/** Count of `[ ]` (open, not blocked, not done) task lines in the file. */
export function countOpenTasks(path: string): number {
  const lines = readFileSync(path, "utf8").split("\n");
  let n = 0;
  for (const ln of lines) if (OPEN_LINE_RE.test(ln)) n++;
  return n;
}

/** A phase as a unit of work for the loop. */
export interface PhaseRef {
  /**
   * Stable identifier for the phase — the raw heading text (e.g.
   * `## Phase 3 — Auth refactor`). Used as the key in per-phase state so the
   * counter survives across iterations even as tasks move from `[ ]` to `[x]`.
   */
  id: string;
  /** Heading line including the leading `##` (rendered into the agent prompt). */
  heading: string;
  /** 1-based line number of the heading in tasks.md. */
  headingLineNumber: number;
  /** Open `[ ]` tasks belonging to this phase, in file order. */
  tasks: TaskRef[];
  /**
   * Raw markdown body of the phase (heading + every line up to but excluding
   * the next `## Phase` heading, with trailing blank lines trimmed). Handed
   * to the agent so prose between tasks (sub-bullets, design notes) is
   * preserved. Empty when the phase has only the heading.
   */
  body: string;
}

/**
 * First phase that still has at least one `[ ]` task, or null when every phase
 * is fully resolved (every checkbox is `[x]` or `[!]`).
 *
 * A "phase" is delimited by a `## Phase …` heading. Tasks above the first
 * heading are wrapped into a synthetic phase whose id/heading is empty so the
 * loop still works on tasks.md files without explicit phases — but those
 * authoring conventions are discouraged: ralphloop is phase-oriented now.
 */
export function findOpenPhase(path: string): PhaseRef | null {
  const lines = readFileSync(path, "utf8").split("\n");
  const headings: Array<{ index: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (PHASE_HEADING_RE.test(lines[i]!)) headings.push({ index: i, text: lines[i]! });
  }

  // No explicit `## Phase` headings — treat the whole file as one phase so the
  // loop still has something to chew on. Discouraged in practice; the
  // scaffolder always writes a heading.
  if (headings.length === 0) {
    const tasks = collectOpenTasks(lines, 0, lines.length);
    if (tasks.length === 0) return null;
    return {
      id: "(unphased)",
      heading: "",
      headingLineNumber: 0,
      tasks,
      body: trimTrailingBlanks(lines.slice(0, lines.length)).join("\n"),
    };
  }

  for (let h = 0; h < headings.length; h++) {
    const start = headings[h]!.index;
    const end = h + 1 < headings.length ? headings[h + 1]!.index : lines.length;
    const tasks = collectOpenTasks(lines, start, end);
    if (tasks.length === 0) continue;
    const body = trimTrailingBlanks(lines.slice(start, end)).join("\n");
    return {
      id: headings[h]!.text.trim(),
      heading: headings[h]!.text,
      headingLineNumber: start + 1,
      tasks,
      body,
    };
  }
  return null;
}

/**
 * Mark every task in the given list as `[!]` blocked. Used when a phase
 * exceeds its attempt limit — we block the still-open tasks so the loop can
 * move on to the next phase without spinning.
 */
export function markTasksBlocked(path: string, ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0;
  const ids$ = new Set(ids);
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = OPEN_LINE_RE.exec(lines[i]!);
    if (m && ids$.has(m[1]!)) {
      lines[i] = lines[i]!.replace(/\[\s\]/, "[!]");
      mutated++;
    }
  }
  if (mutated > 0) atomicWriteFileSync(path, lines.join("\n"));
  return mutated;
}

/**
 * Flip every `[x]` whose id is in `ids` back to `[ ]`. Used when a phase test
 * gate fails and the loop rolls the whole phase back to retry it from scratch.
 */
export function revertTasksToPending(path: string, ids: ReadonlyArray<string>): number {
  if (ids.length === 0) return 0;
  const ids$ = new Set(ids);
  const original = readFileSync(path, "utf8");
  const lines = original.split("\n");
  let mutated = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = DONE_LINE_RE.exec(lines[i]!);
    if (m && ids$.has(m[1]!)) {
      lines[i] = lines[i]!.replace(/\[x\]/i, "[ ]");
      mutated++;
    }
  }
  if (mutated > 0) atomicWriteFileSync(path, lines.join("\n"));
  return mutated;
}

function collectOpenTasks(lines: string[], start: number, end: number): TaskRef[] {
  const out: TaskRef[] = [];
  for (let i = start; i < end; i++) {
    const m = OPEN_LINE_RE.exec(lines[i]!);
    if (m) out.push({ id: m[1]!, title: m[2]!.trim(), lineNumber: i + 1 });
  }
  return out;
}

function trimTrailingBlanks(arr: string[]): string[] {
  const out = arr.slice();
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}
