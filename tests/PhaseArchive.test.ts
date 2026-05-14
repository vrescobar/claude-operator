import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { archiveClosedPhases } from "../src/PhaseArchive.js";

function makeWorkspace(): { tasksFile: string; archiveDir: string } {
  const root = mkdtempSync(resolve(tmpdir(), "ralph-phase-archive-"));
  const tasksFile = resolve(root, "tasks.md");
  const archiveDir = resolve(root, "archive");
  return { tasksFile, archiveDir };
}

describe("archiveClosedPhases", () => {
  let ws: { tasksFile: string; archiveDir: string };

  beforeEach(() => {
    ws = makeWorkspace();
  });

  test("no-op when tasks.md is missing", () => {
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(0);
  });

  test("no-op when there are no `## Phase` headings", () => {
    writeFileSync(ws.tasksFile, "# Ralph Task List\n\n- [ ] **1** Bootstrap\n");
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(0);
    const after = readFileSync(ws.tasksFile, "utf8");
    expect(after).toContain("Bootstrap");
  });

  test("no-op when only the last phase exists (even if closed)", () => {
    const body =
      "# Ralph Task List\n\n## Phase 1 — Final\n\n- [x] **1** Done\n- [x] **2** Done\n";
    writeFileSync(ws.tasksFile, body);
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(0);
    expect(readFileSync(ws.tasksFile, "utf8")).toBe(body);
  });

  test("archives a closed phase when a later phase exists", () => {
    const body =
      "# Ralph Task List\n\n" +
      "## Phase 1 — Bootstrap\n\n- [x] **1** Init\n- [x] **2** Wire\n\n" +
      "## Phase 2 — Current\n\n- [ ] **3** Implement feature X\n";
    writeFileSync(ws.tasksFile, body);
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(1);
    expect(r.archivedHeadings).toEqual(["## Phase 1 — Bootstrap"]);
    expect(existsSync(r.archivePath!)).toBe(true);

    const after = readFileSync(ws.tasksFile, "utf8");
    expect(after).toContain("# Ralph Task List");
    expect(after).toContain("## Phase 2 — Current");
    expect(after).toContain("[ ] **3** Implement feature X");
    expect(after).not.toContain("## Phase 1");

    const archived = readFileSync(r.archivePath!, "utf8");
    expect(archived).toContain("# Archived phases");
    expect(archived).toContain("## Phase 1 — Bootstrap");
    expect(archived).toContain("**2** Wire");
  });

  test("does not archive phases with open `[ ]` or blocked `[!]` tasks", () => {
    const body =
      "# Header\n\n" +
      "## Phase 1 — Half-done\n\n- [x] **1** Done\n- [ ] **2** Pending\n\n" +
      "## Phase 2 — Blocked\n\n- [!] **3** Stuck\n\n" +
      "## Phase 3 — Active\n\n- [ ] **4** Work\n";
    writeFileSync(ws.tasksFile, body);
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(0);
  });

  test("archives multiple closed phases in order, preserves the active phase", () => {
    const body =
      "# Header\n\nIntro paragraph.\n\n" +
      "## Phase 1 — Done\n\n- [x] **1** A\n\n" +
      "## Phase 2 — Also done\n\n- [x] **2** B\n\n" +
      "## Phase 3 — Active\n\n- [ ] **3** Working\n";
    writeFileSync(ws.tasksFile, body);
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(2);
    expect(r.archivedHeadings).toEqual([
      "## Phase 1 — Done",
      "## Phase 2 — Also done",
    ]);

    const after = readFileSync(ws.tasksFile, "utf8");
    expect(after).toContain("Intro paragraph.");
    expect(after).toContain("## Phase 3 — Active");
    expect(after).not.toContain("## Phase 1");
    expect(after).not.toContain("## Phase 2");

    const archived = readFileSync(r.archivePath!, "utf8");
    expect(archived).toContain("## Phase 1 — Done");
    expect(archived).toContain("## Phase 2 — Also done");
  });

  test("appends to an existing archive file rather than overwriting", () => {
    const body =
      "# Header\n\n" +
      "## Phase 1 — Done\n\n- [x] **1** A\n\n" +
      "## Phase 2 — Active\n\n- [ ] **2** B\n";
    writeFileSync(ws.tasksFile, body);
    mkdirSync(ws.archiveDir, { recursive: true });
    const existingArchive = resolve(ws.archiveDir, "tasks-phases-archived.md");
    writeFileSync(existingArchive, "# Archived phases\n\nPRIOR_CONTENT\n");

    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(1);
    const archived = readFileSync(existingArchive, "utf8");
    expect(archived).toContain("PRIOR_CONTENT");
    expect(archived).toContain("## Phase 1 — Done");
  });

  test("creates the archive dir when it doesn't exist", () => {
    const body =
      "# Header\n\n" +
      "## Phase 1 — Done\n\n- [x] **1** A\n\n" +
      "## Phase 2 — Active\n\n- [ ] **2** B\n";
    writeFileSync(ws.tasksFile, body);
    expect(existsSync(ws.archiveDir)).toBe(false);
    const r = archiveClosedPhases(ws);
    expect(r.archivedCount).toBe(1);
    expect(existsSync(ws.archiveDir)).toBe(true);
  });

  test("preserves the file header (everything above first `## Phase`) byte-for-byte", () => {
    const header =
      "# Ralph Task List\n\nTasks ordered MVP-simple → complex.\nLine 2 of header.\n\n";
    const body =
      header +
      "## Phase 1 — Done\n\n- [x] **1** A\n\n" +
      "## Phase 2 — Active\n\n- [ ] **2** B\n";
    writeFileSync(ws.tasksFile, body);
    archiveClosedPhases(ws);
    const after = readFileSync(ws.tasksFile, "utf8");
    expect(after.startsWith(header)).toBe(true);
  });

  test("idempotent: running twice does not duplicate the archive", () => {
    const body =
      "# Header\n\n" +
      "## Phase 1 — Done\n\n- [x] **1** A\n\n" +
      "## Phase 2 — Active\n\n- [ ] **2** B\n";
    writeFileSync(ws.tasksFile, body);

    const r1 = archiveClosedPhases(ws);
    expect(r1.archivedCount).toBe(1);

    const r2 = archiveClosedPhases(ws);
    expect(r2.archivedCount).toBe(0); // no closed phases left
  });
});
