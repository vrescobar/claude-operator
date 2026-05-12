import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "../src/AgentProcess.js";
import { computeSleepUntil, detectRateLimit } from "../src/RateLimit.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dir, "fixtures", "bin", "fake-claude");

describe("RateLimit detector — false-positive guards", () => {
  test("rate-limit phrase inside a markdown code fence is ignored", () => {
    const out = [
      "Here is some example log output that I am citing in a report:",
      "```",
      "rate limit exceeded — please slow down",
      "```",
      "End of report.",
    ].join("\n");
    expect(detectRateLimit(out)).toBeNull();
  });

  test("rate-limit phrase deep in the body but not the tail is ignored", () => {
    const middle = "rate limit exceeded — please slow down";
    const filler = Array.from({ length: 250 }).map((_, i) => `noise line ${i}`);
    const out = [middle, ...filler].join("\n");
    expect(detectRateLimit(out)).toBeNull();
  });

  test("rate-limit phrase in the tail (last 200 lines) is detected", () => {
    const head = Array.from({ length: 50 }).map((_, i) => `head line ${i}`);
    const tail = "rate limit exceeded — please slow down";
    const out = [...head, tail].join("\n");
    expect(detectRateLimit(out)).not.toBeNull();
  });

  test("explicit reset-at date inside a code fence is ignored", () => {
    const out = [
      "Here's the schema:",
      "```ts",
      "// reset at 2030-01-01T00:00:00Z when the hard cap resets",
      "```",
      "Done.",
    ].join("\n");
    expect(detectRateLimit(out)).toBeNull();
  });
});

describe("AgentProcess — rate-limit gating on exit code", () => {
  test("rate-limit text + exit 0 → AgentResult.rateLimit is null", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: {
        FAKE_CLAUDE_OUT: "doing work",
        FAKE_CLAUDE_RATE_LIMIT: "rate limit exceeded — please slow down",
        FAKE_CLAUDE_EXIT: "0",
      },
    });
    const r = await agent.run("");
    expect(r.exitCode).toBe(0);
    expect(r.rateLimit).toBeNull();
  });

  test("rate-limit text + exit 1 → AgentResult.rateLimit is populated", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: {
        FAKE_CLAUDE_OUT: "doing work",
        FAKE_CLAUDE_RATE_LIMIT: "rate limit exceeded — please slow down",
        FAKE_CLAUDE_EXIT: "1",
      },
    });
    const r = await agent.run("");
    expect(r.rateLimit).not.toBeNull();
  });
});

describe("computeSleepUntil — minSleepMs floor", () => {
  test("past until + zero jitter + zero floor sleeps 0 ms (legacy behaviour)", () => {
    const now = new Date("2026-05-09T12:00:00Z");
    const info = { until: new Date("2026-05-09T11:00:00Z"), reason: "x" };
    const r = computeSleepUntil(info, 0, 0, () => now, 0);
    expect(r.sleepMs).toBe(0);
  });

  test("past until + non-zero floor enforces a minimum sleep", () => {
    const now = new Date("2026-05-09T12:00:00Z");
    const info = { until: new Date("2026-05-09T11:00:00Z"), reason: "x" };
    const r = computeSleepUntil(info, 0, 0, () => now, 30_000);
    expect(r.sleepMs).toBe(30_000);
  });

  test("future until that exceeds the floor wins", () => {
    const now = new Date("2026-05-09T12:00:00Z");
    const info = { until: new Date("2026-05-09T13:00:00Z"), reason: "x" };
    const r = computeSleepUntil(info, 0, 0, () => now, 30_000);
    expect(r.sleepMs).toBe(60 * 60 * 1000);
  });
});
