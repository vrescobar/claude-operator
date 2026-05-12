/**
 * Resolved ralph runtime configuration.
 *
 * Defaults mirror `ralph/loop.sh` exactly, so swapping the bash entry point
 * for `bun ralph/run.ts` does not change behaviour. Every field is overridable
 * via env var (same names as the bash version) or via CLI flag in `run.ts`.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Repo root (parent of the ralph directory). */
  repoRoot: string;
  /** Directory containing tasks.md, progress.md, prompt.md, logs/. */
  ralphDir: string;
  /** Path to ralph/tasks.md. */
  tasksFile: string;
  /** Path to ralph/progress.md. */
  progressFile: string;
  /** Path to ralph/prompt.md. */
  promptFile: string;
  /** Path to ralph/logs/. */
  logsDir: string;
  /** Path to the lockfile that prevents concurrent runs. */
  lockFile: string;
  /** Path to the persisted state file (per-task attempts, counters). */
  stateFile: string;
  /** Path to the per-iteration metrics JSONL file. */
  metricsFile: string;

  /** Hard cap on iterations (default 50). */
  maxIterations: number;
  /** Stop marker matched anchored against progress.md (default "TASK_COMPLETE"). */
  stopMarker: string;
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
   * Logs in `ralph/logs/` older than this many days are pruned at start.
   * 0 disables pruning. Default 14.
   */
  logRetentionDays: number;
  /**
   * If `progress.md` exceeds this many bytes, the loop archives the current
   * file to `progress.archive-<ts>.md` (gitignored) and starts a fresh one
   * containing only the trailing `progressTailKeepBytes` bytes.
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
   * before the round is considered diverged. The sub-loop now retries on RL
   * indefinitely under this cap (instead of burning a small retry budget
   * unrelated to the agent's authoring quality), so this only fires if a
   * reviewer/fixer can't make any forward progress at all. Default 10.
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface ConfigOverrides {
  verbose?: boolean;
  dryRun?: boolean;
  maxIterations?: number;
  reviewEnabled?: boolean;
  reviewMaxRounds?: number;
}

function parseFailResetMode(raw: string | undefined): "stash" | "reset" | "leave" {
  if (raw === undefined || raw === "") return "stash";
  const v = raw.toLowerCase();
  if (v === "stash" || v === "reset" || v === "leave") return v;
  return "stash";
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  return fallback;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  // ralph/Config.ts → ralph/ → repo root
  const ralphDir = resolve(__dirname);
  const repoRoot = resolve(ralphDir, "..");

  const maxIterations = overrides.maxIterations ?? intEnv("RALPH_MAX_ITERATIONS", 50);
  const claudeBin = process.env["RALPH_CLAUDE_BIN"] || "claude";

  return {
    repoRoot,
    ralphDir,
    tasksFile: resolve(ralphDir, "tasks.md"),
    progressFile: resolve(ralphDir, "progress.md"),
    promptFile: resolve(ralphDir, "prompt.md"),
    logsDir: resolve(ralphDir, "logs"),
    lockFile: resolve(ralphDir, ".lock"),
    stateFile: resolve(ralphDir, ".state.json"),
    metricsFile: resolve(ralphDir, ".metrics.jsonl"),

    maxIterations,
    stopMarker: process.env["RALPH_STOP_MARKER"] || "TASK_COMPLETE",
    claudeBin,
    claudeModel: process.env["RALPH_CLAUDE_MODEL"] || "claude-sonnet-4-6",
    claudeTimeoutMs: intEnv("RALPH_CLAUDE_TIMEOUT_S", 1800) * 1000,
    testTimeoutMs: intEnv("RALPH_TEST_TIMEOUT_S", 600) * 1000,
    gitTimeoutMs: intEnv("RALPH_GIT_TIMEOUT_S", 60) * 1000,
    noChangeRetryLimit: intEnv("RALPH_NO_CHANGE_RETRY_LIMIT", 2),
    taskAttemptLimit: intEnv("RALPH_TASK_ATTEMPT_LIMIT", 5),
    failResetMode: parseFailResetMode(process.env["RALPH_FAIL_RESET"]),
    rateLimitFallbackMs: intEnv("RALPH_RATE_LIMIT_FALLBACK_MS", 5 * 60 * 1000),
    rateLimitFallbackCapMs: intEnv("RALPH_RATE_LIMIT_FALLBACK_CAP_MS", 60 * 60 * 1000),
    rateLimitJitterMs: intEnv("RALPH_RATE_LIMIT_JITTER_MS", 30_000),
    minRateLimitSleepMs: intEnv("RALPH_MIN_RATE_LIMIT_SLEEP_MS", 10_000),
    agentMaxBufferBytes: intEnv("RALPH_AGENT_MAX_BUFFER_BYTES", 50 * 1024 * 1024),
    typecheckEnabled: boolEnv("RALPH_TYPECHECK_ENABLED", true),
    logRetentionDays: intEnv("RALPH_LOG_RETENTION_DAYS", 14),
    progressMaxBytes: intEnv("RALPH_PROGRESS_MAX_BYTES", 64 * 1024),
    progressTailKeepBytes: intEnv("RALPH_PROGRESS_TAIL_KEEP_BYTES", 8 * 1024),

    reviewEnabled: overrides.reviewEnabled ?? boolEnv("RALPH_REVIEW_ENABLED", true),
    reviewerBin: process.env["RALPH_REVIEWER_BIN"] || claudeBin,
    reviewerModel: process.env["RALPH_REVIEWER_MODEL"] || "claude-opus-4-7",
    reviewerTimeoutMs: intEnv("RALPH_REVIEWER_TIMEOUT_S", 600) * 1000,
    fixerBin: process.env["RALPH_FIXER_BIN"] || claudeBin,
    fixerModel: process.env["RALPH_FIXER_MODEL"] || "claude-sonnet-4-6",
    fixerTimeoutMs: intEnv("RALPH_FIXER_TIMEOUT_S", 600) * 1000,
    reviewMaxRounds: overrides.reviewMaxRounds ?? intEnv("RALPH_REVIEW_MAX_ROUNDS", 5),
    // The env var keeps its old name for backwards-compat with existing
    // operator configs; semantics are documented on the Config field.
    reviewRlMaxConsecutiveHits: intEnv("RALPH_REVIEW_RL_RETRIES_PER_ROUND", 10),
    reviewMaxNoOpRounds: intEnv("RALPH_REVIEW_MAX_NOOP_ROUNDS", 2),
    reviewMaxRepeatDiffRounds: intEnv("RALPH_REVIEW_MAX_REPEAT_DIFF_ROUNDS", 2),
    reviewMaxReviewerFailures: intEnv("RALPH_REVIEW_MAX_REVIEWER_FAILURES", 2),

    verbose: overrides.verbose ?? false,
    dryRun: overrides.dryRun ?? false,
  };
}
