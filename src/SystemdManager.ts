/**
 * Systemd-user lifecycle helpers for `ralphloop run --nohup`.
 *
 * Each consumer project gets its own user service so multiple ralphloop runs
 * can coexist on the same host without colliding (one per repo). The unit
 * file is regenerated on every `start` to keep ExecStart in sync with the
 * forwarded CLI flags, and `stop` removes the unit entirely so disabled
 * projects leave no residue under `~/.config/systemd/user/`.
 *
 * This module shells out to `systemctl --user` / `journalctl --user` via
 * execa. It never assumes systemd is available — call `isAvailable()` first
 * and surface a clear error from the caller if it returns false.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { execa } from "execa";
import { atomicWriteFileSync } from "./atomic.js";

const USER_UNIT_DIR = resolve(homedir(), ".config/systemd/user");

export interface UnitSpec {
  description: string;
  workingDirectory: string;
  /** argv[0] of the ExecStart command (e.g. the absolute path to `bun`). */
  execCommand: string;
  /** argv[1..] for ExecStart — already split, will be shell-quoted. */
  execArgs: string[];
  /** Extra `Environment=KEY=VALUE` entries; PATH/HOME are added separately. */
  env: Record<string, string>;
}

export interface ServiceStatus {
  /** True iff ActiveState is "active" or "activating". */
  active: boolean;
  /** True iff ActiveState is "failed". */
  failed: boolean;
  /** systemctl ActiveState (e.g. "active", "inactive", "failed", "unknown"). */
  activeState: string;
  /** systemctl SubState ("running", "dead", "exited", ...). */
  subState: string;
  /** ActiveEnterTimestamp as raw systemd string, or null. */
  activeSince: string | null;
  /** MainPID or null when not running. */
  mainPid: number | null;
  /** Last N lines from journalctl, newest last. */
  recentLogs: string[];
}

/** Sanitize a project name into a systemd-safe service stem. */
export function sanitize(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

/** Derive the per-project service name from a repo root path. */
export function serviceNameFor(repoRoot: string): string {
  return `ralphloop-${sanitize(basename(resolve(repoRoot)))}.service`;
}

/** Absolute path of the unit file under ~/.config/systemd/user/. */
export function unitPath(serviceName: string): string {
  return resolve(USER_UNIT_DIR, serviceName);
}

/**
 * Cheap probe: does `systemctl --user --version` exit cleanly? When this
 * returns false, --nohup cannot do anything useful and the CLI exits 2.
 */
export async function isAvailable(): Promise<boolean> {
  try {
    const r = await execa("systemctl", ["--user", "--version"], {
      reject: false,
      stdin: "ignore",
      timeout: 5_000,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Quote a single shell argument for inclusion in an ExecStart= line. */
function shellQuote(arg: string): string {
  if (arg === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Render a complete user-unit file body. */
export function renderUnit(spec: UnitSpec): string {
  const execLine = [spec.execCommand, ...spec.execArgs].map(shellQuote).join(" ");
  const envLines = Object.entries(spec.env)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `Environment=${k}=${v}`);

  const service: string[] = [
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${spec.workingDirectory}`,
    `ExecStart=${execLine}`,
    "Restart=on-failure",
    "RestartSec=5",
    ...envLines,
    "StandardOutput=journal",
    "StandardError=journal",
  ];

  const sections = [
    ["[Unit]", `Description=${spec.description}`, "After=default.target"].join("\n"),
    service.join("\n"),
    ["[Install]", "WantedBy=default.target"].join("\n"),
  ];

  return sections.join("\n\n") + "\n";
}

async function systemctl(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await execa("systemctl", ["--user", ...args], {
    reject: false,
    stdin: "ignore",
    timeout: 15_000,
  });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function daemonReload(): Promise<void> {
  await systemctl(["daemon-reload"]);
}

/** Write or rewrite the unit file then reload. */
export async function writeUnit(serviceName: string, spec: UnitSpec): Promise<string> {
  if (!existsSync(USER_UNIT_DIR)) mkdirSync(USER_UNIT_DIR, { recursive: true });
  const path = unitPath(serviceName);
  atomicWriteFileSync(path, renderUnit(spec));
  await daemonReload();
  return path;
}

export async function enableStart(serviceName: string): Promise<{ exitCode: number; stderr: string }> {
  const r = await systemctl(["enable", "--now", serviceName]);
  return { exitCode: r.exitCode, stderr: r.stderr };
}

export async function restart(serviceName: string): Promise<{ exitCode: number; stderr: string }> {
  const r = await systemctl(["restart", serviceName]);
  return { exitCode: r.exitCode, stderr: r.stderr };
}

/** Stop, disable, remove the unit file, daemon-reload. */
export async function stopAndRemove(
  serviceName: string,
): Promise<{ removed: boolean; stderr: string }> {
  const r = await systemctl(["disable", "--now", serviceName]);
  const path = unitPath(serviceName);
  let removed = false;
  if (existsSync(path)) {
    rmSync(path, { force: true });
    removed = true;
  }
  await daemonReload();
  return { removed, stderr: r.stderr };
}

/** True iff the unit's ActiveState is "active" or "activating". */
export async function isActive(serviceName: string): Promise<boolean> {
  const r = await systemctl(["is-active", serviceName]);
  const v = r.stdout.trim();
  return v === "active" || v === "activating" || v === "reloading";
}

/** True iff the unit's ActiveState is "failed". */
export async function isFailed(serviceName: string): Promise<boolean> {
  const r = await systemctl(["is-failed", serviceName]);
  return r.stdout.trim() === "failed";
}

/** Parse `systemctl show ... -p K=V` output into a map. */
function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** Fetch ActiveState/SubState/MainPID/ActiveEnterTimestamp + last N journal lines. */
export async function getStatus(serviceName: string, logLines = 50): Promise<ServiceStatus> {
  const show = await systemctl([
    "show",
    serviceName,
    "-p",
    "ActiveState,SubState,MainPID,ActiveEnterTimestamp",
  ]);
  const fields = parseShow(show.stdout);
  const activeState = fields["ActiveState"] ?? "unknown";
  const subState = fields["SubState"] ?? "unknown";
  const pidStr = fields["MainPID"] ?? "0";
  const since = fields["ActiveEnterTimestamp"] ?? "";
  const mainPid = Number.parseInt(pidStr, 10);

  const journal = await execa(
    "journalctl",
    ["--user", "-u", serviceName, "-n", String(logLines), "--no-pager", "-o", "short-iso"],
    { reject: false, stdin: "ignore", timeout: 15_000 },
  );

  const logs = (journal.stdout ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  return {
    active: activeState === "active" || activeState === "activating",
    failed: activeState === "failed",
    activeState,
    subState,
    activeSince: since.length > 0 ? since : null,
    mainPid: Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null,
    recentLogs: logs,
  };
}

/** Sleep helper — used to give systemd a moment after `enable --now`. */
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
