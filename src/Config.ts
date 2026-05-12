/**
 * Resolved ralphloop runtime configuration.
 *
 * `loadConfig({ workspace, overrides })` layers env vars and CLI overrides on
 * top of a `WorkspaceResolution` (cwd + `.ralphloop/` paths + an optional
 * config.yaml). Every field is either externally configurable (CLI flag, env
 * var, or `.ralphloop/config.yaml`) or derived deterministically from the
 * workspace dir.
 *
 * Precedence (highest first): CLI flag > env var > config.yaml > built-in default.
 */

import { resolve } from "node:path";
import type { RalphloopConfigFile, WorkspaceResolution } from "./workspace.js";
import { resolveWorkspace } from "./workspace.js";

export interface Config {
  /** Consumer repo root (where GOAL.md lives by default). */
  repoRoot: string;
  /** Workspace directory holding all loop state + content. */
  workspaceDir: string;
  /** Project spec file (consumed by the agent, not the loop). */
  goalFile: string;
  /** Path to the checklist the loop reads (tasks.md). */
  tasksFile: string;
  /** Path to the agent's append-only decision log (progress.md). */
  progressFile: string;
  /** Path to the iteration prompt (consumer override or bundled default). */
  promptFile: string;
  /** Directory where per-iteration log files land. */
  logsDir: string;
  /** Directory where rotated progress archives land. */
  archiveDir: string;
  /** Lockfile that prevents concurrent runs. */
  lockFile: string;
  /** Persisted state file (per-task attempts, counters). */
  stateFile: string;
  /** Per-iteration metrics JSONL file. */
  metricsFile: string;

  /** Hard cap on iterations (default 50). */
  maxIterations: number;
  /** Stop marker matched anchored against progress.md (default "TASK_COMPLETE"). */
  stopMarker: string;
  /** Commit-message prefix for successful task commits (default "task"). */
  commitTaskPrefix: string;
  /** Commit-message prefix for review-round commits (default "review"). */
  commitReviewPrefix: string;
  /** Path or name of the claude binary (default "claude"). */
  claudeBin: string;
  /** Model passed to `claude -p --model …`. */
  claudeModel: string;
  /** Wall-clock cap per agent invocation (ms). */
  claudeTimeoutMs: number;
  /** Wall-clock cap for the test gate (ms). */
  testTimeoutMs: number;
  /** Wall-clock cap for any single git operation (ms). */
  gitTimeoutMs: number;
  /** Retry budget when the agent marks a task done but produces no diff. */
  noChangeRetryLimit: number;
  /**
   * Hard cap on attempts per individual task. When exceeded the task is
   * flipped to `[!]` (blocked), a note is appended to progress.md, and the
   * loop moves on. Prevents soft-loops where a single broken task burns the
   * entire iteration budget.
   */
  taskAttemptLimit: number;
  /**
   * What to do with the agent's working-tree changes after a failed iteration
   * (tests-failed or commit-failed). `"stash"` (default) preserves them under
   * a refs/ralph-stash/ entry so the operator can recover; `"reset"` discards
   * them with `git reset --hard HEAD` + `git clean -fd`; `"leave"` keeps them
   * on disk (legacy behaviour).
   */
  failResetMode: "stash" | "reset" | "leave";
  /**
   * Base fallback sleep when a rate-limit is detected but no reset time is
   * surfaced. The actual sleep grows exponentially with consecutive RL hits
   * on the same task: `min(rateLimitFallbackCapMs, rateLimitFallbackMs *
   * 3^(n-1))`. With the defaults (5 min base, 1 h cap), back-to-back hits
   * wait 5 min → 15 min → 45 min → 1 h → 1 h … When a reset epoch IS
   * surfaced by the upstream output, it is honoured verbatim and this
   * curve is bypassed.
   */
  rateLimitFallbackMs: number;
  /** Hard cap on the exponential fallback sleep (ms). */
  rateLimitFallbackCapMs: number;
  /** Random jitter added to the sleep target after a rate-limit (ms). */
  rateLimitJitterMs: number;
  /**
   * Minimum sleep that fires when a rate-limit is detected. Even with a past
   * `until` and zero jitter we never sleep less than this — the floor stops a
   * bug in the detector from turning into a CPU-busy retry storm. Tests pin
   * this to 0.
   */
  minRateLimitSleepMs: number;
  /**
   * `maxBuffer` passed to execa for the agent subprocess. Caps how much the
   * parent will buffer in memory before the agent's stdout/stderr cause a
   * MaxBufferError. Default 50 MB — the per-iteration log file is the source
   * of truth for the full transcript, so we don't need the entire stream in
   * RAM.
   */
  agentMaxBufferBytes: number;
  /**
   * Run `bun run typecheck` (when present in package.json) before the test
   * gate. Catches "compiles by accident" / "test runner can't import this"
   * regressions that the test suite alone wouldn't surface.
   */
  typecheckEnabled: boolean;
  /**
   * Logs in `<workspaceDir>/logs/` older than this many days are pruned at
   * start. 0 disables pruning. Default 14.
   */
  logRetentionDays: number;
  /**
   * If `progress.md` exceeds this many bytes, the loop archives the current
   * file to `<archiveDir>/progress-<ts>.md` (gitignored) and starts a fresh
   * one containing only the trailing `progressTailKeepBytes` bytes.
   */
  progressMaxBytes: number;
  progressTailKeepBytes: number;

  /** Run the reviewer→fixer sub-loop after each successful task commit. */
  reviewEnabled: boolean;
  /** Override for the reviewer's claude binary; defaults to `claudeBin`. */
  reviewerBin: string;
  /** Model name for the Opus reviewer. */
  reviewerModel: string;
  /** Wall-clock cap per reviewer invocation (ms). */
  reviewerTimeoutMs: number;
  /** Override for the fixer's claude binary; defaults to `claudeBin`. */
  fixerBin: string;
  /** Model name for the Sonnet fixer. */
  fixerModel: string;
  /** Wall-clock cap per fixer invocation (ms). */
  fixerTimeoutMs: number;
  /** Hard cap on review-loop rounds before halting the main loop. */
  reviewMaxRounds: number;
  /**
   * Safety cap on *consecutive* rate-limit hits within a single review round
   * before the round is considered diverged. The sub-loop retries on RL
   * indefinitely under this cap, so this only fires if a reviewer/fixer can't
   * make any forward progress at all. Default 10.
   */
  reviewRlMaxConsecutiveHits: number;
  /** Halt the sub-loop after this many consecutive no-op fixer rounds. */
  reviewMaxNoOpRounds: number;
  /** Halt the sub-loop after this many consecutive identical fixer diffs. */
  reviewMaxRepeatDiffRounds: number;
  /** Halt the sub-loop after this many consecutive reviewer crashes / UNKNOWN verdicts. */
  reviewMaxReviewerFailures: number;

  /** Stream every claude output line to the console live. */
  verbose: boolean;
  /** Skip claude / tests / commit; only print what would be done. */
  dryRun: boolean;
}

function intEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return fallback;
}

function parseFailResetMode(raw: string | undefined): "stash" | "reset" | "leave" {
  if (raw === undefined || raw === "") return "stash";
  const v = raw.toLowerCase();
  if (v === "stash" || v === "reset" || v === "leave") return v;
  return "stash";
}

export interface ConfigOverrides {
  verbose?: boolean;
  dryRun?: boolean;
  maxIterations?: number;
  reviewEnabled?: boolean;
  reviewMaxRounds?: number;
  /** Override --goal at the CLI level. */
  goalFile?: string;
  /** Override --tasks at the CLI level. */
  tasksFile?: string;
  /** Override --progress at the CLI level. */
  progressFile?: string;
  /** Override --prompt at the CLI level. */
  promptFile?: string;
}

export interface LoadConfigOptions {
  /** Pre-resolved workspace. If absent, resolveWorkspace() is called with default args. */
  workspace?: WorkspaceResolution;
  /** Per-invocation overrides (parsed from CLI flags). */
  overrides?: ConfigOverrides;
  /** Override process.env (tests). */
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOptions = {}): Config {
  const workspace = opts.workspace ?? resolveWorkspace();
  const cfgFile: RalphloopConfigFile = workspace.configData ?? {};
  const overrides = opts.overrides ?? {};
  const env = opts.env ?? process.env;
  const { repoRoot, workspaceDir } = workspace;

  const goalFile = resolve(
    repoRoot,
    overrides.goalFile ?? env["RALPH_GOAL_FILE"] ?? cfgFile.goal ?? "GOAL.md",
  );
  const tasksFile = resolve(
    repoRoot,
    overrides.tasksFile ??
      env["RALPH_TASKS_FILE"] ??
      cfgFile.tasks ??
      resolve(workspaceDir, "tasks.md"),
  );
  const progressFile = resolve(
    repoRoot,
    overrides.progressFile ??
      env["RALPH_PROGRESS_FILE"] ??
      cfgFile.progress ??
      resolve(workspaceDir, "progress.md"),
  );
  const promptFile = resolve(
    repoRoot,
    overrides.promptFile ??
      env["RALPH_PROMPT_FILE"] ??
      cfgFile.prompt ??
      resolve(workspaceDir, "prompt.md"),
  );

  const claudeBin = env["RALPH_CLAUDE_BIN"] || cfgFile.claude?.bin || "claude";

  const maxIterations =
    overrides.maxIterations ??
    intEnv("RALPH_MAX_ITERATIONS", cfgFile.maxIterations ?? 50, env);

  return {
    repoRoot,
    workspaceDir,
    goalFile,
    tasksFile,
    progressFile,
    promptFile,
    logsDir: resolve(workspaceDir, "logs"),
    archiveDir: resolve(workspaceDir, "archive"),
    lockFile: resolve(workspaceDir, "lock"),
    stateFile: resolve(workspaceDir, "state.json"),
    metricsFile: resolve(workspaceDir, "metrics.jsonl"),

    maxIterations,
    stopMarker: env["RALPH_STOP_MARKER"] || cfgFile.stopMarker || "TASK_COMPLETE",
    commitTaskPrefix: env["RALPH_COMMIT_TASK_PREFIX"] || cfgFile.commit?.taskPrefix || "task",
    commitReviewPrefix:
      env["RALPH_COMMIT_REVIEW_PREFIX"] || cfgFile.commit?.reviewPrefix || "review",
    claudeBin,
    claudeModel: env["RALPH_CLAUDE_MODEL"] || cfgFile.claude?.model || "claude-sonnet-4-6",
    claudeTimeoutMs:
      intEnv("RALPH_CLAUDE_TIMEOUT_S", cfgFile.claude?.timeoutS ?? 1800, env) * 1000,
    testTimeoutMs: intEnv("RALPH_TEST_TIMEOUT_S", 600, env) * 1000,
    gitTimeoutMs: intEnv("RALPH_GIT_TIMEOUT_S", 60, env) * 1000,
    noChangeRetryLimit: intEnv("RALPH_NO_CHANGE_RETRY_LIMIT", 2, env),
    taskAttemptLimit: intEnv("RALPH_TASK_ATTEMPT_LIMIT", 5, env),
    failResetMode: parseFailResetMode(env["RALPH_FAIL_RESET"]),
    rateLimitFallbackMs: intEnv("RALPH_RATE_LIMIT_FALLBACK_MS", 5 * 60 * 1000, env),
    rateLimitFallbackCapMs: intEnv("RALPH_RATE_LIMIT_FALLBACK_CAP_MS", 60 * 60 * 1000, env),
    rateLimitJitterMs: intEnv("RALPH_RATE_LIMIT_JITTER_MS", 30_000, env),
    minRateLimitSleepMs: intEnv("RALPH_MIN_RATE_LIMIT_SLEEP_MS", 10_000, env),
    agentMaxBufferBytes: intEnv("RALPH_AGENT_MAX_BUFFER_BYTES", 50 * 1024 * 1024, env),
    typecheckEnabled: boolEnv("RALPH_TYPECHECK_ENABLED", true, env),
    logRetentionDays: intEnv("RALPH_LOG_RETENTION_DAYS", 14, env),
    progressMaxBytes: intEnv("RALPH_PROGRESS_MAX_BYTES", 64 * 1024, env),
    progressTailKeepBytes: intEnv("RALPH_PROGRESS_TAIL_KEEP_BYTES", 8 * 1024, env),

    reviewEnabled:
      overrides.reviewEnabled ??
      boolEnv("RALPH_REVIEW_ENABLED", cfgFile.review?.enabled ?? true, env),
    reviewerBin: env["RALPH_REVIEWER_BIN"] || cfgFile.review?.reviewerBin || claudeBin,
    reviewerModel:
      env["RALPH_REVIEWER_MODEL"] || cfgFile.review?.reviewerModel || "claude-opus-4-7",
    reviewerTimeoutMs: intEnv("RALPH_REVIEWER_TIMEOUT_S", 600, env) * 1000,
    fixerBin: env["RALPH_FIXER_BIN"] || cfgFile.review?.fixerBin || claudeBin,
    fixerModel: env["RALPH_FIXER_MODEL"] || cfgFile.review?.fixerModel || "claude-sonnet-4-6",
    fixerTimeoutMs: intEnv("RALPH_FIXER_TIMEOUT_S", 600, env) * 1000,
    reviewMaxRounds:
      overrides.reviewMaxRounds ??
      intEnv("RALPH_REVIEW_MAX_ROUNDS", cfgFile.review?.maxRounds ?? 5, env),
    // The env var keeps its old name for backwards-compat with existing
    // operator configs; semantics are documented on the Config field.
    reviewRlMaxConsecutiveHits: intEnv("RALPH_REVIEW_RL_RETRIES_PER_ROUND", 10, env),
    reviewMaxNoOpRounds: intEnv("RALPH_REVIEW_MAX_NOOP_ROUNDS", 2, env),
    reviewMaxRepeatDiffRounds: intEnv("RALPH_REVIEW_MAX_REPEAT_DIFF_ROUNDS", 2, env),
    reviewMaxReviewerFailures: intEnv("RALPH_REVIEW_MAX_REVIEWER_FAILURES", 2, env),

    verbose: overrides.verbose ?? false,
    dryRun: overrides.dryRun ?? false,
  };
}
