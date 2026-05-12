# ralphloop

Project-agnostic autonomous coding loop, extracted from the `mikoshi` project.

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

## Config precedence

CLI flag > env var > `.ralphloop/config.yaml` > built-in default.

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

## Provenance

Extracted from `mikoshi@b33be7ec` on 2026-05-12.
