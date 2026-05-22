# ralphloop

Project-agnostic autonomous coding loop.

Reads a checklist (`tasks.md`), spawns Claude (`claude -p`) per task, runs tests,
commits successful tasks, retries failures, sleeps on rate-limits. Halts when
the agent writes `TASK_COMPLETE` on its own line in `progress.md`.

## Install (as a git submodule in a consumer project)

```sh
cd /path/to/your/project
git submodule add git@github.com:vrescobar/ralphloop.git ralphloop
cd ralphloop && bun install && cd ..
bun ./ralphloop/bin/ralphloop.ts init
```

`init` scaffolds a `.ralphloop/` directory in your project root with:
- `tasks.md` — your checklist (committed)
- `progress.md` — agent decision log (committed)
- `prompt.md` — system prompt override (committed) — copy from `ralphloop/prompts/iteration.md`
- `config.yaml` — optional overrides (committed)

Runtime state lives next to those files (gitignored): `state.json`, `lock`,
`metrics.jsonl`, `logs/`, `archive/`.

The project spec defaults to `GOAL.md` at the repo root; configurable via
`RALPH_GOAL_FILE`, `--goal`, or `config.yaml`.

## Run

```sh
bun ./ralphloop/bin/ralphloop.ts run --max-iterations 10
bun ./ralphloop/bin/ralphloop.ts run --dry-run        # print next task only
bun ./ralphloop/bin/ralphloop.ts doctor               # show resolved Config + validate
```

Or add a script to your consumer `package.json`:

```json
"scripts": { "ralph": "bun ./ralphloop/bin/ralphloop.ts run" }
```

### Background mode (`--nohup`, Linux + systemd-user)

By default `run` is foreground: close the terminal and the loop dies. Pass
`--nohup` to keep it alive across logouts via a per-project systemd-user
service (`~/.config/systemd/user/ralphloop-<repo-basename>.service`):

```sh
bun ./ralphloop/bin/ralphloop.ts run --nohup              # idempotent: start, or status if already running
bun ./ralphloop/bin/ralphloop.ts run --nohup --status     # state + recent journal lines
bun ./ralphloop/bin/ralphloop.ts run --nohup --logs 200   # last N journal lines
bun ./ralphloop/bin/ralphloop.ts run --nohup --restart    # systemctl restart
bun ./ralphloop/bin/ralphloop.ts run --nohup --cancel     # stop + disable + remove unit
```

Any `run` flags you pass alongside `--nohup` (e.g. `--max-iterations`,
`--backend`, `--workspace`) are forwarded into the unit's `ExecStart` so the
background invocation is the same one you would have run in foreground. The
ExecStart is regenerated on every start, so changing flags just means
`--nohup --cancel` followed by `--nohup` with the new flags.

To survive a full logout (not just a closed terminal), enable lingering once:

```sh
loginctl enable-linger $USER
```

Requires `systemctl --user` (any modern Linux desktop / server). On hosts
without systemd user the command exits with code 2 and a clear message.

## Agent backends

Each agent invocation (main agent, reviewer, fixer) is driven by one of two
backends, selected globally:

| Backend    | How it bills            | Select with |
|------------|-------------------------|-------------|
| `claude-p` | [`claude-p`](https://github.com/Equality-Machine/claude-p) wrapper — runs on the Claude **subscription** login | default |
| `claude`   | Official Claude Code CLI — API key | `--backend claude` |

```sh
bun ./ralphloop/bin/ralphloop.ts run                     # default: claude-p
bun ./ralphloop/bin/ralphloop.ts run --backend claude    # opt out to the API-key CLI
```

Also settable via `agentBackend:` in `config.yaml` or `RALPH_AGENT_BACKEND`.

**Installing `claude-p`** — it is a Python tool, so `bun` cannot install it.
Install it pinned to the exact audited version:

```sh
uv tool install 'claude-p==0.1.4'        # or: pip install 'claude-p==0.1.4'
```

`ralphloop doctor` confirms `claude-p` is installed and runnable, and shows the
pinned target version (`0.1.4`) — verify it with `uv tool list` or
`pip show claude-p` (`claude-p --version` forwards to `claude` and cannot
report the wrapper's own version).

**First-run folder trust** — `claude-p` drives the interactive TUI, which shows
a one-time "trust this folder?" dialog for a directory Claude Code has not seen
before. Open your repo once in `claude` (interactively) and accept the prompt
before running ralphloop, otherwise the run fails with
`workspace_trust_blocked`.

**Cost reporting under `claude-p`** — the interactive TUI does not expose
billing data, so `claude-p` reports placeholder usage. ralphloop works around
this: it forces a known `--session-id`, then after each run reads the real
per-turn token counts back from the Claude Code session transcript
(`~/.claude/projects/**/<id>.jsonl`) and **estimates** the dollar cost from a
local price table (`src/Pricing.ts`). Cost figures under `claude-p` are
therefore estimates — shown with a `≈$` / `~$` prefix — and the price table
must be kept current. There is no quota budget: when Claude rate-limits, the
loop simply waits out the reset window as it always has.

## Resilience & blocked tasks

**Transient API 5xx errors** (`API Error: 500`, `overloaded_error`, …) are
infrastructure, not a task failure. The loop backs off and retries them
*without* consuming the task's attempt budget, so a provider outage can never
permanently block sound work. After `serverErrorMaxConsecutive` (default 20)
back-to-back 5xx hits the run halts cleanly — the task stays `[ ]` and a later
run resumes it. Tunables: `RALPH_SERVER_ERROR_RETRY_BASE_MS` /
`RALPH_SERVER_ERROR_RETRY_CAP_MS` / `RALPH_SERVER_ERROR_MAX_CONSECUTIVE`.

**Blocked tasks** — a task that exhausts its attempt limit is moved to `[!]`
and skipped by future `run`s. At the end of every run, a yellow line reports
how many `[!]` tasks remain. To revisit them:

```sh
bun ./ralphloop/bin/ralphloop.ts retry-blocked            # honours the cooldown
bun ./ralphloop/bin/ralphloop.ts retry-blocked --force    # ignore the cooldown
```

`retry-blocked` is a distinct loop mode: it reopens the `[!]` tasks (resetting
their attempt counters), reruns them **with the per-task reviewer→fixer
sub-loop disabled**, and then runs **one final integration review on Opus**
over the whole batch (`firstSha..HEAD`). That review embeds the design spec
(`GOAL.md`) and checks the batch is coherent — all features implemented, tests
green, no interdependency breakage — since the reopened tasks were redone out
of order. Its findings *and* fixes both run on Opus. A `[!]` task is only
eligible once it has been blocked at least `blockedRetryCooldownHours` (default
6) — `--force` bypasses that.

## Config precedence

CLI flag > env var > `.ralphloop/config.yaml` > built-in default.

## Auto-archive of closed phases

When `tasks.md` is organised by `## Phase N — title` headings, the loop moves
each fully-completed phase (every task `[x]`) out to
`<archiveDir>/tasks-phases-archived.md` at the start of every `run`. The last
`## Phase` heading is always preserved so the operator sees the just-finished
phase until they write the next one.

Run manually with:

```sh
bun ./ralphloop/bin/ralphloop.ts archive phases
```

Disable globally:

```yaml
# .ralphloop/config.yaml
autoArchiveClosedPhases: false
```

Or via env: `RALPH_AUTO_ARCHIVE_CLOSED_PHASES=0`.

Cuts ~40 KB of `[x]` history off the per-iteration context once you have a few
dozen completed phases.

## Merge back to a base branch on finish

By default ralphloop never touches branches: it commits each task on whatever
branch it was started on and, when the run finishes, just stays there. If you
run the loop on a feature branch, the commits are left on that feature branch
for you to merge yourself.

Opt in to an automatic merge-back so a clean finish lands you on (e.g.) `main`
with the whole batch folded in:

```yaml
# .ralphloop/config.yaml
finish:
  merge: true
  targetBranch: main   # default
```

Or via env: `RALPH_FINISH_MERGE=1` (and `RALPH_FINISH_MERGE_TARGET_BRANCH=main`).

When enabled, after a successful run (no `[ ]` tasks left, or the stop marker is
written) the loop checks out `targetBranch` and merges the work branch into it
with `git merge --no-ff` — always recording a merge commit so the batch is one
visible group in history — then stays on `targetBranch`. The work branch is
**kept**, and the merge is **local only** (it never pushes; `git push` stays in
your hands).

The step skips itself, with a logged reason and without failing the run, when:

- the loop is already on `targetBranch` (the commits are already there);
- `HEAD` is detached (no work branch to merge);
- `targetBranch` doesn't exist locally;
- the working tree is dirty (uncommitted changes — merge by hand).

A merge conflict aborts cleanly (`git merge --abort`) and checks the work branch
back out, so you're never left stranded mid-merge.

## Timezone

All operator-facing timestamps (iteration headers, rate-limit banners,
progress.md rotation stubs, archive listings, blocked-task notes) render in
the host's local timezone with the offset shown. Example:

```
━━━ ralph iteration 8/10 ━━━  14:32:01
  ⏸ rate-limited until 2026-05-14T15:00:00.000Z (2026-05-14 17:00:00 GMT+2)
```

Canonical state files (`state.json`, `metrics.jsonl`, git stash refs,
per-iteration log filenames) keep ISO-8601 UTC so they sort and compare
deterministically across timezones.

## Updating the submodule

```sh
git submodule update --remote ralphloop
git add ralphloop && git commit -m "chore: bump ralphloop"
```

## Develop

```sh
bun install
bun test
bun run typecheck
```
