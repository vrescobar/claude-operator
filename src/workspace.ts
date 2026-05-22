/**
 * Workspace + config-file resolution.
 *
 * Decides where the consumer's `.ralphloop/` workspace lives, where the project
 * spec (GOAL.md) lives, and what the `.ralphloop/config.yaml` says — without
 * yet building the full runtime Config. `loadConfig` in `Config.ts` consumes
 * the output here and layers env-var + CLI-flag defaults on top.
 *
 * Precedence (highest first): CLI flag > env var > config file > built-in default.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface WorkspaceCliFlags {
  workspace?: string;
  config?: string;
  repo?: string;
  goal?: string;
  cwd?: string;
}

/**
 * Raw shape of `.ralphloop/config.yaml`. Every field is optional; the loader
 * is intentionally permissive (no schema validation beyond "is this a string
 * or a number where expected?"). Unknown keys are ignored.
 */
export interface RalphloopConfigFile {
  goal?: string;
  tasks?: string;
  progress?: string;
  prompt?: string;
  workspace?: string;
  repoRoot?: string;
  maxIterations?: number;
  stopMarker?: string;
  commit?: {
    taskPrefix?: string;
    reviewPrefix?: string;
  };
  /** Agent backend: "claude-p" (default) or "claude". */
  agentBackend?: string;
  claude?: {
    bin?: string;
    /** Binary for the "claude-p" backend (default "claude-p"). */
    pBin?: string;
    model?: string;
    timeoutS?: number;
  };
  review?: {
    enabled?: boolean;
    reviewerBin?: string;
    reviewerModel?: string;
    fixerBin?: string;
    fixerModel?: string;
    maxRounds?: number;
  };
  /** Auto-archive fully-closed `## Phase N` sections from tasks.md. Default true. */
  autoArchiveClosedPhases?: boolean;
  /**
   * What to do with the work branch when the run finishes successfully (all
   * tasks done / stop marker). Opt-in: defaults to no branch handling at all.
   */
  finish?: {
    /** Merge the work branch back into `targetBranch` (`--no-ff`). Default false. */
    merge?: boolean;
    /** Branch to merge into when `merge` is true. Default "main". */
    targetBranch?: string;
  };
  /** Hours a `[!]` task must stay blocked before `retry-blocked` reopens it. Default 6. */
  blockedRetryCooldownHours?: number;
}

export interface WorkspaceResolution {
  /** Repo root — the consumer's project directory. */
  repoRoot: string;
  /** Workspace dir — where state, lock, metrics, logs, archive live. */
  workspaceDir: string;
  /** Absolute path of the config file we tried to load (whether or not it exists). */
  configPath: string;
  /** Parsed contents of the config file, or null if absent / unreadable. */
  configData: RalphloopConfigFile | null;
}

/**
 * Resolve where the workspace lives given the CLI flags + environment.
 *
 * Strategy:
 *   workspaceDir  ← --workspace > RALPH_WORKSPACE_DIR > <cwd>/.ralphloop
 *   configPath    ← --config    > RALPH_CONFIG_FILE   > <workspaceDir>/config.yaml
 *   repoRoot      ← --repo      > RALPH_REPO_ROOT     > config.repoRoot > <cwd>
 */
export function resolveWorkspace(opts: {
  cwd?: string;
  cliFlags?: WorkspaceCliFlags;
  envVars?: NodeJS.ProcessEnv;
} = {}): WorkspaceResolution {
  const cwd = opts.cliFlags?.cwd ?? opts.cwd ?? process.cwd();
  const env = opts.envVars ?? process.env;
  const flags = opts.cliFlags ?? {};

  const workspaceDir = resolve(
    cwd,
    flags.workspace ?? env["RALPH_WORKSPACE_DIR"] ?? ".ralphloop",
  );

  const configPath = resolve(
    cwd,
    flags.config ?? env["RALPH_CONFIG_FILE"] ?? resolve(workspaceDir, "config.yaml"),
  );

  const configData = loadConfigFile(configPath);

  const repoRoot = resolve(
    cwd,
    flags.repo ?? env["RALPH_REPO_ROOT"] ?? configData?.repoRoot ?? cwd,
  );

  return { repoRoot, workspaceDir, configPath, configData };
}

/**
 * Read and parse a YAML config file. Returns null on any error (missing file,
 * unparseable YAML, etc.) — the caller falls back to env vars / defaults.
 */
export function loadConfigFile(path: string): RalphloopConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as RalphloopConfigFile;
  } catch {
    return null;
  }
}
