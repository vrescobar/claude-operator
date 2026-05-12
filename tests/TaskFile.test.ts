import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  findNextOpenTask,
  isTaskBlocked,
  isTaskMarkedDone,
  markTaskBlocked,
  markTaskDone,
  revertTaskToPending,
} from "../src/TaskFile.js";

const FIXTURE = `## Phase 1
- [x] **01** Done one
- [x] **02** Done two

## Phase 2
- [ ] **40** First open
- [ ] **41** Second open
  - this sub-bullet must survive untouched
- [ ] **42** Third open
`;

let path: string;

beforeEach(() => {
  const dir = mkdtempSync(resolve(tmpdir(), "ralph-tasks-"));
  path = resolve(dir, "tasks.md");
  writeFileSync(path, FIXTURE);
});

describe("TaskFile", () => {
  test("findNextOpenTask returns the first [ ] entry", () => {
    const t = findNextOpenTask(path);
    expect(t).not.toBeNull();
    expect(t?.id).toBe("40");
    expect(t?.title).toBe("First open");
  });

  test("returns null when there are no open tasks", () => {
    writeFileSync(path, "- [x] **01** all done\n");
    expect(findNextOpenTask(path)).toBeNull();
  });

  test("markTaskDone flips [ ] → [x] for the right id and leaves others untouched", () => {
    markTaskDone(path, "40");
    const after = readFileSync(path, "utf8");
    expect(after).toContain("- [x] **40** First open");
    expect(after).toContain("- [ ] **41** Second open");
    expect(after).toContain("  - this sub-bullet must survive untouched");
  });

  test("revertTaskToPending undoes markTaskDone", () => {
    markTaskDone(path, "40");
    revertTaskToPending(path, "40");
    expect(readFileSync(path, "utf8")).toBe(FIXTURE);
  });

  test("isTaskMarkedDone reports the correct status", () => {
    expect(isTaskMarkedDone(path, "01")).toBe(true);
    expect(isTaskMarkedDone(path, "40")).toBe(false);
    markTaskDone(path, "40");
    expect(isTaskMarkedDone(path, "40")).toBe(true);
  });

  test("markTaskDone is a no-op when the id does not exist", () => {
    markTaskDone(path, "999");
    expect(readFileSync(path, "utf8")).toBe(FIXTURE);
  });

  test("markTaskBlocked flips [ ] → [!] and skips the task in findNextOpenTask", () => {
    expect(markTaskBlocked(path, "40")).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("- [!] **40** First open");
    expect(isTaskBlocked(path, "40")).toBe(true);
    // Next open task is now 41.
    expect(findNextOpenTask(path)?.id).toBe("41");
  });

  test("findNextOpenTask tolerates whitespace variants and missing bold markers", () => {
    writeFileSync(
      path,
      [
        "- [ ]  **77** double-space title",
        "- [ ] 78 plain id no bold",
        "  - [ ] **80** indented bullet should also match",
        "",
      ].join("\n"),
    );
    expect(findNextOpenTask(path)?.id).toBe("77");
  });

  test("isTaskMarkedDone tolerates uppercase X and whitespace variants", () => {
    writeFileSync(path, "- [X]  **42**  Done with capital X\n");
    expect(isTaskMarkedDone(path, "42")).toBe(true);
  });
});
