You are applying review feedback to the commit at HEAD on the current branch.

A senior reviewer's report follows. Read it carefully.

<review_report>
{{REPORT}}
</review_report>

Round: {{ROUND}}/{{MAX_ROUNDS}}.
Tests are currently: {{TESTS_STATE}}.

{{TEST_OUTPUT_BLOCK}}

What to do:
1. **If tests are failing, fix them first — this is non-negotiable.**
   The reviewer focuses on code-quality blockers and may not have flagged
   every test/typecheck failure. The failure output above is your ground
   truth. Run the failing command yourself (`bun run typecheck` and/or
   `bun run test`) to see live output, identify the root cause, and fix it.
   Do NOT hand-wave: tests must be green when you exit. If the only failure
   is in test scaffolding (mocks, type casts, fixtures), fix the scaffolding.
2. Apply EVERY `[blocker]` item in the report.
3. Add the test cases listed under "Test cases worth adding".
4. Skip every `[nit]` item.
5. Re-run `bun run typecheck && bun run test` to verify your fixes don't
   break anything else.

What NOT to do:
- DO NOT introduce features that are not in the report.
- DO NOT refactor unrelated code.
- DO NOT amend the prior commit. The driver loop will commit your changes
  as a new `review(NN, round K): …` commit.
- DO NOT skip a `[blocker]` item without leaving a one-line note in your
  final message explaining why.
- DO NOT exit while tests are still red because "the reviewer didn't
  mention them". The test gate is independent of the reviewer.

If a particular `[blocker]` requires rewriting code that is far outside the
commit's scope, you may skip it and explain. Otherwise, address it fully.

Exit when (a) every blocker is addressed, (b) the requested test cases
exist, and (c) `bun run typecheck && bun run test` both succeed.
