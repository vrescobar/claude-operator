import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readSessionUsage } from "../src/SessionUsage.js";

/** Write a fake Claude Code session transcript and return its projects dir. */
function writeSession(sessionId: string, lines: string[]): string {
  const projects = mkdtempSync(resolve(tmpdir(), "ralph-sessions-"));
  // claude nests transcripts one level deep: projects/<cwd-slug>/<id>.jsonl
  const slugDir = resolve(projects, "-some-repo");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(resolve(slugDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  return projects;
}

describe("readSessionUsage", () => {
  test("sums message.usage across every assistant turn", () => {
    const sid = "sess-1";
    const projects = writeSession(sid, [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 3,
            output_tokens: 7,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
          },
        },
      }),
      JSON.stringify({ type: "user", message: { content: [] } }),
      JSON.stringify({
        type: "assistant",
        message: {
          usage: {
            input_tokens: 4,
            output_tokens: 9,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);

    expect(readSessionUsage(sid, projects)).toEqual({
      inputTokens: 7,
      outputTokens: 16,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 50,
    });
  });

  test("treats missing / null token fields as zero", () => {
    const sid = "sess-2";
    const projects = writeSession(sid, [
      JSON.stringify({
        type: "assistant",
        message: { usage: { output_tokens: 5, input_tokens: null } },
      }),
    ]);
    expect(readSessionUsage(sid, projects)).toEqual({
      inputTokens: 0,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  test("returns null when the transcript is absent", () => {
    const projects = mkdtempSync(resolve(tmpdir(), "ralph-sessions-"));
    expect(readSessionUsage("does-not-exist", projects)).toBeNull();
  });

  test("returns null when no assistant carries a usage block", () => {
    const sid = "sess-3";
    const projects = writeSession(sid, [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ]);
    expect(readSessionUsage(sid, projects)).toBeNull();
  });

  test("tolerates malformed JSON lines", () => {
    const sid = "sess-4";
    const projects = writeSession(sid, [
      "{ not json",
      JSON.stringify({ type: "assistant", message: { usage: { output_tokens: 2 } } }),
      "",
    ]);
    expect(readSessionUsage(sid, projects)?.outputTokens).toBe(2);
  });
});
