#!/usr/bin/env bun
/**
 * Ralphloop CLI entrypoint.
 *
 * Subcommands:
 *   run        — drive the autonomous loop (default if no subcommand given)
 *   init       — scaffold a .ralphloop/ workspace in cwd
 *   doctor     — print resolved Config + validate workspace files
 *   archive ls — list rotated progress archives
 *
 * Designed for unattended operation: no prompts, no interactive output,
 * stable exit codes (0 = success / clean cap, 1 = failure / cap-with-failures,
 * 2 = pre-flight / argument error).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type ConfigOverrides } from "../src/Config.js";
import { runLoop } from "../src/loop.js";
import { runInit } from "../src/scaffolder.js";
import { resolveWorkspace, type WorkspaceCliFlags } from "../src/workspace.js";

const HELP = `Usage: ralphloop <subcommand> [options]

Subcommands:
  run                       drive the autonomous loop (default)
  init                      scaffold .ralphloop/ in cwd
  doctor                    print resolved Config + validate workspace
  archive ls                list rotated progress archives

Common options (apply to every subcommand):
  --cwd <dir>               working directory (default: process.cwd())
  --workspace <dir>         workspace dir (default: <cwd>/.ralphloop)
  --config <file>           config.yaml path (default: <workspaceDir>/config.yaml)
  --repo <dir>              repo root for goal/tasks/progress resolution (default: <cwd>)
  --goal <file>             project spec (default: <repoRoot>/GOAL.md)
  --help, -h                show this message

\`run\` options:
  --max-iterations <N>      override RALPH_MAX_ITERATIONS (default 50)
  --verbose                 stream every agent line to the console
  --dry-run                 print the next task and exit (no spawn / commit)
  --no-review               disable the reviewer→fixer sub-loop
  --review-max-rounds <N>   override RALPH_REVIEW_MAX_ROUNDS (default 5)

\`init\` options:
  --create-goal-stub        create a stub GOAL.md at <repoRoot> if missing

Selected environment variables (full list: README.md):
  RALPH_CLAUDE_BIN          path to claude CLI (default 'claude')
  RALPH_CLAUDE_MODEL        agent model (default 'claude-sonnet-4-6')
  RALPH_REVIEWER_MODEL      reviewer model (default 'claude-opus-4-7')
  RALPH_FIXER_MODEL         fixer model (default 'claude-sonnet-4-6')
  RALPH_WORKSPACE_DIR       same as --workspace
  RALPH_GOAL_FILE           same as --goal
  RALPH_CONFIG_FILE         same as --config

Config precedence: CLI flag > env var > .ralphloop/config.yaml > built-in default.
`;

interface ParsedArgs {
  subcommand: "run" | "init" | "doctor" | "archive" | "help";
  archiveAction?: "ls";
  workspaceFlags: WorkspaceCliFlags;
  overrides: ConfigOverrides;
  createGoalStub: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    subcommand: "run",
    workspaceFlags: {},
    overrides: {},
    createGoalStub: false,
  };

  // Optional leading subcommand
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    const sub = argv[0];
    if (sub === "run" || sub === "init" || sub === "doctor") {
      out.subcommand = sub;
      i = 1;
    } else if (sub === "archive") {
      out.subcommand = "archive";
      i = 1;
      if (argv[1] === "ls") {
        out.archiveAction = "ls";
        i = 2;
      }
    } else if (sub === "help") {
      out.subcommand = "help";
      return out;
    } else {
      process.stderr.write(`ralphloop: unknown subcommand '${sub}'\n`);
      process.exit(2);
    }
  }

  for (; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`ralphloop: ${a} requires a value\n`);
        process.exit(2);
      }
      return v;
    };
    const nextInt = (): number => {
      const v = next();
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) {
        process.stderr.write(`ralphloop: ${a} expects a positive integer, got '${v}'\n`);
        process.exit(2);
      }
      return n;
    };

    switch (a) {
      case "--help":
      case "-h":
        out.subcommand = "help";
        return out;
      case "--cwd":
        out.workspaceFlags.cwd = next();
        break;
      case "--workspace":
        out.workspaceFlags.workspace = next();
        break;
      case "--config":
        out.workspaceFlags.config = next();
        break;
      case "--repo":
        out.workspaceFlags.repo = next();
        break;
      case "--goal":
        out.workspaceFlags.goal = next();
        out.overrides.goalFile = out.workspaceFlags.goal;
        break;
      case "--verbose":
      case "-v":
        out.overrides.verbose = true;
        break;
      case "--dry-run":
        out.overrides.dryRun = true;
        break;
      case "--max-iterations":
        out.overrides.maxIterations = nextInt();
        break;
      case "--no-review":
        out.overrides.reviewEnabled = false;
        break;
      case "--review-max-rounds":
        out.overrides.reviewMaxRounds = nextInt();
        break;
      case "--create-goal-stub":
        out.createGoalStub = true;
        break;
      default:
        if (a.startsWith("--")) {
          process.stderr.write(`ralphloop: unknown flag '${a}'\n`);
          process.exit(2);
        }
        process.stderr.write(`ralphloop: unexpected positional '${a}'\n`);
        process.exit(2);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.subcommand === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const workspace = resolveWorkspace({ cliFlags: args.workspaceFlags });

  switch (args.subcommand) {
    case "run": {
      const cfg = loadConfig({ workspace, overrides: args.overrides });
      const code = await runLoop(cfg);
      process.exit(code);
      break;
    }
    case "init": {
      const result = runInit({
        cwd: workspace.repoRoot,
        workspace: workspace.workspaceDir,
        goal: args.workspaceFlags.goal,
        createGoalStub: args.createGoalStub,
      });
      process.stdout.write(`ralphloop: scaffolded workspace at ${result.workspaceDir}\n`);
      for (const f of result.created) process.stdout.write(`  + ${f}\n`);
      for (const f of result.skipped) process.stdout.write(`  · ${f} (kept existing)\n`);
      process.stdout.write(
        `\nAdd these lines to your project's .gitignore:\n\n${result.gitignoreSuggestion}\n`,
      );
      process.exit(0);
      break;
    }
    case "doctor": {
      const cfg = loadConfig({ workspace, overrides: args.overrides });
      runDoctor(cfg, workspace.configPath);
      break;
    }
    case "archive": {
      if (args.archiveAction !== "ls") {
        process.stderr.write("ralphloop: archive subcommand requires 'ls'\n");
        process.exit(2);
      }
      const cfg = loadConfig({ workspace, overrides: args.overrides });
      listArchives(cfg.archiveDir);
      process.exit(0);
      break;
    }
  }
}

function runDoctor(cfg: Parameters<typeof runLoop>[0], configPath: string): void {
  const lines: string[] = [];
  const ok = (label: string, val: string): void => {
    lines.push(`  ✓ ${label.padEnd(18)} ${val}`);
  };
  const warn = (label: string, val: string): void => {
    lines.push(`  ! ${label.padEnd(18)} ${val}`);
  };

  lines.push("ralphloop doctor");
  lines.push("");
  ok("repoRoot", cfg.repoRoot);
  ok("workspaceDir", cfg.workspaceDir);
  ok("configFile", existsSync(configPath) ? configPath : `${configPath} (absent — using defaults)`);
  ok("goalFile", cfg.goalFile + (existsSync(cfg.goalFile) ? "" : "  (MISSING)"));
  ok("tasksFile", cfg.tasksFile + (existsSync(cfg.tasksFile) ? "" : "  (MISSING)"));
  ok("progressFile", cfg.progressFile + (existsSync(cfg.progressFile) ? "" : "  (MISSING)"));
  ok(
    "promptFile",
    cfg.promptFile + (existsSync(cfg.promptFile) ? "" : "  (override absent — using bundled)"),
  );
  ok("claudeBin", cfg.claudeBin);
  ok("claudeModel", cfg.claudeModel);
  ok(
    "review",
    cfg.reviewEnabled ? `enabled (reviewer=${cfg.reviewerModel}, fixer=${cfg.fixerModel})` : "disabled",
  );
  ok("maxIterations", String(cfg.maxIterations));
  ok("stopMarker", cfg.stopMarker);
  ok("commitPrefixes", `${cfg.commitTaskPrefix}(...) / ${cfg.commitReviewPrefix}(..., round K)`);

  const missing = [cfg.goalFile, cfg.tasksFile, cfg.progressFile].filter((f) => !existsSync(f));
  if (missing.length > 0) {
    warn("status", `${missing.length} required file(s) missing — run \`ralphloop init\``);
  } else {
    ok("status", "workspace ready");
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(missing.length > 0 ? 1 : 0);
}

function listArchives(archiveDir: string): void {
  if (!existsSync(archiveDir)) {
    process.stdout.write(`ralphloop: no archive dir at ${archiveDir}\n`);
    return;
  }
  const files = readdirSync(archiveDir).filter((f) => f.startsWith("progress-")).sort();
  if (files.length === 0) {
    process.stdout.write(`ralphloop: ${archiveDir} is empty\n`);
    return;
  }
  for (const f of files) {
    const full = resolve(archiveDir, f);
    const st = statSync(full);
    process.stdout.write(`  ${f}  ${st.size}B  ${st.mtime.toISOString()}\n`);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`ralphloop: fatal: ${e.stack ?? e.message ?? String(err)}\n`);
  process.exit(1);
});
