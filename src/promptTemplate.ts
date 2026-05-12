/**
 * Prompt-template helpers.
 *
 * The iteration prompt (consumer's `.ralphloop/prompt.md` or the bundled
 * default `prompts/iteration.md` in the submodule) may contain `{{KEY}}`
 * placeholders that are substituted with workspace-relative paths before the
 * text is handed to the agent.
 *
 * Supported keys:
 *   {{GOAL_FILE}}           path of cfg.goalFile relative to repoRoot
 *   {{TASKS_FILE}}          path of cfg.tasksFile relative to repoRoot
 *   {{PROGRESS_FILE}}       path of cfg.progressFile relative to repoRoot
 *   {{WORKSPACE_DIR}}       path of cfg.workspaceDir relative to repoRoot
 *   {{LOGS_DIR}}            path of cfg.logsDir relative to repoRoot
 *   {{STOP_MARKER}}         cfg.stopMarker
 *   {{COMMIT_TASK_PREFIX}}  cfg.commitTaskPrefix
 *
 * Unknown placeholders are left intact (so prompts can use literal `{{...}}`
 * in code examples without surprises) — only the keys above get substituted.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./Config.js";

const __dir = dirname(fileURLToPath(import.meta.url));

/** Absolute path of a prompt bundled in the submodule (`prompts/<name>`). */
export function bundledPromptPath(name: string): string {
  return resolve(__dir, "..", "prompts", name);
}

/**
 * Replace `{{KEY}}` tokens in `text` with values from `vars`. Keys not in
 * `vars` are left untouched.
 */
export function applyTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}

/**
 * Read the iteration prompt: consumer's override (`cfg.promptFile`) if it
 * exists, else the submodule's bundled default. Then apply template
 * substitution against the resolved Config.
 */
export function loadIterationPrompt(cfg: Config): string {
  const path = existsSync(cfg.promptFile)
    ? cfg.promptFile
    : bundledPromptPath("iteration.md");
  const raw = readFileSync(path, "utf8");
  return applyTemplate(raw, templateVarsForConfig(cfg));
}

export function templateVarsForConfig(cfg: Config): Record<string, string> {
  const rel = (abs: string): string => {
    const r = relative(cfg.repoRoot, abs);
    return r === "" ? "." : r;
  };
  return {
    GOAL_FILE: rel(cfg.goalFile),
    TASKS_FILE: rel(cfg.tasksFile),
    PROGRESS_FILE: rel(cfg.progressFile),
    WORKSPACE_DIR: rel(cfg.workspaceDir),
    LOGS_DIR: rel(cfg.logsDir),
    STOP_MARKER: cfg.stopMarker,
    COMMIT_TASK_PREFIX: cfg.commitTaskPrefix,
  };
}
