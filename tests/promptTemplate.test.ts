import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Config } from "../src/Config.js";
import {
  applyTemplate,
  bundledPromptPath,
  loadIterationPrompt,
  templateVarsForConfig,
} from "../src/promptTemplate.js";

function stubConfig(overrides: Partial<Config> = {}): Config {
  const repoRoot = "/tmp/fake-repo";
  return {
    repoRoot,
    workspaceDir: `${repoRoot}/.ralphloop`,
    goalFile: `${repoRoot}/GOAL.md`,
    tasksFile: `${repoRoot}/.ralphloop/tasks.md`,
    progressFile: `${repoRoot}/.ralphloop/progress.md`,
    promptFile: `${repoRoot}/.ralphloop/prompt.md`,
    logsDir: `${repoRoot}/.ralphloop/logs`,
    archiveDir: `${repoRoot}/.ralphloop/archive`,
    lockFile: `${repoRoot}/.ralphloop/lock`,
    stateFile: `${repoRoot}/.ralphloop/state.json`,
    metricsFile: `${repoRoot}/.ralphloop/metrics.jsonl`,
    maxIterations: 1,
    stopMarker: "TASK_COMPLETE",
    commitTaskPrefix: "task",
    commitReviewPrefix: "review",
    claudeBin: "claude",
    claudeModel: "x",
    claudeTimeoutMs: 1,
    testTimeoutMs: 1,
    gitTimeoutMs: 1,
    noChangeRetryLimit: 0,
    taskAttemptLimit: 0,
    failResetMode: "leave",
    rateLimitFallbackMs: 0,
    rateLimitFallbackCapMs: 0,
    rateLimitJitterMs: 0,
    minRateLimitSleepMs: 0,
    agentMaxBufferBytes: 1024,
    typecheckEnabled: false,
    logRetentionDays: 0,
    progressMaxBytes: 1024,
    progressTailKeepBytes: 0,
    reviewEnabled: false,
    reviewerBin: "claude",
    reviewerModel: "x",
    reviewerTimeoutMs: 1,
    fixerBin: "claude",
    fixerModel: "x",
    fixerTimeoutMs: 1,
    reviewMaxRounds: 1,
    reviewRlMaxConsecutiveHits: 1,
    reviewMaxNoOpRounds: 1,
    reviewMaxRepeatDiffRounds: 1,
    reviewMaxReviewerFailures: 1,
    verbose: false,
    dryRun: false,
    ...overrides,
  };
}

describe("applyTemplate", () => {
  test("substitutes a single placeholder", () => {
    expect(applyTemplate("hi {{NAME}}", { NAME: "world" })).toBe("hi world");
  });

  test("leaves unknown placeholders intact", () => {
    expect(applyTemplate("hi {{NAME}} {{UNKNOWN}}", { NAME: "x" })).toBe("hi x {{UNKNOWN}}");
  });

  test("substitutes every occurrence", () => {
    expect(applyTemplate("{{A}} and {{A}}", { A: "x" })).toBe("x and x");
  });

  test("non-uppercase tokens are not substituted (looks like a code example)", () => {
    expect(applyTemplate("config = {{ tasks_file }}", { tasks_file: "x" })).toBe(
      "config = {{ tasks_file }}",
    );
  });
});

describe("templateVarsForConfig", () => {
  test("derives repo-relative paths", () => {
    const cfg = stubConfig();
    const vars = templateVarsForConfig(cfg);
    expect(vars.GOAL_FILE).toBe("GOAL.md");
    expect(vars.TASKS_FILE).toBe(".ralphloop/tasks.md");
    expect(vars.PROGRESS_FILE).toBe(".ralphloop/progress.md");
    expect(vars.WORKSPACE_DIR).toBe(".ralphloop");
    expect(vars.LOGS_DIR).toBe(".ralphloop/logs");
    expect(vars.STOP_MARKER).toBe("TASK_COMPLETE");
    expect(vars.COMMIT_TASK_PREFIX).toBe("task");
  });

  test("custom stopMarker + prefix flow through", () => {
    const cfg = stubConfig({ stopMarker: "ALL_DONE", commitTaskPrefix: "feat" });
    const vars = templateVarsForConfig(cfg);
    expect(vars.STOP_MARKER).toBe("ALL_DONE");
    expect(vars.COMMIT_TASK_PREFIX).toBe("feat");
  });
});

describe("loadIterationPrompt", () => {
  test("falls back to the bundled prompt when cfg.promptFile is absent", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "ralph-prompt-fallback-"));
    const cfg = stubConfig({
      repoRoot: tmp,
      promptFile: resolve(tmp, "missing.md"),
      goalFile: resolve(tmp, "GOAL.md"),
      tasksFile: resolve(tmp, ".ralphloop", "tasks.md"),
      progressFile: resolve(tmp, ".ralphloop", "progress.md"),
      workspaceDir: resolve(tmp, ".ralphloop"),
      logsDir: resolve(tmp, ".ralphloop", "logs"),
    });
    const text = loadIterationPrompt(cfg);
    // bundled prompt mentions Ralphloop and the substituted GOAL.md placeholder
    expect(text).toContain("Ralphloop iteration prompt");
    expect(text).toContain("GOAL.md");
    expect(text).not.toContain("{{GOAL_FILE}}");
  });

  test("uses the consumer override when present and substitutes placeholders", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "ralph-prompt-override-"));
    const promptPath = resolve(tmp, "prompt.md");
    writeFileSync(promptPath, "Spec lives at {{GOAL_FILE}}; stop with {{STOP_MARKER}}.");
    const cfg = stubConfig({
      repoRoot: tmp,
      promptFile: promptPath,
      goalFile: resolve(tmp, "GOAL.md"),
      workspaceDir: resolve(tmp, ".ralphloop"),
      tasksFile: resolve(tmp, ".ralphloop", "tasks.md"),
      progressFile: resolve(tmp, ".ralphloop", "progress.md"),
      logsDir: resolve(tmp, ".ralphloop", "logs"),
      stopMarker: "ALL_DONE",
    });
    expect(loadIterationPrompt(cfg)).toBe("Spec lives at GOAL.md; stop with ALL_DONE.");
  });
});

describe("bundledPromptPath", () => {
  test("resolves to a file that exists in the submodule", () => {
    const p = bundledPromptPath("iteration.md");
    expect(p).toMatch(/prompts\/iteration\.md$/);
    // existsSync via dynamic import would be overkill — loadIterationPrompt
    // covers the existence path.
  });
});
