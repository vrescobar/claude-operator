import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { hasTaskComplete, rotateProgressIfTooLarge } from "../src/ProgressFile.js";

function withFile(content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ralph-progress-"));
  const p = resolve(dir, "progress.md");
  writeFileSync(p, content);
  return p;
}

describe("ProgressFile.hasTaskComplete", () => {
  test("anchored line at end of file matches", () => {
    expect(hasTaskComplete(withFile("notes\n\nTASK_COMPLETE\n"))).toBe(true);
  });

  test("leading/trailing whitespace allowed", () => {
    expect(hasTaskComplete(withFile("   TASK_COMPLETE  \n"))).toBe(true);
  });

  test("marker inline in prose does NOT match", () => {
    expect(
      hasTaskComplete(
        withFile("we will write TASK_COMPLETE when everything is done.\n"),
      ),
    ).toBe(false);
  });

  test("marker inside an indented code block (still on its own line) DOES match", () => {
    // The bash grep is `^[[:space:]]*TASK_COMPLETE[[:space:]]*$`, which we
    // mirror — indentation inside a fenced code block still counts. Documenting
    // the behaviour explicitly so future changes are intentional.
    expect(hasTaskComplete(withFile("```\n    TASK_COMPLETE\n```\n"))).toBe(true);
  });

  test("returns false on missing file", () => {
    expect(hasTaskComplete("/no/such/file.md")).toBe(false);
  });

  test("custom marker is honoured", () => {
    expect(hasTaskComplete(withFile("ALL_DONE\n"), "ALL_DONE")).toBe(true);
    expect(hasTaskComplete(withFile("TASK_COMPLETE\n"), "ALL_DONE")).toBe(false);
  });
});

describe("ProgressFile.rotateProgressIfTooLarge", () => {
  test("no-op when file is below the threshold", () => {
    const p = withFile("small content\n");
    const archive = rotateProgressIfTooLarge(p, 1024 * 1024, 8 * 1024);
    expect(archive).toBeNull();
  });

  test("rotates when above threshold and keeps the tail", () => {
    const big = "x".repeat(20_000);
    const p = withFile(big + "\nTAIL_MARKER\n");
    const archive = rotateProgressIfTooLarge(p, 16_000, 256);
    expect(archive).not.toBeNull();
    // The archive file exists.
    expect(existsSync(archive!)).toBe(true);
    // The post-rotation progress file is small and contains the tail.
    const after = readFileSync(p, "utf8");
    expect(after).toContain("rotated");
    expect(after).toContain("TAIL_MARKER");
    // It must be smaller than the original.
    expect(after.length).toBeLessThan(big.length);
    // No `.tmp` left behind.
    const dir = resolve(p, "..");
    const stragglers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(stragglers).toEqual([]);
  });

  test("maxBytes <= 0 disables rotation entirely", () => {
    const p = withFile("a".repeat(10_000));
    expect(rotateProgressIfTooLarge(p, 0, 100)).toBeNull();
  });
});
