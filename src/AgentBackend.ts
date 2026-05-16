/**
 * Agent backend selection.
 *
 * ralphloop can drive each agent invocation through one of two backends:
 *
 *   - `claude`   — the official Claude Code CLI (API-key billing). The
 *                  historical default; behaviour is byte-for-byte unchanged.
 *   - `claude-p` — the `claude-p` wrapper (https://github.com/Equality-Machine/
 *                  claude-p), a Python CLI that drives the interactive Claude
 *                  Code TUI under a pseudo-TTY so it runs on the *subscription*
 *                  login instead of an API key.
 *
 * This module is the single place that knows the command line each backend
 * needs. `AgentProcess` stays backend-agnostic — it just runs whatever
 * `command` + `extraArgs` it is handed. The three call sites (main agent,
 * reviewer, fixer) all funnel through `buildInvocation()`.
 */

import { randomUUID } from "node:crypto";

export type AgentBackend = "claude" | "claude-p";

/** Exact `claude-p` version ralphloop is built and audited against. */
export const CLAUDE_P_PINNED_VERSION = "0.1.4";

/**
 * Parse a raw backend string (CLI flag / env / config) into a known value.
 * The default — unset or unrecognised — is `claude-p`; pass `claude`
 * explicitly to use the official API-key CLI.
 */
export function resolveBackend(raw: string | undefined): AgentBackend {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "claude") return "claude";
  return "claude-p";
}

export interface BackendInvocation {
  /** Binary to spawn. */
  command: string;
  /** Args inserted before `--model` by `AgentProcess`. */
  extraArgs: string[];
  /** When false, the prompt is passed as the last positional arg, not stdin. */
  promptViaStdin: boolean;
  /**
   * Session id we forced onto the run. Only set for `claude-p` — it is passed
   * through unchanged to the underlying `claude`, which persists the canonical
   * transcript at `~/.claude/projects/**\/<sessionId>.jsonl`. ralphloop reads
   * that file back to recover real token usage (see `SessionUsage.ts`).
   */
  sessionId: string | null;
}

export interface BuildInvocationOpts {
  /** Per-role binary for the `claude` backend (claudeBin/reviewerBin/fixerBin). */
  roleBin: string;
  /** Binary for the `claude-p` backend (used for every role). */
  claudePBin: string;
  /** Agent working directory — passed to `claude-p --cwd`. */
  repoRoot: string;
  /** Wall-clock budget — claude-p needs its own `--timeout-sec` (no default cap). */
  timeoutMs: number;
}

/**
 * `--output-format stream-json --verbose` makes both backends emit one JSON
 * event per line; `StreamJsonAggregator` parses the same `type`-tagged
 * envelope for either. `--include-partial-messages` is deliberately NOT passed
 * to claude-p so the stream shape stays identical to the `claude` backend.
 */
const COMMON_ARGS = [
  "--print",
  "--dangerously-skip-permissions",
  "--output-format",
  "stream-json",
  "--verbose",
];

export function buildInvocation(
  backend: AgentBackend,
  opts: BuildInvocationOpts,
): BackendInvocation {
  if (backend === "claude-p") {
    const sessionId = randomUUID();
    return {
      command: opts.claudePBin,
      extraArgs: [
        ...COMMON_ARGS,
        // Own the session id so we can read the transcript back afterwards.
        "--session-id",
        sessionId,
        // claude-p has no implicit wall-clock cap matching our budget — give
        // it one a touch under the execa timeout so it self-terminates and
        // flushes a final event before execa would SIGTERM it.
        "--timeout-sec",
        String(Math.max(1, Math.ceil(opts.timeoutMs / 1000))),
        "--cwd",
        opts.repoRoot,
      ],
      // claude-p takes the prompt as a positional argument — piping it to
      // stdin produces an empty-prompt error run.
      promptViaStdin: false,
      sessionId,
    };
  }
  return {
    command: opts.roleBin,
    extraArgs: [...COMMON_ARGS],
    promptViaStdin: true,
    sessionId: null,
  };
}

/**
 * Human-readable one-liner for the `cmd` log line. Does NOT generate a session
 * id (the real one is minted per spawn inside `buildInvocation`).
 */
export function previewInvocation(
  backend: AgentBackend,
  opts: { roleBin: string; claudePBin: string; model: string },
): string {
  if (backend === "claude-p") {
    return (
      `${opts.claudePBin} ${COMMON_ARGS.join(" ")} ` +
      `--session-id <uuid> --timeout-sec <n> --cwd <repo> --model ${opts.model}`
    );
  }
  return `${opts.roleBin} ${COMMON_ARGS.join(" ")} --model ${opts.model}`;
}
