import { describe, expect, test } from "bun:test";
import { detectServerError } from "../src/RateLimit.js";

describe("detectServerError", () => {
  test("matches API 5xx / overloaded error text", () => {
    expect(detectServerError("API Error: 500 Internal server error.")).not.toBeNull();
    expect(detectServerError("api error: 503 service unavailable")).not.toBeNull();
    expect(detectServerError("something\noverloaded_error\nmore")).not.toBeNull();
    expect(detectServerError("API Error: 502 Bad gateway")?.reason).toContain("502");
  });

  test("returns null for clean output", () => {
    expect(detectServerError("all good — tests pass")).toBeNull();
  });

  test("does not match a 4xx error", () => {
    expect(detectServerError("API Error: 404 Not Found")).toBeNull();
  });

  test("ignores 5xx text inside a fenced code block", () => {
    const out = [
      "Here is my analysis:",
      "```",
      "if (status === 500) throw new Error('API Error: 500 Internal server error');",
      "```",
      "done.",
    ].join("\n");
    expect(detectServerError(out)).toBeNull();
  });

  test("still matches a real 5xx at the end of a long transcript", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `trace line ${i}`);
    lines.push("API Error: 529 overloaded_error");
    expect(detectServerError(lines.join("\n"))).not.toBeNull();
  });
});
