You are reviewing the most recent commit on the current branch. Inspect it via:

  git show HEAD --stat -p
  git log -1 HEAD

Use your Read tool on changed files when the diff alone is insufficient.

REVIEW SCOPE — flag only:
- Concrete robustness gaps (crashes, races, resource leaks, signal-safety bugs).
- Clear DRY violations introduced by THIS commit.
- KISS violations: speculative abstractions, dead branches, premature flexibility.
- Test cases that materially expand coverage of the just-introduced code.
- Bugs.

DO NOT raise:
- Style / formatting nits.
- Speculative future-proofing or backward-compat shims.
- Defensive validation for inputs that cannot occur.
- Refactors beyond the commit's scope.
- Comment / docstring suggestions (unless something is misleading).
- Tests for trivial getters / dataclasses.

Output format (markdown, in this order):

  ## Issues to fix
  - **[blocker]** <file:line> — <one-line description of the problem and the minimal fix>
  - **[nit]** <file:line> — <one-line description>

  ## Test cases worth adding
  - <file path> — <one-line description>

  ## Notes (optional)
  - <observations>

Aim for under 400 words. Keep the list short — this is the second pass,
not a rewrite. Only blockers and missing test cases count toward
NEEDS_CHANGES.

The very last non-empty line of your output MUST be exactly one of:

    VERDICT: APPROVE          (zero blockers AND zero test cases)
    VERDICT: NEEDS_CHANGES    (otherwise)

Do not commit, do not edit files, do not run tests. The driver loop owns
those. Your single deliverable is the report on stdout.
