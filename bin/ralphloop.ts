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

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentProcess } from "../src/AgentProcess.js";
import { CLAUDE_P_PINNED_VERSION, resolveBackend } from "../src/AgentBackend.js";
import { loadConfig, type Config, type ConfigOverrides } from "../src/Config.js";
import { currentHeadSha } from "../src/GitOps.js";
import { Logger } from "../src/Logger.js";
import { defaultRunTests, runLoop } from "../src/loop.js";
import { archiveClosedPhases } from "../src/PhaseArchive.js";
import { runIntegrationReview } from "../src/review/integration.js";
import { runInit } from "../src/scaffolder.js";
import { getTaskState, loadState, saveState } from "../src/State.js";
import * as Systemd from "../src/SystemdManager.js";
import { listBlockedTaskIds, reopenBlockedTask } from "../src/TaskFile.js";
import { formatLocal } from "../src/time.js";
import { resolveWorkspace, type WorkspaceCliFlags } from "../src/workspace.js";

const HELP = `Usage: ralphloop <subcommand> [options]

Subcommands:
  run                       drive the autonomous loop (default)
  retry-blocked             reopen [!] blocked tasks, rerun them, then run a
                            final Opus integration review over the batch
  init                      scaffold .ralphloop/ in cwd
  doctor                    print resolved Config + validate workspace
  archive ls                list rotated progress archives
  archive phases            move closed phases out of tasks.md (also runs
                            automatically before each \`run\`)

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
  --backend <name>          agent backend: claude-p (default) or claude
  --claude-p                shorthand for --backend claude-p

\`run --nohup\` options (background mode, systemd user — Linux only):
  --nohup                   install/start a systemd user service so the loop
                            survives terminal exit; idempotent (start-or-status)
  --status                  with --nohup: print service status + recent journal
  --logs [N]                with --nohup: print last N journal lines (default 50)
  --cancel                  with --nohup: stop, disable, remove the unit file
  --restart                 with --nohup: systemctl restart the service
  Requires systemd user. Survives logout if \`loginctl enable-linger\` is set.

\`retry-blocked\` options:
  --force                   reopen blocked tasks even if still within the
                            cooldown window (RALPH_BLOCKED_RETRY_COOLDOWN_HOURS)
  --max-iterations <N>      iteration cap for the rerun
  --verbose                 stream every agent line to the console

\`init\` options:
  --create-goal-stub        create a stub GOAL.md at <repoRoot> if missing

Selected environment variables (full list: README.md):
  RALPH_CLAUDE_BIN          path to claude CLI (default 'claude')
  RALPH_CLAUDE_P_BIN        path to claude-p CLI (default 'claude-p')
  RALPH_AGENT_BACKEND       agent backend: claude | claude-p (default 'claude-p')
  RALPH_CLAUDE_MODEL        agent model (default 'claude-sonnet-4-6')
  RALPH_REVIEWER_MODEL      reviewer model (default 'claude-opus-4-7')
  RALPH_FIXER_MODEL         fixer model (default 'claude-sonnet-4-6')
  RALPH_WORKSPACE_DIR       same as --workspace
  RALPH_GOAL_FILE           same as --goal
  RALPH_CONFIG_FILE         same as --config

Config precedence: CLI flag > env var > .ralphloop/config.yaml > built-in default.
`;

type NohupAction = "start-or-status" | "status" | "logs" | "cancel" | "restart";

interface ParsedArgs {
  subcommand: "run" | "retry-blocked" | "init" | "doctor" | "archive" | "help";
  archiveAction?: "ls" | "phases";
  workspaceFlags: WorkspaceCliFlags;
  overrides: ConfigOverrides;
  createGoalStub: boolean;
  /** `--force` — reopen blocked tasks despite the cooldown (retry-blocked). */
  force: boolean;
  /** `--nohup` — manage `run` as a systemd-user background service. */
  nohup: boolean;
  /** Which sub-action of `--nohup` to run. */
  nohupAction: NohupAction;
  /** `--logs N` — number of journal lines to print under `--nohup --logs`. */
  nohupLogLines: number;
  /** Original argv slice (post-subcommand) — forwarded into the unit ExecStart. */
  rawRunArgs: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    subcommand: "run",
    workspaceFlags: {},
    overrides: {},
    createGoalStub: false,
    force: false,
    nohup: false,
    nohupAction: "start-or-status",
    nohupLogLines: 50,
    rawRunArgs: [],
  };

  // Optional leading subcommand
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    const sub = argv[0];
    if (sub === "run" || sub === "init" || sub === "doctor" || sub === "retry-blocked") {
      out.subcommand = sub;
      i = 1;
    } else if (sub === "archive") {
      out.subcommand = "archive";
      i = 1;
      if (argv[1] === "ls") {
        out.archiveAction = "ls";
        i = 2;
      } else if (argv[1] === "phases") {
        out.archiveAction = "phases";
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

  // Capture the post-subcommand argv slice so we can forward it verbatim into
  // the systemd unit's ExecStart (minus the --nohup family). Done before
  // mutation so we keep the user's original ordering.
  if (out.subcommand === "run") out.rawRunArgs = argv.slice(i);

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
      case "--backend":
        out.overrides.agentBackend = resolveBackend(next());
        break;
      case "--claude-p":
        out.overrides.agentBackend = "claude-p";
        break;
      case "--create-goal-stub":
        out.createGoalStub = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--nohup":
        out.nohup = true;
        break;
      case "--status":
        out.nohupAction = "status";
        break;
      case "--cancel":
        out.nohupAction = "cancel";
        break;
      case "--restart":
        out.nohupAction = "restart";
        break;
      case "--logs": {
        out.nohupAction = "logs";
        // --logs takes an optional integer; only consume the next token if it
        // parses cleanly so `--logs` alone keeps the default count.
        const peek = argv[i + 1];
        if (peek !== undefined && /^\d+$/.test(peek)) {
          const n = Number.parseInt(peek, 10);
          if (n >= 1) {
            out.nohupLogLines = n;
            i++;
          }
        }
        break;
      }
      default:
        if (a.startsWith("--")) {
          process.stderr.write(`ralphloop: unknown flag '${a}'\n`);
          process.exit(2);
        }
        process.stderr.write(`ralphloop: unexpected positional '${a}'\n`);
        process.exit(2);
    }
  }

  // Validate --nohup / sub-action combinations.
  if (!out.nohup && out.nohupAction !== "start-or-status") {
    process.stderr.write(
      "ralphloop: --status / --logs / --cancel / --restart require --nohup\n",
    );
    process.exit(2);
  }
  if (out.nohup && out.subcommand !== "run") {
    process.stderr.write("ralphloop: --nohup is only valid with the `run` subcommand\n");
    process.exit(2);
  }
  return out;
}

/**
 * Strip the --nohup family of flags from the original argv slice. The result
 * is what gets forwarded to the systemd unit's ExecStart so the background
 * process runs the same `run` invocation the user typed, minus the bits that
 * told us to background it.
 */
function stripNohupFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--nohup" || a === "--status" || a === "--cancel" || a === "--restart") {
      continue;
    }
    if (a === "--logs") {
      const peek = args[i + 1];
      if (peek !== undefined && /^\d+$/.test(peek)) i++;
      continue;
    }
    out.push(a);
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
      if (args.nohup) {
        const code = await runNohup(args, workspace.repoRoot);
        process.exit(code);
        break;
      }
      const cfg = loadConfig({ workspace, overrides: args.overrides });
      const code = await runLoop(cfg);
      process.exit(code);
      break;
    }
    case "retry-blocked": {
      const cfg = loadConfig({
        workspace,
        overrides: { ...args.overrides, runMode: "retry-blocked", reviewEnabled: false },
      });
      const code = await runRetryBlocked(cfg, args.force);
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
      const cfg = loadConfig({ workspace, overrides: args.overrides });
      if (args.archiveAction === "ls") {
        listArchives(cfg.archiveDir);
        process.exit(0);
      } else if (args.archiveAction === "phases") {
        const result = archiveClosedPhases({
          tasksFile: cfg.tasksFile,
          archiveDir: cfg.archiveDir,
        });
        if (result.archivedCount === 0) {
          process.stdout.write("ralphloop: no closed phases to archive.\n");
        } else {
          process.stdout.write(
            `ralphloop: archived ${result.archivedCount} phase(s) → ${result.archivePath}\n`,
          );
          for (const h of result.archivedHeadings) {
            process.stdout.write(`  · ${h}\n`);
          }
        }
        process.exit(0);
      } else {
        process.stderr.write("ralphloop: archive subcommand requires 'ls' or 'phases'\n");
        process.exit(2);
      }
      break;
    }
  }
}

/**
 * Dispatch the `run --nohup` action against systemd-user. Keeps the loop alive
 * after the controlling terminal exits by installing a per-project user
 * service. Idempotent: re-running `--nohup` against an already-active service
 * prints status + recent logs instead of starting a duplicate.
 *
 * Exit codes (deliberately distinct from foreground `run`):
 *   0 — success (incl. "already running, here's status")
 *   1 — service is in failed state, or stop/restart failed
 *   2 — systemd user not available on this host
 */
async function runNohup(args: ParsedArgs, repoRoot: string): Promise<number> {
  if (!(await Systemd.isAvailable())) {
    process.stderr.write(
      "ralphloop: systemd user not available on this host — --nohup needs `systemctl --user`\n",
    );
    return 2;
  }

  const serviceName = Systemd.serviceNameFor(repoRoot);

  switch (args.nohupAction) {
    case "status":
      return printStatus(serviceName, args.nohupLogLines);
    case "logs":
      return printStatus(serviceName, args.nohupLogLines);
    case "cancel": {
      const before = await Systemd.isActive(serviceName);
      const res = await Systemd.stopAndRemove(serviceName);
      if (!before && !res.removed) {
        process.stdout.write(
          `ralphloop: ${serviceName} was not installed — nothing to cancel\n`,
        );
        return 0;
      }
      process.stdout.write(
        `ralphloop: ${serviceName} stopped${res.removed ? " and unit file removed" : ""}\n`,
      );
      if (res.stderr.trim().length > 0 && /failed/i.test(res.stderr)) {
        process.stderr.write(res.stderr);
        return 1;
      }
      return 0;
    }
    case "restart": {
      const r = await Systemd.restart(serviceName);
      if (r.exitCode !== 0) {
        process.stderr.write(`ralphloop: restart failed (exit ${r.exitCode})\n${r.stderr}`);
        return 1;
      }
      process.stdout.write(`ralphloop: ${serviceName} restarted\n`);
      await Systemd.delay(800);
      return printStatus(serviceName, 20);
    }
    case "start-or-status": {
      if (await Systemd.isActive(serviceName)) {
        process.stdout.write(`ralphloop: ${serviceName} already active — showing status\n`);
        return printStatus(serviceName, 20);
      }
      if (await Systemd.isFailed(serviceName)) {
        process.stdout.write(
          `ralphloop: ${serviceName} is in 'failed' state — recent logs follow.\n` +
            "  Use `--nohup --restart` to retry, or `--nohup --cancel` to remove.\n",
        );
        await printStatus(serviceName, 30);
        return 1;
      }
      return startNew(args, repoRoot, serviceName);
    }
  }
}

async function startNew(
  args: ParsedArgs,
  repoRoot: string,
  serviceName: string,
): Promise<number> {
  const forwarded = stripNohupFlags(args.rawRunArgs);
  const bunPath = process.execPath; // we're already running under bun
  const ralphloopBin = resolve(process.argv[1] ?? "");
  if (ralphloopBin === "") {
    process.stderr.write("ralphloop: cannot resolve own bin path for ExecStart\n");
    return 1;
  }

  const env: Record<string, string> = {};
  if (process.env["PATH"]) env["PATH"] = process.env["PATH"];
  if (process.env["HOME"]) env["HOME"] = process.env["HOME"];
  // Pass through every RALPH_* override visible in the calling shell, so the
  // background service sees the same env as a foreground invocation would.
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("RALPH_") && typeof v === "string") env[k] = v;
  }

  const unitPath = await Systemd.writeUnit(serviceName, {
    description: `ralphloop runloop for ${repoRoot}`,
    workingDirectory: repoRoot,
    execCommand: bunPath,
    execArgs: [ralphloopBin, "run", ...forwarded],
    env,
  });

  const start = await Systemd.enableStart(serviceName);
  if (start.exitCode !== 0) {
    process.stderr.write(
      `ralphloop: enable --now failed (exit ${start.exitCode})\n${start.stderr}`,
    );
    await printStatus(serviceName, 20);
    return 1;
  }

  // Give systemd a moment to transition into active/failed.
  await Systemd.delay(1_000);
  const status = await Systemd.getStatus(serviceName, 20);
  if (status.failed || (!status.active && status.subState === "dead")) {
    process.stderr.write(
      `ralphloop: ${serviceName} failed to start (state=${status.activeState}/${status.subState})\n`,
    );
    process.stderr.write("  recent journal:\n");
    for (const l of status.recentLogs) process.stderr.write(`    ${l}\n`);
    return 1;
  }

  process.stdout.write(
    `ralphloop: ${serviceName} started — state=${status.activeState}/${status.subState}` +
      (status.mainPid !== null ? ` pid=${status.mainPid}` : "") +
      "\n",
  );
  process.stdout.write(`  unit: ${unitPath}\n`);
  process.stdout.write(`  logs: journalctl --user -u ${serviceName} -f\n`);
  return 0;
}

async function printStatus(serviceName: string, lines: number): Promise<number> {
  const s = await Systemd.getStatus(serviceName, lines);
  process.stdout.write(`ralphloop: ${serviceName}\n`);
  process.stdout.write(`  state:  ${s.activeState} / ${s.subState}\n`);
  if (s.activeSince) process.stdout.write(`  since:  ${s.activeSince}\n`);
  if (s.mainPid !== null) process.stdout.write(`  pid:    ${s.mainPid}\n`);
  process.stdout.write(`  logs (last ${s.recentLogs.length}):\n`);
  for (const l of s.recentLogs) process.stdout.write(`    ${l}\n`);
  if (s.failed) return 1;
  return 0;
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
  ok("agentBackend", cfg.agentBackend);
  if (cfg.agentBackend === "claude-p") {
    if (claudePInstalled(cfg.claudePBin)) {
      ok(
        "claude-p",
        `${cfg.claudePBin} installed — pinned target v${CLAUDE_P_PINNED_VERSION} ` +
          "(verify: `uv tool list` or `pip show claude-p`)",
      );
    } else {
      warn(
        "claude-p",
        `${cfg.claudePBin} — not found / not runnable ` +
          `(uv tool install 'claude-p==${CLAUDE_P_PINNED_VERSION}')`,
      );
    }
  } else {
    ok("claudeBin", cfg.claudeBin);
  }
  ok("claudeModel", cfg.claudeModel);
  ok(
    "review",
    cfg.reviewEnabled ? `enabled (reviewer=${cfg.reviewerModel}, fixer=${cfg.fixerModel})` : "disabled",
  );
  ok("maxIterations", String(cfg.maxIterations));
  ok("stopMarker", cfg.stopMarker);
  ok("commitPrefixes", `${cfg.commitTaskPrefix}(...) / ${cfg.commitReviewPrefix}(..., round K)`);
  ok(
    "finishMerge",
    cfg.finishMerge
      ? `on success → merge work branch into '${cfg.finishMergeTargetBranch}' (--no-ff, local)`
      : "disabled (loop stays on the work branch)",
  );

  const missing = [cfg.goalFile, cfg.tasksFile, cfg.progressFile].filter((f) => !existsSync(f));
  if (missing.length > 0) {
    warn("status", `${missing.length} required file(s) missing — run \`ralphloop init\``);
  } else {
    ok("status", "workspace ready");
  }

  process.stdout.write(lines.join("\n") + "\n");
  process.exit(missing.length > 0 ? 1 : 0);
}

/**
 * `retry-blocked` — reopen `[!]` blocked tasks, rerun them with per-task
 * review off, then run one Opus integration review over the whole batch.
 */
async function runRetryBlocked(cfg: Config, force: boolean): Promise<number> {
  if (!existsSync(cfg.tasksFile)) {
    process.stderr.write(`ralphloop: tasks file missing: ${cfg.tasksFile}\n`);
    return 2;
  }
  const blockedIds = listBlockedTaskIds(cfg.tasksFile);
  if (blockedIds.length === 0) {
    process.stdout.write("ralphloop: no blocked [!] tasks to retry.\n");
    return 0;
  }

  const state = loadState(cfg.stateFile);
  const cooldownMs = cfg.blockedRetryCooldownHours * 3_600_000;
  const now = Date.now();
  const reopened: string[] = [];

  process.stdout.write(`ralphloop: ${blockedIds.length} blocked task(s) found\n`);
  for (const id of blockedIds) {
    const ts = state.tasks[id];
    const blockedAtMs = ts?.blockedAt ? Date.parse(ts.blockedAt) : NaN;
    const ageMs = Number.isFinite(blockedAtMs) ? now - blockedAtMs : Infinity;
    if (!force && Number.isFinite(blockedAtMs) && ageMs < cooldownMs) {
      process.stdout.write(
        `  · #${id} — blocked ${formatAge(ageMs)} ago, ` +
          `cooldown ${cfg.blockedRetryCooldownHours}h not met — skipped (use --force)\n`,
      );
      continue;
    }
    if (reopenBlockedTask(cfg.tasksFile, id)) {
      const tstate = getTaskState(state, id);
      tstate.attempts = 0;
      tstate.noChangeAttempts = 0;
      tstate.blocked = false;
      reopened.push(id);
      const age = Number.isFinite(ageMs) ? `blocked ${formatAge(ageMs)} ago` : "no block timestamp";
      process.stdout.write(`  + #${id} reopened (${age})\n`);
    }
  }
  saveState(cfg.stateFile, state);

  if (reopened.length === 0) {
    process.stdout.write(
      "ralphloop: nothing reopened — all blocked tasks are still cooling down (use --force).\n",
    );
    return 0;
  }

  // Base of the integration-review diff: HEAD before the batch runs.
  const firstSha = await currentHeadSha({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });

  // Rerun the reopened tasks — per-task review is off in retry-blocked mode.
  const code = await runLoop(cfg);

  // Integration review over the whole batch, on Opus.
  const headNow = await currentHeadSha({ cwd: cfg.repoRoot, timeoutMs: cfg.gitTimeoutMs });
  if (!firstSha || !headNow || headNow === firstSha) {
    process.stdout.write("ralphloop: no commits produced — skipping integration review.\n");
    return code;
  }

  const log = new Logger({ verbose: cfg.verbose });
  log.info(`integration review — Opus pass over ${reopened.length} reopened task(s)`);
  const abortCtl = new AbortController();
  let activeAgent: AgentProcess | null = null;
  const onSignal = (): void => {
    abortCtl.abort(new Error("ralphloop: shutting down"));
    void activeAgent?.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const outcome = await runIntegrationReview({
      cfg,
      firstSha,
      taskIds: reopened,
      log,
      runTests: () => defaultRunTests(cfg, log),
      abortSignal: abortCtl.signal,
      registerAgent: (a) => {
        activeAgent = a;
      },
      clearAgent: () => {
        activeAgent = null;
      },
    });
    if (outcome.kind === "converged") {
      log.done(`integration review APPROVED after ${outcome.rounds} round(s)`);
      return code;
    }
    log.warn(
      `integration review did not converge (${outcome.kind}) — ` +
        `inspect ${cfg.logsDir}`,
    );
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Compact human age for the retry-blocked cooldown report. */
function formatAge(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Best-effort `claude-p --doctor` probe for `doctor`. `claude-p --version`
 * forwards to the underlying `claude` (drop-in `claude -p` compat), so it
 * cannot report the wrapper's own version — `--doctor` is used purely to
 * confirm claude-p is installed and runnable.
 */
function claudePInstalled(bin: string): boolean {
  try {
    const r = spawnSync(bin, ["--doctor"], { encoding: "utf8", timeout: 15_000 });
    if (r.error) return false;
    return /claude-p doctor/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  } catch {
    return false;
  }
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
    process.stdout.write(`  ${f}  ${st.size}B  ${formatLocal(st.mtime)}\n`);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`ralphloop: fatal: ${e.stack ?? e.message ?? String(err)}\n`);
  process.exit(1);
});
