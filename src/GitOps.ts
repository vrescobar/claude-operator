/**
 * Git wrappers used by the loop. All commands are non-interactive and run
 * with hooks disabled, signing disabled, and a hard wall-clock timeout.
 *
 * Mirrors the `git_quiet` / `commit_task` / `has_changes` helpers in
 * `loop.sh` but with a typed surface and no hidden globals.
 */

import { execa } from "execa";

const GIT_BASE_FLAGS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "gpg.program=/bin/true",
] as const;

export interface GitOpsOptions {
  cwd: string;
  timeoutMs: number;
}

async function git(
  opts: GitOpsOptions,
  args: string[],
  extra: { reject?: boolean } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa("git", [...GIT_BASE_FLAGS, ...args], {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    reject: extra.reject ?? false,
    stdin: "ignore",
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** True iff `git status --porcelain` reports any changes. */
export async function hasChanges(opts: GitOpsOptions): Promise<boolean> {
  const r = await git(opts, ["status", "--porcelain"]);
  return r.stdout.trim().length > 0;
}

/** True iff `cwd` is a git repo. */
export async function isRepo(opts: GitOpsOptions): Promise<boolean> {
  const r = await git(opts, ["rev-parse", "--git-dir"]);
  return r.exitCode === 0;
}

/**
 * Detect whether the repo is in a state where commits won't apply cleanly
 * (mid-merge, mid-rebase, mid-cherry-pick). Returns the offending sentinel
 * file name when one is found, or null when the repo is clean.
 */
export async function detectInProgressOperation(opts: GitOpsOptions): Promise<string | null> {
  const r = await git(opts, ["rev-parse", "--git-dir"]);
  if (r.exitCode !== 0) return null; // not a repo — different problem
  const gitDir = r.stdout.trim();
  if (!gitDir) return null;
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const absGitDir = gitDir.startsWith("/") ? gitDir : resolve(opts.cwd, gitDir);
  const sentinels = [
    "MERGE_HEAD",
    "REBASE_HEAD",
    "CHERRY_PICK_HEAD",
    "rebase-apply",
    "rebase-merge",
  ];
  for (const s of sentinels) {
    if (existsSync(resolve(absGitDir, s))) return s;
  }
  return null;
}

/** Resolve the current HEAD SHA. Returns null on failure. */
export async function currentHeadSha(opts: GitOpsOptions): Promise<string | null> {
  const r = await git(opts, ["rev-parse", "HEAD"]);
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length === 40 ? sha : null;
}

/** Initialise a repo on `main` if absent. Falls back to a plain `init` on git < 2.28. */
export async function ensureRepo(opts: GitOpsOptions): Promise<void> {
  if (await isRepo(opts)) return;
  const withMain = await git(opts, ["init", "-q", "-b", "main"]);
  if (withMain.exitCode === 0) return;
  // Older git: `-b` not recognised. Fall back; the loop never depends on the
  // branch name, only on the repo being initialised.
  await git(opts, ["init", "-q"], { reject: true });
}

/** Set `user.email` / `user.name` if missing so commits never block on prompts. */
export async function ensureIdentity(opts: GitOpsOptions): Promise<void> {
  const email = await git(opts, ["config", "user.email"]);
  if (email.exitCode !== 0 || email.stdout.trim() === "") {
    await git(opts, ["config", "user.email", "ralph@ralph.local"]);
  }
  const name = await git(opts, ["config", "user.name"]);
  if (name.exitCode !== 0 || name.stdout.trim() === "") {
    await git(opts, ["config", "user.name", "Ralph Loop"]);
  }
}

export interface CommitResult {
  ok: boolean;
  exitCode: number;
  stderr: string;
}

/** Stage everything, then commit with the canonical Ralph message. */
export async function commitTask(
  opts: GitOpsOptions,
  taskId: string,
  taskTitle: string,
  prefix = "task",
): Promise<CommitResult> {
  const add = await git(opts, ["add", "-A"]);
  if (add.exitCode !== 0) {
    return { ok: false, exitCode: add.exitCode, stderr: add.stderr };
  }
  const msg = `${prefix}(${taskId}): ${taskTitle}\n\nCompleted by Ralph autonomous loop.`;
  const commit = await git(opts, ["commit", "--no-verify", "-m", msg]);
  return {
    ok: commit.exitCode === 0,
    exitCode: commit.exitCode,
    stderr: commit.stderr,
  };
}

/**
 * Discard or archive the agent's pending working-tree changes after a failed
 * iteration so the next attempt starts from HEAD instead of inheriting drift
 * from previous attempts. Behaviour:
 *
 *   - `"stash"`: `git stash push -u -m "<label>"`. The operator can `git stash
 *      list` later to recover any partial work. Falls back to a hard reset if
 *      stashing fails (e.g. only untracked files when stash refuses).
 *   - `"reset"`: `git reset --hard HEAD` + `git clean -fd`. Discards
 *      everything not committed.
 *   - `"leave"`: no-op (legacy behaviour).
 *
 * The lockfile (`ralph/.lock`) and the state file (`ralph/.state.json`) live
 * in `ralph/` and may be untracked at this point — they are excluded from the
 * `git clean` pathspec so we never delete our own runtime metadata.
 */
export async function cleanupFailedAttempt(
  opts: GitOpsOptions,
  mode: "stash" | "reset" | "leave",
  label: string,
): Promise<{ ok: boolean; mode: string; detail: string }> {
  if (mode === "leave") return { ok: true, mode: "leave", detail: "no-op" };

  if (mode === "stash") {
    // `-u` (--include-untracked) preserves new files. Gitignored files
    // (ralph/.lock, ralph/.state.json, ralph/.metrics.jsonl, ralph/logs/*) are
    // not touched by stash so we don't need explicit exclusions here.
    const stashed = await git(opts, ["stash", "push", "-u", "-m", label]);
    if (stashed.exitCode !== 0) {
      // Stash refuses (e.g. nothing to save) — fall through to reset.
      return resetHard(opts);
    }
    return { ok: true, mode: "stash", detail: label };
  }

  return resetHard(opts);
}

async function resetHard(opts: GitOpsOptions): Promise<{ ok: boolean; mode: string; detail: string }> {
  const r1 = await git(opts, ["reset", "--hard", "HEAD"]);
  // `git clean -fd` (without -x) leaves gitignored files alone, so the
  // lockfile / state file / logs survive intact.
  const r2 = await git(opts, ["clean", "-fd"]);
  const ok = r1.exitCode === 0 && r2.exitCode === 0;
  return { ok, mode: "reset", detail: ok ? "hard-reset" : `${r1.stderr || r2.stderr}`.trim() };
}

/**
 * Hard-reset HEAD to a specific SHA and clean untracked files. Used by the
 * outer loop to discard a failed review-fix chain when the sub-loop diverges
 * with tests still failing — the task agent gets a fresh shot from the same
 * task commit instead of inheriting the fixer's broken state.
 */
export async function resetToSha(
  opts: GitOpsOptions,
  sha: string,
): Promise<{ ok: boolean; detail: string }> {
  const r1 = await git(opts, ["reset", "--hard", sha]);
  const r2 = await git(opts, ["clean", "-fd"]);
  const ok = r1.exitCode === 0 && r2.exitCode === 0;
  return { ok, detail: ok ? `reset to ${sha.slice(0, 8)}` : `${r1.stderr || r2.stderr}`.trim() };
}

/** Stage everything, then commit a review-loop round. `status` is a short
 * tag that lands in the commit message ("apply review feedback" or
 * "WIP review fix (tests failing)"). */
export async function commitReviewRound(
  opts: GitOpsOptions,
  taskId: string,
  round: number,
  status: string,
  prefix = "review",
): Promise<CommitResult> {
  const add = await git(opts, ["add", "-A"]);
  if (add.exitCode !== 0) {
    return { ok: false, exitCode: add.exitCode, stderr: add.stderr };
  }
  const msg =
    `${prefix}(${taskId}, round ${round}): ${status}\n\n` +
    `Applied by Ralph autonomous review sub-loop.`;
  const commit = await git(opts, ["commit", "--no-verify", "-m", msg]);
  return {
    ok: commit.exitCode === 0,
    exitCode: commit.exitCode,
    stderr: commit.stderr,
  };
}
