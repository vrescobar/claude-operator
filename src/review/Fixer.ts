/**
 * Fixer wrapper.
 *
 * Spawn an `AgentProcess` with the fixer model + prompt (which embeds the
 * reviewer's report), tee output to a per-round log file. The fixer mutates
 * the working tree directly; the sub-loop runs tests + commits afterward.
 */

import { createWriteStream, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AgentProcess } from "../AgentProcess.js";
import type { Config } from "../Config.js";
import type { Logger } from "../Logger.js";
import type { AgentResult, TaskRef } from "../types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = resolve(__dir, "..", "..", "prompts", "fixer.md");

export interface RunFixerOptions {
  cfg: Config;
  task: TaskRef;
  round: number;
  /** Markdown report from the reviewer, embedded in the fixer prompt. */
  report: string;
  /** Whether tests passed at the time the report was generated. */
  testsOk: boolean;
  /**
   * Tail of the failing test/typecheck output. Embedded in the fixer prompt
   * so the fixer can fix the root cause even when the reviewer didn't flag
   * it. Empty string when tests passed.
   */
  testOutput: string;
  logFile: string;
  log: Logger;
  registerAgent: (a: AgentProcess) => void;
  clearAgent: () => void;
  agentFactory?: (logStream: Writable) => AgentProcess;
}

export interface FixerOutput {
  result: AgentResult;
}

export async function runFixer(opts: RunFixerOptions): Promise<FixerOutput> {
  const { cfg, task, round, report, testsOk, testOutput, logFile, log, registerAgent, clearAgent } = opts;

  const stream = createWriteStream(logFile, { flags: "a" });
  try {
    const prompt = buildPrompt(cfg, task, round, report, testsOk, testOutput);

    const factory =
      opts.agentFactory ??
      ((logStream) =>
        new AgentProcess({
          command: cfg.fixerBin,
          model: cfg.fixerModel,
          timeoutMs: cfg.fixerTimeoutMs,
          cwd: cfg.repoRoot,
          logStream,
          onLine: log.streamAgentLine,
          maxBufferBytes: cfg.agentMaxBufferBytes,
        }));
    const agent = factory(stream);
    registerAgent(agent);
    try {
      const result = await agent.run(prompt);
      return { result };
    } finally {
      clearAgent();
    }
  } finally {
    stream.end();
  }
}

function buildPrompt(
  cfg: Config,
  task: TaskRef,
  round: number,
  report: string,
  testsOk: boolean,
  testOutput: string,
): string {
  const base = readFileSync(PROMPT_FILE, "utf8");
  // Single-pass {{KEY}} substitution: a key's replacement is never re-scanned
  // for further keys, so a `{{ROUND}}` appearing inside the report cannot
  // accidentally clobber the round number, and vice versa.
  const testOutputBlock = testsOk
    ? "_(tests are passing — no failure output to embed)_"
    : [
        "Failing test/typecheck output (tail):",
        "```",
        testOutput.trim().length > 0 ? testOutput.trim() : "(no captured output — re-run the failing command to see live output)",
        "```",
      ].join("\n");
  const map: Record<string, string> = {
    REPORT: report.trim(),
    ROUND: String(round),
    MAX_ROUNDS: String(cfg.reviewMaxRounds),
    TESTS_STATE: testsOk ? "passing" : "failing",
    TEST_OUTPUT_BLOCK: testOutputBlock,
  };
  const filled = base.replace(/\{\{([A-Z_]+)\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : full,
  );
  return (
    filled +
    [
      "",
      "─".repeat(72),
      "Sub-loop runtime context (provided by the ralph driver, not by you):",
      `  Task under review: #${task.id} — ${task.title}`,
      "─".repeat(72),
      "",
    ].join("\n")
  );
}
