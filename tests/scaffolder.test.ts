import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runInit } from "../src/scaffolder.js";

describe("runInit", () => {
  test("creates the workspace dir and copies all skeleton files", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ralph-init-"));
    const result = runInit({ cwd });

    expect(result.workspaceDir).toBe(resolve(cwd, ".ralphloop"));
    expect(existsSync(result.workspaceDir)).toBe(true);

    for (const name of ["tasks.md", "progress.md", "config.yaml", "prompt.md"]) {
      const p = resolve(result.workspaceDir, name);
      expect(existsSync(p)).toBe(true);
      expect(result.created).toContain(p);
    }

    expect(result.skipped).toHaveLength(0);
    expect(result.gitignoreSuggestion).toContain(".ralphloop/state.json");
    expect(result.gitignoreSuggestion).toContain(".ralphloop/logs/");
  });

  test("is idempotent — existing files are preserved", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ralph-init-idemp-"));
    runInit({ cwd });

    // User edits tasks.md after init
    const tasksPath = resolve(cwd, ".ralphloop", "tasks.md");
    writeFileSync(tasksPath, "## My phase\n- [ ] **42** Custom task\n");

    const result = runInit({ cwd });
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toContain(tasksPath);

    expect(readFileSync(tasksPath, "utf8")).toContain("Custom task");
  });

  test("createGoalStub creates GOAL.md when missing", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ralph-init-goal-"));
    const result = runInit({ cwd, createGoalStub: true });

    const goalPath = resolve(cwd, "GOAL.md");
    expect(existsSync(goalPath)).toBe(true);
    expect(result.created).toContain(goalPath);
  });

  test("createGoalStub does not overwrite an existing GOAL.md", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ralph-init-goal-existing-"));
    const goalPath = resolve(cwd, "GOAL.md");
    writeFileSync(goalPath, "# my real goal\n");

    runInit({ cwd, createGoalStub: true });
    expect(readFileSync(goalPath, "utf8")).toBe("# my real goal\n");
  });

  test("custom workspace name", () => {
    const cwd = mkdtempSync(resolve(tmpdir(), "ralph-init-ws-"));
    const result = runInit({ cwd, workspace: "loop-state" });
    expect(result.workspaceDir).toBe(resolve(cwd, "loop-state"));
    expect(existsSync(resolve(cwd, "loop-state", "tasks.md"))).toBe(true);
  });
});
