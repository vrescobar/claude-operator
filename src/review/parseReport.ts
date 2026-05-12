/**
 * Parsers over a reviewer's stdout report.
 *
 * The report ends with one of two anchored lines:
 *   VERDICT: APPROVE
 *   VERDICT: NEEDS_CHANGES
 * Anything else is reported as `UNKNOWN`, which the sub-loop treats as
 * `NEEDS_CHANGES` (be conservative when format isn't followed).
 *
 * Item counts come from bullet lines under the `## Issues to fix` and
 * `## Test cases worth adding` headings.
 */

import type { ReviewCounts, ReviewVerdict } from "./types.js";

const VERDICT_LINE_RE = /^VERDICT:\s*(APPROVE|NEEDS_CHANGES)\s*$/i;
const HEADING_ISSUES_RE = /^##\s+Issues to fix\s*$/i;
const HEADING_TESTS_RE = /^##\s+Test cases worth adding\s*$/i;
const HEADING_OTHER_RE = /^##\s+/;
const BULLET_BLOCKER_RE = /^[-*]\s+\*\*\[blocker\]\*\*/i;
const BULLET_NIT_RE = /^[-*]\s+\*\*\[nit\]\*\*/i;
const BULLET_PLAIN_RE = /^[-*]\s+\S/;

/** Returns the verdict on the trailing `VERDICT:` line. */
export function parseVerdict(report: string): ReviewVerdict {
  const lines = report.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i]?.trim();
    if (!ln) continue;
    const m = VERDICT_LINE_RE.exec(ln);
    if (!m) return "UNKNOWN";
    return m[1]!.toUpperCase() as "APPROVE" | "NEEDS_CHANGES";
  }
  return "UNKNOWN";
}

/**
 * Counts review items by walking section bullets:
 *   blockers: bullets in `## Issues to fix` starting with `**[blocker]**`.
 *   nits:     bullets in `## Issues to fix` starting with `**[nit]**`.
 *   tests:    any bullet directly under `## Test cases worth adding`.
 *
 * Bullets without a `[blocker]` / `[nit]` tag in the issues section are
 * counted as nits (lenient — matches operator intent that the field is
 * "informative", not contractual).
 */
export function countItems(report: string): ReviewCounts {
  const counts: ReviewCounts = { blockers: 0, nits: 0, tests: 0 };
  let section: "issues" | "tests" | "other" | null = null;

  for (const raw of report.split("\n")) {
    const ln = raw.trim();
    if (HEADING_ISSUES_RE.test(ln)) {
      section = "issues";
      continue;
    }
    if (HEADING_TESTS_RE.test(ln)) {
      section = "tests";
      continue;
    }
    if (HEADING_OTHER_RE.test(ln)) {
      section = "other";
      continue;
    }
    if (!section || section === "other") continue;

    if (section === "issues") {
      if (BULLET_BLOCKER_RE.test(ln)) counts.blockers++;
      else if (BULLET_NIT_RE.test(ln)) counts.nits++;
      else if (BULLET_PLAIN_RE.test(ln)) counts.nits++;
    } else if (section === "tests") {
      if (BULLET_PLAIN_RE.test(ln)) counts.tests++;
    }
  }
  return counts;
}
