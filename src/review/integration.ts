/**
 * Phase integration review.
 *
 * Run by `ralphloop retry-blocked` AFTER the reopened batch of previously-
 * blocked tasks has been re-implemented. Because those tasks were redone out
 * of their original order, a per-task review is not enough — this is one
 * holistic pass over the WHOLE batch diff (`firstSha..HEAD`) checking that the
 * design spec is fully and coherently implemented and nothing broke across
 * task interdependencies.
 *
 * It reuses the reviewer→fixer sub-loop machinery (`runReviewSubloop`) with
 * two differences mandated by the operator:
 *   - the reviewer prompt is `prompts/integration-review.md`;
 *   - BOTH the reviewer and the fixer run on the Opus model — the integration
 *     review's findings *and* its corrections must be Opus, not Sonnet.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProcess } from "../AgentProcess.js";
import type { Config } from "../Config.js";
import type { Logger } from "../Logger.js";
import type { TaskRef, TestRunResult } from "../types.js";
import { runReviewSubloop } from "./subloop.js";
import type { SubloopOutcome } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const INTEGRATION_PROMPT = resolve(__dir, "..", "..", "prompts", "integration-review.md");

/** GOAL.md content above this many bytes is referenced by path, not embedded. */
const GOAL_EMBED_CAP_BYTES = 24 * 1024;

export interface IntegrationReviewOptions {
  cfg: Config;
  /** Git SHA captured before the reopened batch was worked — base of the diff. */
  firstSha: string;
  /** Ids of the reopened tasks in the batch, for the prompt context. */
  taskIds: string[];
  log: Logger;
  /** Run the test gate (passed in so this module stays decoupled from loop.ts). */
  runTests: () => Promise<TestRunResult>;
  abortSignal?: AbortSignal;
  registerAgent: (a: AgentProcess) => void;
  clearAgent: () => void;
}

export async function runIntegrationReview(
  opts: IntegrationReviewOptions,
): Promise<SubloopOutcome> {
  const { cfg, firstSha, taskIds, log } = opts;

  // Opus for BOTH roles — the operator mandated the integration review's
  // findings and its fixes both run on Opus, not the Sonnet fixer.
  const reviewCfg: Config = {
    ...cfg,
    fixerModel: cfg.reviewerModel,
    fixerBin: cfg.reviewerBin,
    fixerTimeoutMs: cfg.reviewerTimeoutMs,
  };

  const syntheticTask: TaskRef = {
    id: "integration",
    title: `Phase integration review — ${taskIds.length} reopened task(s)`,
    lineNumber: 0,
  };

  log.stage(
    "integration-review.start",
    `model=${cfg.reviewerModel} base=${firstSha.slice(0, 8)} tasks=${taskIds.join(",")}`,
  );

  return runReviewSubloop({
    cfg: reviewCfg,
    task: syntheticTask,
    log,
    originalSha: firstSha,
    abortSignal: opts.abortSignal,
    runTests: opts.runTests,
    registerAgent: opts.registerAgent,
    clearAgent: opts.clearAgent,
    reviewerPromptFile: INTEGRATION_PROMPT,
    extraContext: buildExtraContext(cfg, taskIds),
  });
}

function buildExtraContext(cfg: Config, taskIds: string[]): string {
  const lines: string[] = [
    "PHASE INTEGRATION REVIEW — the following previously-blocked tasks were " +
      `re-implemented, NOT necessarily in order: ${taskIds.join(", ")}.`,
    "Review the combined batch diff for coherence; do not assume any single " +
      "commit is self-contained.",
    "",
  ];
  // The design spec is the source of truth for "all options implemented".
  if (existsSync(cfg.goalFile)) {
    let goal = "";
    try {
      goal = readFileSync(cfg.goalFile, "utf8").trim();
    } catch {
      goal = "";
    }
    if (goal.length > 0 && goal.length <= GOAL_EMBED_CAP_BYTES) {
      lines.push("Design spec (GOAL.md) — source of truth for what the batch must achieve:");
      lines.push("```");
      lines.push(goal);
      lines.push("```");
    } else if (goal.length > GOAL_EMBED_CAP_BYTES) {
      lines.push(
        `Design spec: read \`${cfg.goalFile}\` in full with your Read tool — ` +
          "it is the source of truth for what the batch must achieve.",
      );
    }
  }
  return lines.join("\n");
}
