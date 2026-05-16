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
