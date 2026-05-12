import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Lockfile, LockfileBusyError } from "../src/Lockfile.js";

function tmpLock(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ralph-lock-"));
  return resolve(dir, ".lock");
}

describe("Lockfile", () => {
  test("acquire writes the current PID and creates the file", () => {
    const path = tmpLock();
    const lock = Lockfile.acquire(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  test("second acquire on a live lock throws LockfileBusyError", () => {
    const path = tmpLock();
    const first = Lockfile.acquire(path);
    expect(() => Lockfile.acquire(path)).toThrow(LockfileBusyError);
    first.release();
  });

  test("acquire reclaims a stale lock (PID no longer alive)", () => {
    const path = tmpLock();
    // Write a PID that cannot exist (PID 1 always exists, so use a guaranteed
    // dead one — find an unused high PID).
    const fakePid = pickDeadPid();
    writeFileSync(path, `${fakePid}\n`);
    const lock = Lockfile.acquire(path);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
    lock.release();
  });

  test("release is idempotent and tolerant of external deletion", () => {
    const path = tmpLock();
    const lock = Lockfile.acquire(path);
    lock.release();
    lock.release(); // no throw
    expect(existsSync(path)).toBe(false);
  });

  test("two simultaneous acquires: exactly one wins", () => {
    // Sequential simulation since JS lockfile.acquire() is synchronous.
    // Because acquire is synchronous, the only meaningful race is
    // concurrent processes — but the wx flag is what protects against that.
    // We assert here that with the wx flag in place, the second sync acquire
    // on a fresh file always reports the first as busy.
    const path = tmpLock();
    const first = Lockfile.acquire(path);
    let busy = false;
    try {
      Lockfile.acquire(path);
    } catch (err) {
      if (err instanceof LockfileBusyError) busy = true;
    }
    expect(busy).toBe(true);
    first.release();
  });
});

function pickDeadPid(): number {
  // Search downward from a high but plausible PID until process.kill(pid, 0)
  // confirms the process does not exist (ESRCH). Avoids races with PID reuse.
  for (let pid = 999_999; pid > 1000; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ESRCH") return pid;
    }
  }
  // Fallback — vanishingly unlikely.
  return 999_999;
}
