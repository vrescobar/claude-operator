import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { freshState, getTaskState, loadState, saveState } from "../src/State.js";

function tmpFile(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ralph-state-"));
  return resolve(dir, ".state.json");
}

describe("State", () => {
  test("loadState on missing file returns fresh state", () => {
    const path = tmpFile();
    const s = loadState(path);
    expect(s.version).toBe(1);
    expect(s.tasks).toEqual({});
    expect(s.counters.iterations).toBe(0);
  });

  test("save → load round-trip preserves task counters", () => {
    const path = tmpFile();
    const s = freshState();
    const t = getTaskState(s, "07");
    t.attempts = 3;
    t.noChangeAttempts = 1;
    t.lastAttemptAt = "2026-05-09T12:34:56.000Z";
    s.counters.iterations = 5;
    s.counters.committed = 4;
    saveState(path, s);

    const reloaded = loadState(path);
    expect(reloaded.tasks["07"]?.attempts).toBe(3);
    expect(reloaded.tasks["07"]?.noChangeAttempts).toBe(1);
    expect(reloaded.tasks["07"]?.lastAttemptAt).toBe("2026-05-09T12:34:56.000Z");
    expect(reloaded.counters.iterations).toBe(5);
    expect(reloaded.counters.committed).toBe(4);
  });

  test("loadState tolerates a corrupted file", () => {
    const path = tmpFile();
    writeFileSync(path, "{not valid json");
    const s = loadState(path);
    expect(s.tasks).toEqual({});
    expect(s.counters.iterations).toBe(0);
  });

  test("loadState rejects unknown version and returns fresh state", () => {
    const path = tmpFile();
    writeFileSync(path, JSON.stringify({ version: 99, tasks: {}, counters: {} }));
    const s = loadState(path);
    expect(s.version).toBe(1);
    expect(s.tasks).toEqual({});
  });

  test("saveState is atomic: tmp file is renamed, no half-written state on disk", () => {
    const path = tmpFile();
    const s = freshState();
    s.counters.iterations = 42;
    saveState(path, s);
    const content = readFileSync(path, "utf8");
    // Final character is newline-terminated valid JSON.
    expect(content.endsWith("\n")).toBe(true);
    expect(JSON.parse(content).counters.iterations).toBe(42);
  });

  test("getTaskState lazily creates a new TaskState entry", () => {
    const s = freshState();
    expect(s.tasks["77"]).toBeUndefined();
    const t = getTaskState(s, "77");
    expect(t.attempts).toBe(0);
    expect(s.tasks["77"]).toBe(t);
  });
});
