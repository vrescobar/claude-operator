import { describe, test, expect } from "bun:test";
import {
  formatIsoWithLocal,
  formatLocal,
  localFileStamp,
  localTimeZoneName,
  nowLocalHms,
  shortOffset,
} from "../src/time.js";

describe("time helpers", () => {
  test("nowLocalHms returns HH:MM:SS in local time", () => {
    const d = new Date(2026, 4, 14, 9, 7, 3);
    const hms = nowLocalHms(d);
    expect(hms).toBe("09:07:03");
  });

  test("nowLocalHms pads single digits", () => {
    const d = new Date(2026, 0, 1, 0, 0, 5);
    expect(nowLocalHms(d)).toBe("00:00:05");
  });

  test("formatLocal renders 'YYYY-MM-DD HH:MM:SS <offset>' in local time", () => {
    const d = new Date(2026, 4, 14, 14, 32, 17);
    const s = formatLocal(d);
    expect(s).toMatch(/^2026-05-14 14:32:17 (GMT|UTC)/);
  });

  test("shortOffset is a string like 'GMT+2' or 'UTC'", () => {
    const off = shortOffset(new Date());
    expect(off).toMatch(/^(GMT|UTC)/);
  });

  test("localTimeZoneName returns an IANA name or UTC fallback", () => {
    const tz = localTimeZoneName();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });

  test("formatIsoWithLocal includes both ISO and local", () => {
    const d = new Date(Date.UTC(2026, 4, 14, 12, 0, 0));
    const s = formatIsoWithLocal(d);
    expect(s).toContain("2026-05-14T12:00:00.000Z");
    expect(s).toMatch(/\(.+\)/);
  });

  test("localFileStamp is filename-safe and sortable", () => {
    const d = new Date(2026, 4, 14, 9, 7, 3);
    const stamp = localFileStamp(d);
    expect(stamp).toBe("20260514-090703");
    // No characters that would confuse a filesystem
    expect(stamp).not.toContain("/");
    expect(stamp).not.toContain(":");
    expect(stamp).not.toContain(" ");
  });
});
