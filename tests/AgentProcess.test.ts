import { describe, test, expect } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { AgentProcess } from "../src/AgentProcess.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = resolve(__dir, "fixtures", "bin", "fake-claude");

function tempLog(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ralph-test-"));
  return resolve(dir, "agent.log");
}

describe("AgentProcess", () => {
  test("captures stdout, stderr, and exit code", async () => {
    const logPath = tempLog();
    const stream = createWriteStream(logPath);
    const lines: { stream: string; line: string }[] = [];

    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: {
        FAKE_CLAUDE_OUT: "first line\nsecond line",
        FAKE_CLAUDE_ERR: "warning",
        FAKE_CLAUDE_EXIT: "0",
      },
      logStream: stream,
      onLine: (s, l) => lines.push({ stream: s, line: l }),
    });

    const result = await agent.run("ignored prompt");
    await new Promise<void>((resolve) => stream.end(() => resolve()));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("first line");
    expect(result.stdout).toContain("second line");
    expect(result.stderr).toContain("warning");
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.rateLimit).toBeNull();

    // streamed lines reached onLine
    const stdoutLines = lines.filter((l) => l.stream === "stdout").map((l) => l.line);
    expect(stdoutLines).toContain("first line");
    expect(stdoutLines).toContain("second line");
    expect(lines.find((l) => l.stream === "stderr" && l.line === "warning")).toBeDefined();

    // tee'd to log file as well
    const logged = readFileSync(logPath, "utf8");
    expect(logged).toContain("first line");
    expect(logged).toContain("[stderr] warning");
  });

  test("forwards stdin to the child", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_ECHO_STDIN: "1" },
    });

    const result = await agent.run("hello\nfrom\nralph\n");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STDIN> hello");
    expect(result.stdout).toContain("STDIN> from");
    expect(result.stdout).toContain("STDIN> ralph");
  });

  test("non-zero exit is reported, not thrown", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: "boom", FAKE_CLAUDE_EXIT: "7" },
    });
    const result = await agent.run("");
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("boom");
    expect(result.timedOut).toBe(false);
  });

  test("timeout fires and yields timedOut=true", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 200,
      killGraceMs: 200,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_SLEEP: "5", FAKE_CLAUDE_EXIT: "0" },
    });
    const result = await agent.run("");
    expect(result.timedOut).toBe(true);
    // exit code should be null/non-zero — process was terminated
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
    expect(result.durationMs).toBeLessThan(2000);
  });

  test("kill() while running terminates the process", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 10_000,
      killGraceMs: 200,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_SLEEP: "10", FAKE_CLAUDE_EXIT: "0" },
    });

    // Schedule a kill after the process has had time to spawn.
    setTimeout(() => {
      void agent.kill("SIGTERM");
    }, 100);

    const started = Date.now();
    const result = await agent.run("");
    const took = Date.now() - started;

    expect(result.killed).toBe(true);
    expect(took).toBeLessThan(3000);
  });

  test("missing binary throws ENOENT", async () => {
    const agent = new AgentProcess({
      command: "/no/such/binary/please",
      model: "fake-model",
      timeoutMs: 1000,
      cwd: process.cwd(),
    });
    await expect(agent.run("")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("stream-json output: usage / costUsd / text / numTurns parsed from the final result event", async () => {
    // Pre-canned stream-json transcript: system init → assistant text →
    // assistant tool_use → user tool_result → result. The fake-claude shim
    // copies FAKE_CLAUDE_OUT verbatim to stdout, so we can drive the parser
    // end-to-end without inventing a separate fixture.
    const events = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "thinking out loud" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] },
      }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", is_error: false, content: "file1 file2" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "final answer",
        duration_api_ms: 1234,
        total_cost_usd: 0.0421,
        num_turns: 3,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 0,
        },
      }),
    ];
    const logPath = tempLog();
    const stream = createWriteStream(logPath);
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: events.join("\n"), FAKE_CLAUDE_EXIT: "0" },
      logStream: stream,
    });
    const result = await agent.run("");
    await new Promise<void>((resolve) => stream.end(() => resolve()));

    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("final answer");
    expect(result.costUsd).toBe(0.0421);
    expect(result.numTurns).toBe(3);
    expect(result.apiDurationMs).toBe(1234);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 0,
    });
    // Log file holds the human-rendered trace, not the raw JSON envelope —
    // operators tail -f this file.
    const logged = readFileSync(logPath, "utf8");
    expect(logged).toContain("[system] init model=claude-opus-4-7");
    expect(logged).toContain("[assistant] thinking out loud");
    expect(logged).toContain("[tool] Bash(");
    expect(logged).toContain("[tool-result]");
    expect(logged).toContain("[done] turns=3");
    expect(logged).toContain("cost=$0.0421");
  });

  test("plain-text output falls back: text==stdout, usage=null", async () => {
    // No JSON in stdout → the parser stays in text mode. Keeps the
    // fake-claude shim (and any future text-mode override) working.
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: { FAKE_CLAUDE_OUT: "plain output\nsecond line", FAKE_CLAUDE_EXIT: "0" },
    });
    const result = await agent.run("");
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("plain output");
    expect(result.text).toBe(result.stdout);
    expect(result.usage).toBeNull();
    expect(result.costUsd).toBeNull();
    expect(result.apiDurationMs).toBeNull();
    expect(result.numTurns).toBeNull();
  });

  test("rate-limit text in output is detected", async () => {
    const agent = new AgentProcess({
      command: FAKE_CLAUDE,
      model: "fake-model",
      timeoutMs: 5000,
      cwd: process.cwd(),
      env: {
        FAKE_CLAUDE_OUT: "doing things",
        FAKE_CLAUDE_RATE_LIMIT:
          "Your usage limit will reset at 2030-01-01T00:00:00Z. Please try again later.",
        FAKE_CLAUDE_EXIT: "1",
      },
    });
    const result = await agent.run("");
    expect(result.rateLimit).not.toBeNull();
    expect(result.rateLimit?.until?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });
});

// Suppress unused mkdirSync import warning — kept for future use if tests need
// to create directories explicitly.
void mkdirSync;
