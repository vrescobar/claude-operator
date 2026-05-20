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

describe("AgentProcess — stream-json rate-limit handling", () => {
  // A benign `rate_limit_event` (status "allowed") carries a `resetsAt`
  // epoch; a tool_result embeds command output that itself mentions
  // "reset epoch …". Neither is a real rate-limit. The process exits
  // non-zero. Before the fix, the raw-stdout scan matched the epoch and
  // the loop slept for hours. Now: rateLimit must be null.
  test("benign rate_limit_event + tool_result epoch text + exit 1 → rateLimit null", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", model: "fake" }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1779210000 },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              is_error: false,
              content: "ralph iteration 7/10 — rate-limit-hits=0 reset epoch 1779210000",
            },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: false,
        result: "could not finish in time",
      }),
    ];
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: events.join("\n"), FAKE_CLAUDE_EXIT: "1" },
    });
    const r = await agent.run("");
    expect(r.exitCode).toBe(1);
    expect(r.rateLimit).toBeNull();
  });

  // A genuine block: status "rejected" with a reset time. The structured
  // signal is authoritative — rateLimit is populated from `resetsAt`.
  test("rejected rate_limit_event → rateLimit populated from resetsAt", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", model: "fake" }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1779210000 },
      }),
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "blocked" }),
    ];
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: events.join("\n"), FAKE_CLAUDE_EXIT: "1" },
    });
    const r = await agent.run("");
    expect(r.rateLimit).not.toBeNull();
    expect(r.rateLimit?.until?.getTime()).toBe(1779210000 * 1000);
  });

  // claude-p emits `status: "unknown"` when it cannot determine the rate-limit
  // state (e.g. an unrelated error happened first and the wire payload lacks a
  // `resetsAt`). Treating that as a block forces a 5-min sleep when the budget
  // is fine — observed in production on a task whose agent failed with
  // `[error] unknown` while ralph paused for 5m18s on a phantom rate limit.
  test("unknown rate_limit_event status → rateLimit null (no spurious sleep)", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", model: "fake" }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "unknown" },
      }),
      JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "boom" }),
    ];
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: events.join("\n"), FAKE_CLAUDE_EXIT: "1" },
    });
    const r = await agent.run("");
    expect(r.rateLimit).toBeNull();
  });

  // A later "allowed" event clears an earlier "rejected" one — the block lifted.
  test("rejected then allowed rate_limit_event → rateLimit null", async () => {
    const events = [
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1779210000 },
      }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1779210000 },
      }),
      JSON.stringify({ type: "result", subtype: "error", is_error: false, result: "done" }),
    ];
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: events.join("\n"), FAKE_CLAUDE_EXIT: "1" },
    });
    const r = await agent.run("");
    expect(r.rateLimit).toBeNull();
  });

  // Defence-in-depth: a raw JSON wire line embedding a `resetsAt` epoch is
  // dropped by the text-scan sanitiser, so it never false-positives.
  test("detectRateLimit ignores a raw stream-json line with an epoch", () => {
    const out = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1779210000}}';
    expect(detectRateLimit(out)).toBeNull();
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
