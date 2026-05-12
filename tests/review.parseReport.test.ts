import { describe, expect, test } from "bun:test";
import { countItems, parseVerdict } from "../src/review/parseReport.js";

describe("parseVerdict", () => {
  test("APPROVE on the last line", () => {
    expect(parseVerdict("nothing to see\n\nVERDICT: APPROVE\n")).toBe("APPROVE");
  });

  test("NEEDS_CHANGES on the last line", () => {
    expect(parseVerdict("issue 1\n\nVERDICT: NEEDS_CHANGES")).toBe("NEEDS_CHANGES");
  });

  test("trailing whitespace tolerated", () => {
    expect(parseVerdict("VERDICT: APPROVE   \n\n  ")).toBe("APPROVE");
  });

  test("only the LAST verdict line counts", () => {
    expect(
      parseVerdict("VERDICT: APPROVE\nthen reconsidered\nVERDICT: NEEDS_CHANGES\n"),
    ).toBe("NEEDS_CHANGES");
  });

  test("unknown when last non-empty line isn't a verdict", () => {
    expect(parseVerdict("just chatting\n\n")).toBe("UNKNOWN");
    expect(parseVerdict("VERDICT: yolo\n")).toBe("UNKNOWN");
  });

  test("unknown on empty input", () => {
    expect(parseVerdict("")).toBe("UNKNOWN");
  });

  test("case-insensitive verdict token", () => {
    expect(parseVerdict("verdict: approve\n")).toBe("APPROVE");
  });
});

describe("countItems", () => {
  test("blockers and nits in issues section", () => {
    const report = `
## Issues to fix
- **[blocker]** src/foo.ts:12 — unhandled error
- **[blocker]** src/bar.ts:3 — null deref
- **[nit]** src/baz.ts:99 — naming

## Test cases worth adding
- tests/foo.test.ts — happy path

VERDICT: NEEDS_CHANGES
`;
    expect(countItems(report)).toEqual({ blockers: 2, nits: 1, tests: 1 });
  });

  test("plain bullets in issues section count as nits", () => {
    const report = `
## Issues to fix
- some unmarked observation

VERDICT: NEEDS_CHANGES
`;
    expect(countItems(report)).toEqual({ blockers: 0, nits: 1, tests: 0 });
  });

  test("test bullets only count under their heading", () => {
    const report = `
## Test cases worth adding
- tests/a.test.ts — case A
- tests/b.test.ts — case B
- tests/c.test.ts — case C

## Notes
- not a test

VERDICT: APPROVE
`;
    expect(countItems(report)).toEqual({ blockers: 0, nits: 0, tests: 3 });
  });

  test("returns zeros on empty/missing sections", () => {
    expect(countItems("")).toEqual({ blockers: 0, nits: 0, tests: 0 });
    expect(countItems("VERDICT: APPROVE\n")).toEqual({ blockers: 0, nits: 0, tests: 0 });
  });

  test("ignores bullets inside Notes / unrelated headings", () => {
    const report = `
## Notes
- **[blocker]** this is in Notes, not Issues — must NOT be counted

## Issues to fix
- **[blocker]** real one

VERDICT: NEEDS_CHANGES
`;
    expect(countItems(report)).toEqual({ blockers: 1, nits: 0, tests: 0 });
  });
});
