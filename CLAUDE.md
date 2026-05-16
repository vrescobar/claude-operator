# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`ralphloop` is a project-agnostic autonomous coding loop. It reads a checklist
(`tasks.md`), spawns a Claude agent per task, runs the consumer's tests, commits
successful tasks, retries failures, and sleeps through rate-limits — halting when
the agent writes `TASK_COMPLETE` in `progress.md`. It is consumed by other repos
as a git submodule; the loop operates on the *consumer's* repo, not its own.

## Commands

```sh
bun install              # install deps (runtime: bun, >=1.0.0)
bun test                 # run the full test suite
bun test tests/State.test.ts   # run a single test file
bun run typecheck        # tsc --noEmit (strict, noUncheckedIndexedAccess)
bun ./bin/ralphloop.ts doctor  # print resolved Config + validate a workspace
```

There is no build step — `bin/ralphloop.ts` is run directly with `bun`.

## Architecture

Everything is plain TypeScript run under `bun`; the only deps are `execa`
(subprocess) and `yaml` (config parsing).

**Config layering** — `src/workspace.ts` resolves paths (cwd → `.ralphloop/`
dir → optional `config.yaml`); `src/Config.ts` then layers env vars and CLI
flags on top. Precedence, highest first: CLI flag > `RALPH_*` env var >
`config.yaml` > built-in default. Treat the resolved `Config` object as the
single source of truth passed through the call tree.

**The loop** — `src/loop.ts` is pure orchestration over small focused helper
modules. One iteration: pick the first `[ ]` task in `tasks.md`, spawn an agent
(`AgentProcess`), run tests, and on success commit (`GitOps`) + run the review
sub-loop. State that must survive a crash/restart lives in `state.json`
(`src/State.ts`, atomic writes via `src/atomic.ts`): per-task attempt counters,
the attempt-limit guard, aggregate run counters.

**Agent backends** — `src/AgentBackend.ts` is the *only* place that knows the
command line for each backend. `claude-p` (default) drives the interactive TUI
on a subscription login; `claude` is the official API-key CLI. `AgentProcess`
stays backend-agnostic — it runs whatever `buildInvocation()` hands it. All
three call sites (main agent, reviewer, fixer) funnel through `buildInvocation()`.

**Cost under `claude-p`** — the TUI exposes no billing data, so ralphloop forces
a known `--session-id`, then reads real per-turn token counts back from the
Claude Code session transcript (`~/.claude/projects/**/<id>.jsonl`) in
`src/SessionUsage.ts` and *estimates* dollars from the local price table in
`src/Pricing.ts`. The price table must be kept current; estimated figures are
shown with a `≈$` / `~$` prefix.

**Review sub-loop** — `src/review/` runs a Reviewer→Fixer cycle after each
successful task commit, iterating until `verdict === APPROVE && tests pass` or
rounds exhaust. `retry-blocked` mode instead reopens `[!]` blocked tasks with
the per-task sub-loop *disabled*, then runs one final Opus integration review
over the whole batch (`firstSha..HEAD`).

**Resilience** — transient API 5xx errors are retried with backoff *without*
consuming a task's attempt budget (`src/RateLimit.ts`, `ServerError` handling).
A task that exhausts its attempt limit becomes `[!]` blocked and is skipped by
future `run`s. `src/PhaseArchive.ts` moves fully-completed `## Phase N` sections
out of `tasks.md` to keep per-iteration context small.

**Time** — operator-facing output renders in host-local time (`src/time.ts`);
canonical state files (`state.json`, `metrics.jsonl`, log filenames) always use
ISO-8601 UTC so they sort deterministically.

## Conventions

- Prefer the small-focused-module style already present; keep `loop.ts` as
  orchestration only — push logic into a helper module.
- Every loop state transition surfaces as a `Logger.stage(...)` line — keep that
  observability when adding transitions.
- Persisted-state writes go through `atomicWriteFileSync`; reads tolerate a
  missing/corrupt file by starting fresh.
- `prompts/*.md` are the bundled agent prompts; `{{KEY}}` placeholders are
  substituted by `src/promptTemplate.ts`. `scaffold/*.tmpl` are the files
  `ralphloop init` writes into a consumer's `.ralphloop/`.
- Tests use `bun:test` with fake CLIs in `tests/fixtures/bin/` (`fake-claude`,
  `fake-reviewer`, `fake-fixer`) instead of spawning real agents.
- `CLAUDE_P_PINNED_VERSION` in `AgentBackend.ts` pins the audited `claude-p`
  version — bump it deliberately.
