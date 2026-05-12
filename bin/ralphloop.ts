#!/usr/bin/env bun
/**
 * Ralph entrypoint — `bun ralph/run.ts` (or `bun run ralph` via package.json).
 *
 * Parses CLI flags, builds the Config, runs the loop. Designed for fully
 * unattended operation: no prompts, no interactive output, exit codes
 * compatible with the bash version.
 */

import { loadConfig, type ConfigOverrides } from "../src/Config.js";
import { runLoop } from "../src/loop.js";

interface ParsedFlags {
  overrides: ConfigOverrides;
  showHelp: boolean;
}

const HELP = `Usage: bun ralph/run.ts [options]

Drives the ralph autonomous loop: reads ralph/tasks.md, invokes \`claude -p\`
per iteration, runs tests, commits successful tasks. Resumes from wherever
it was last time (state lives entirely in tasks.md, progress.md, and git).

Options:
  --max-iterations <N>     override RALPH_MAX_ITERATIONS (default 50)
  --verbose                stream every claude output line to the console
  --dry-run                print the next task and exit, no spawn / commit
  --no-review              disable the reviewer→fixer sub-loop (default: enabled)
  --review-max-rounds <N>  override RALPH_REVIEW_MAX_ROUNDS (default 5)
  --help                   show this message

Environment variables (same as ralph/loop.sh):
  RALPH_CLAUDE_BIN              path to claude CLI (default 'claude')
  RALPH_CLAUDE_MODEL            model name (default 'claude-sonnet-4-6')
  RALPH_CLAUDE_TIMEOUT_S        per-iteration agent timeout (default 1800)
  RALPH_TEST_TIMEOUT_S          test gate timeout (default 600)
  RALPH_GIT_TIMEOUT_S           single git op timeout (default 60)
  RALPH_MAX_ITERATIONS          hard iteration cap (default 50)
  RALPH_NO_CHANGE_RETRY_LIMIT   no-diff retry budget per task (default 2)
  RALPH_TASK_ATTEMPT_LIMIT      per-task attempt cap before blocking (default 5)
  RALPH_FAIL_RESET              stash | reset | leave (default stash)
  RALPH_TYPECHECK_ENABLED       run "bun run typecheck" before tests (default 1)
  RALPH_LOG_RETENTION_DAYS      prune logs older than this at start (default 14)
  RALPH_PROGRESS_MAX_BYTES      rotate progress.md above this size (default 65536)
  RALPH_AGENT_MAX_BUFFER_BYTES  execa maxBuffer for the agent (default 50 MB)
  RALPH_RATE_LIMIT_FALLBACK_MS  sleep when rate-limit reset is unknown (default 3600000)
  RALPH_MIN_RATE_LIMIT_SLEEP_MS minimum rate-limit sleep (default 10000)
  RALPH_STOP_MARKER             stop sentinel string (default 'TASK_COMPLETE')

Review sub-loop:
  RALPH_REVIEW_ENABLED          0/1 toggle (default 1; --no-review forces 0)
  RALPH_REVIEWER_BIN            reviewer claude binary (default $RALPH_CLAUDE_BIN)
  RALPH_REVIEWER_MODEL          reviewer model (default 'claude-opus-4-7')
  RALPH_REVIEWER_TIMEOUT_S      reviewer wall-clock cap (default 600)
  RALPH_FIXER_BIN               fixer claude binary (default $RALPH_CLAUDE_BIN)
  RALPH_FIXER_MODEL             fixer model (default 'claude-sonnet-4-6')
  RALPH_FIXER_TIMEOUT_S         fixer wall-clock cap (default 600)
  RALPH_REVIEW_MAX_ROUNDS       sub-loop round cap (default 5)
  RALPH_REVIEW_RL_RETRIES_PER_ROUND        rate-limit retry budget per round (default 3)
  RALPH_REVIEW_MAX_NOOP_ROUNDS             halt after consecutive no-op fixer rounds (default 2)
  RALPH_REVIEW_MAX_REPEAT_DIFF_ROUNDS      halt after consecutive identical diffs (default 2)
  RALPH_REVIEW_MAX_REVIEWER_FAILURES       halt after consecutive reviewer crashes (default 2)
`;

function parseArgs(argv: string[]): ParsedFlags {
  const out: ParsedFlags = { overrides: {}, showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.showHelp = true;
    } else if (a === "--verbose" || a === "-v") {
      out.overrides.verbose = true;
    } else if (a === "--dry-run") {
      out.overrides.dryRun = true;
    } else if (a === "--max-iterations") {
      const next = argv[++i];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`ralph: --max-iterations expects a positive integer, got '${next}'\n`);
        process.exit(2);
      }
      out.overrides.maxIterations = n;
    } else if (a === "--no-review") {
      out.overrides.reviewEnabled = false;
    } else if (a === "--review-max-rounds") {
      const next = argv[++i];
      const n = next ? Number.parseInt(next, 10) : NaN;
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(
          `ralph: --review-max-rounds expects a positive integer, got '${next}'\n`,
        );
        process.exit(2);
      }
      out.overrides.reviewMaxRounds = n;
    } else if (a !== undefined && a.startsWith("--")) {
      process.stderr.write(`ralph: unknown flag '${a}'\n`);
      process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.showHelp) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const cfg = loadConfig(flags.overrides);
  const code = await runLoop(cfg);
  process.exit(code);
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`ralph: fatal: ${e.stack ?? e.message ?? String(err)}\n`);
  process.exit(1);
});
