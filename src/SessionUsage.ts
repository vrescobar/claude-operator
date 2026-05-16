/**
 * Token-usage recovery from Claude Code session transcripts.
 *
 * The `claude-p` backend reports placeholder usage ("the TUI does not expose
 * reliable token/cost data"). But the real numbers DO exist: `claude-p` passes
 * `--session-id` straight through to `claude`, and the TUI persists the
 * canonical transcript to `<claudeConfigDir>/projects/**\/<sessionId>.jsonl`.
 * Every `type:"assistant"` line in that file carries a real `message.usage`
 * block.
 *
 * Because ralphloop mints the session id itself (see `AgentBackend.ts`), after
 * the run we know exactly which transcript to read, and sum the per-turn usage
 * back into an `AgentUsage`. This is more accurate than diffing a global
 * counter "before/after" — it is the exact set of API calls for this run.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyUsage, type AgentUsage } from "./types.js";

/** `~/.claude/projects`, honouring the `CLAUDE_CONFIG_DIR` override. */
function claudeProjectsDir(): string {
  const base = process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Recursively find the most-recently-modified `<fileName>` under `dir`.
 * `claude` nests sessions one level deep (`projects/<cwd-slug>/<id>.jsonl`);
 * the small depth cap keeps a stray symlink from turning this into a full
 * filesystem walk.
 */
function findFile(dir: string, fileName: string, depth: number): string | null {
  let best: { path: string; mtime: number } | null = null;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth <= 0) continue;
      const found = findFile(full, fileName, depth - 1);
      if (found) best = pickNewer(best, found);
    } else if (e.name === fileName) {
      best = pickNewer(best, full);
    }
  }
  return best?.path ?? null;
}

function pickNewer(
  best: { path: string; mtime: number } | null,
  candidate: string,
): { path: string; mtime: number } {
  let mtime = 0;
  try {
    mtime = statSync(candidate).mtimeMs;
  } catch {
    // Unreadable — keep whatever we had.
    return best ?? { path: candidate, mtime: 0 };
  }
  if (!best || mtime > best.mtime) return { path: candidate, mtime };
  return best;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Sum the real token usage for a `claude` session id from its persisted
 * transcript. Returns null when the transcript can't be found or contains no
 * assistant `usage` block (so the caller can fall back gracefully).
 *
 * `projectsDir` is injectable for tests; production callers omit it.
 */
export function readSessionUsage(
  sessionId: string,
  projectsDir: string = claudeProjectsDir(),
): AgentUsage | null {
  const file = findFile(projectsDir, `${sessionId}.jsonl`, 6);
  if (!file) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const total = emptyUsage();
  let sawUsage = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const o = event as Record<string, unknown>;
    if (o["type"] !== "assistant") continue;
    const msg = o["message"];
    if (!msg || typeof msg !== "object") continue;
    const usage = (msg as Record<string, unknown>)["usage"];
    if (!usage || typeof usage !== "object") continue;
    const u = usage as Record<string, unknown>;
    sawUsage = true;
    // Each assistant turn is a separately-billed API call — summing per turn
    // is what reflects the real cost (input grows with context every turn).
    total.inputTokens += num(u["input_tokens"]);
    total.outputTokens += num(u["output_tokens"]);
    total.cacheReadInputTokens += num(u["cache_read_input_tokens"]);
    total.cacheCreationInputTokens += num(u["cache_creation_input_tokens"]);
  }
  return sawUsage ? total : null;
}
