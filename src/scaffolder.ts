/**
 * `ralphloop init` — scaffold a `.ralphloop/` workspace in the consumer repo.
 *
 * Idempotent: each destination file is only created if missing. Existing
 * tasks.md / progress.md / prompt.md / config.yaml are preserved so re-running
 * `init` after editing them is safe.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dir, "..");

export interface InitResult {
  workspaceDir: string;
  created: string[];
  skipped: string[];
  gitignoreSuggestion: string;
}

export interface InitOptions {
  /** Consumer repo root (defaults to process.cwd()). */
  cwd?: string;
  /** Workspace subdirectory (defaults to ".ralphloop"). */
  workspace?: string;
  /** Project spec filename (defaults to "GOAL.md"). */
  goal?: string;
  /**
   * If true, also create a stub GOAL.md at the repo root when missing. The
   * loop never writes to GOAL.md itself, but the consumer needs one for the
   * agent to read.
   */
  createGoalStub?: boolean;
}

export function runInit(opts: InitOptions = {}): InitResult {
  const cwd = opts.cwd ?? process.cwd();
  const workspaceDir = resolve(cwd, opts.workspace ?? ".ralphloop");
  const goalFile = resolve(cwd, opts.goal ?? "GOAL.md");

  mkdirSync(workspaceDir, { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];

  copyIfMissing(
    resolve(SUBMODULE_ROOT, "scaffold", "tasks.md.tmpl"),
    resolve(workspaceDir, "tasks.md"),
    created,
    skipped,
  );
  copyIfMissing(
    resolve(SUBMODULE_ROOT, "scaffold", "progress.md.tmpl"),
    resolve(workspaceDir, "progress.md"),
    created,
    skipped,
  );
  copyIfMissing(
    resolve(SUBMODULE_ROOT, "scaffold", "config.yaml.tmpl"),
    resolve(workspaceDir, "config.yaml"),
    created,
    skipped,
  );
  // The starter prompt is the bundled iteration.md — consumer can edit freely.
  copyIfMissing(
    resolve(SUBMODULE_ROOT, "prompts", "iteration.md"),
    resolve(workspaceDir, "prompt.md"),
    created,
    skipped,
  );

  if (opts.createGoalStub && !existsSync(goalFile)) {
    writeFileSync(
      goalFile,
      "# Project goal\n\nDescribe the project ralphloop is building here. " +
        "The agent reads this every iteration.\n",
    );
    created.push(goalFile);
  } else if (!existsSync(goalFile)) {
    // Don't auto-create GOAL.md by default — the consumer might already
    // maintain a spec elsewhere and only needs to point ralphloop at it.
  }

  const gitignoreSuggestion = readFileSync(
    resolve(SUBMODULE_ROOT, "scaffold", "gitignore.tmpl"),
    "utf8",
  );

  return { workspaceDir, created, skipped, gitignoreSuggestion };
}

function copyIfMissing(
  src: string,
  dst: string,
  created: string[],
  skipped: string[],
): void {
  if (existsSync(dst)) {
    skipped.push(dst);
    return;
  }
  copyFileSync(src, dst);
  created.push(dst);
}
