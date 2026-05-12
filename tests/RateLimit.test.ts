import { describe, test, expect } from "bun:test";
import { computeSleepUntil, detectRateLimit, sleepUntil } from "../src/RateLimit.js";

describe("RateLimit.detectRateLimit", () => {
  test("explicit reset timestamp is parsed", () => {
    const out = "Your usage limit will reset at 2030-01-01T00:00:00Z. Try later.";
    const r = detectRateLimit(out);
    expect(r).not.toBeNull();
    expect(r?.until?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
  });

  test("retry-after relative duration", () => {
    const before = Date.now();
    const r = detectRateLimit("Rate limit exceeded. Retry after 1h30m");
    expect(r).not.toBeNull();
    expect(r?.until).not.toBeNull();
    const ms = (r?.until?.getTime() ?? 0) - before;
    // 1h30m = 5400s
    expect(ms).toBeGreaterThanOrEqual(5395 * 1000);
    expect(ms).toBeLessThanOrEqual(5410 * 1000);
  });

  test("Retry-After header in seconds", () => {
    const before = Date.now();
    const r = detectRateLimit("Retry-After: 120");
    expect(r).not.toBeNull();
    const ms = (r?.until?.getTime() ?? 0) - before;
    expect(ms).toBeGreaterThanOrEqual(115 * 1000);
    expect(ms).toBeLessThanOrEqual(125 * 1000);
  });

  test("generic limit without time returns until=null", () => {
    const r = detectRateLimit("Quota exceeded for this organisation.");
    expect(r).not.toBeNull();
    expect(r?.until).toBeNull();
    expect(r?.reason.toLowerCase()).toContain("quota");
  });

  test("429 too many requests is detected", () => {
    const r = detectRateLimit("HTTP 429 too many requests");
    expect(r).not.toBeNull();
    expect(r?.until).toBeNull();
  });

  test("no-match returns null", () => {
    expect(detectRateLimit("everything went fine")).toBeNull();
    expect(detectRateLimit("")).toBeNull();
  });

  test("explicit reset wins over generic when both present", () => {
    const out = "Rate limit exceeded. Will reset at 2031-06-15T12:00:00Z.";
    const r = detectRateLimit(out);
    expect(r?.until?.toISOString()).toBe("2031-06-15T12:00:00.000Z");
  });
});

describe("RateLimit.computeSleepUntil", () => {
  test("until is honoured when provided", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const r = computeSleepUntil({ until: future, reason: "x" }, 0, 0, () => new Date(future.getTime() - 60 * 60 * 1000));
    expect(r.target.getTime()).toBe(future.getTime());
    expect(r.sleepMs).toBe(60 * 60 * 1000);
  });

  test("falls back to fallbackMs when until is null", () => {
    const r = computeSleepUntil({ until: null, reason: "x" }, 1500, 0, () => new Date(0), 0);
    expect(r.sleepMs).toBe(1500);
  });

  test("jitter is non-negative", () => {
    const r = computeSleepUntil(
      { until: new Date(60_000), reason: "x" },
      0,
      30_000,
      () => new Date(0),
      0,
    );
    expect(r.sleepMs).toBeGreaterThanOrEqual(60_000);
    expect(r.sleepMs).toBeLessThanOrEqual(60_000 + 30_000);
  });

  test("never returns negative sleep when until is in the past", () => {
    const r = computeSleepUntil(
      { until: new Date(0), reason: "x" },
      0,
      0,
      () => new Date(60_000),
      0,
    );
    expect(r.sleepMs).toBeGreaterThanOrEqual(0);
  });

  test("exponential fallback curve when until is null: base · 3^(n-1), capped", () => {
    const base = 5 * 60 * 1000; // 5 min
    const cap = 60 * 60 * 1000; // 1 h
    const now = (): Date => new Date(0);
    const fixedNow = () => new Date(0);
    const expected = [base, base * 3, Math.min(cap, base * 9), Math.min(cap, base * 27)];
    for (let n = 1; n <= 4; n++) {
      const r = computeSleepUntil(
        { until: null, reason: "generic" },
        base,
        0, // no jitter so the assertion is exact
        fixedNow,
        0,
        n,
        cap,
      );
      expect(r.sleepMs).toBe(expected[n - 1]!);
    }
    // Ensure quiet `now` reference is used (linter happiness).
    expect(now().getTime()).toBe(0);
  });

  test("backoff curve is bypassed when info.until is non-null", () => {
    const future = new Date(123_000);
    const r = computeSleepUntil(
      { until: future, reason: "explicit reset" },
      5 * 60 * 1000,
      0,
      () => new Date(0),
      0,
      5, // consecutiveHits — should NOT be applied because until is set
      60 * 60 * 1000,
    );
    expect(r.target.getTime()).toBe(future.getTime());
    expect(r.sleepMs).toBe(123_000);
  });
});

describe("RateLimit.sleepUntil", () => {
  test("resolves immediately if target is in the past", async () => {
    const before = Date.now();
    await sleepUntil(new Date(0));
    expect(Date.now() - before).toBeLessThan(100);
  });

  test("respects abort signal", async () => {
    const ctrl = new AbortController();
    const target = new Date(Date.now() + 60_000);
    const p = sleepUntil(target, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toThrow(/aborted/);
  });
});
