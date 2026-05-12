/**
 * Reviewer wrapper.
 *
 * Single function: spawn an `AgentProcess` with the reviewer model + prompt,
 * tee the report to a per-round log file, return both the raw `AgentResult`
 * and the captured report (== stdout, by design).
 *
 * The reviewer's job is purely producing a markdown report; it never edits
 * files, never commits. The sub-loop reads the report and decides what to
 * do next.
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
const PROMPT_FILE = resolve(__dir, "..", "..", "prompts", "reviewer.md");

export interface RunReviewerOptions {
  cfg: Config;
  task: TaskRef;
  /** 1-based round number — used in the prompt and the log filename. */
  round: number;
  /** Whether `bun run test` currently passes. Surfaced in the prompt. */
  testsOk: boolean;
  /**
   * SHA of the original task commit (the one that started this review
   * sub-loop). Round 1 reviews `originalSha`; round K still reviews
   * `originalSha..HEAD` so the reviewer's frame of reference doesn't drift as
   * fix commits accumulate. Null when HEAD couldn't be resolved at the start
   * of the sub-loop — the prompt falls back to plain HEAD inspection.
   */
  originalSha: string | null;
  /** Path to the per-round log file (also receives the report). */
  logFile: string;
  log: Logger;
  /** SIGINT-handler hook so the parent loop can kill the active reviewer. */
  registerAgent: (a: AgentProcess) => void;
  clearAgent: () => void;
  /** Test-only override; defaults to `new AgentProcess(...)`. */
  agentFactory?: (logStream: Writable) => AgentProcess;
}

export interface ReviewerOutput {
  result: AgentResult;
  report: string;
}

export async function runReviewer(opts: RunReviewerOptions): Promise<ReviewerOutput> {
  const { cfg, task, round, testsOk, originalSha, logFile, log, registerAgent, clearAgent } = opts;

  const stream = createWriteStream(logFile, { flags: "a" });
  try {
    const prompt = buildPrompt(cfg, task, round, testsOk, originalSha);

    const factory =
      opts.agentFactory ??
      ((logStream) =>
        new AgentProcess({
          command: cfg.reviewerBin,
          model: cfg.reviewerModel,
          timeoutMs: cfg.reviewerTimeoutMs,
          cwd: cfg.repoRoot,
          logStream,
          onLine: log.streamAgentLine,
          maxBufferBytes: cfg.agentMaxBufferBytes,
        }));
    const agent = factory(stream);
    registerAgent(agent);
    try {
      const result = await agent.run(prompt);
      return { result, report: result.stdout };
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
  testsOk: boolean,
  originalSha: string | null,
): string {
  const base = readFileSync(PROMPT_FILE, "utf8");
  const shortSha = originalSha ? originalSha.slice(0, 12) : "HEAD";
  const reviewLines = originalSha
    ? [
        `Review the original task commit ${shortSha} plus all fix-commits since:`,
        `  git show ${shortSha} --stat -p`,
        `  git diff ${shortSha}..HEAD`,
        `  git log --oneline ${shortSha}..HEAD`,
      ]
    : [
        `Review HEAD (originalSha was unresolved at sub-loop start):`,
        `  git show HEAD --stat -p`,
        `  git log -1 HEAD`,
      ];
  return [
    base,
    "",
    "─".repeat(72),
    "Sub-loop runtime context (provided by the ralph driver, not by you):",
    `  Task under review: #${task.id} — ${task.title}`,
    `  Round: ${round}/${cfg.reviewMaxRounds}`,
    `  Tests currently: ${testsOk ? "passing" : "failing"}`,
    `  Original task commit: ${shortSha}`,
    ...reviewLines.map((l) => `  ${l}`),
    "─".repeat(72),
    "",
  ].join("\n");
}
