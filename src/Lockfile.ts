/**
 * PID lockfile for the ralph loop.
 *
 * Prevents two ralph processes from corrupting tasks.md / progress.md by
 * stepping on each other. Same semantics as `loop.sh`'s lockfile but with
 * a typed surface and idempotent release.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class LockfileBusyError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`ralph: another loop already running (pid ${pid}) — refusing to start.`);
    this.name = "LockfileBusyError";
  }
}

export class Lockfile {
  private released = false;

  private constructor(readonly path: string) {}

  /**
   * Acquire the lock. If a stale lockfile exists (PID no longer alive) it is
   * removed and the lock is taken. If a live lockfile exists, throws.
   *
   * Uses `O_EXCL` (`flag: "wx"`) so two concurrent ralph processes cannot
   * both win the race between the existence check and the write — a problem
   * a naive `existsSync()`-then-`writeFileSync()` pattern has.
   */
  static acquire(path: string): Lockfile {
    const content = `${process.pid}\n`;
    // Up to 3 attempts: if the file is stale (dead PID) we delete it and retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        writeFileSync(path, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
        return new Lockfile(path);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") throw err;

        const prev = parsePid(path);
        if (prev !== null && isAlive(prev)) {
          throw new LockfileBusyError(path, prev);
        }
        // Stale PID file — clear it and retry. If unlink races with another
        // ralph that just took the lock, the next iteration's wx-write will
        // observe the live PID and throw LockfileBusyError correctly.
        try {
          unlinkSync(path);
        } catch {
          // best-effort: another process may have removed it already
        }
      }
    }
    // Three races in a row is unrealistic; surface a clear error rather than
    // looping forever.
    const racingPid = parsePid(path);
    throw new LockfileBusyError(path, racingPid ?? -1);
  }

  /** Idempotent. Safe to call from signal handlers and finally blocks. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      if (existsSync(this.path)) unlinkSync(this.path);
    } catch {
      // best-effort — never throw out of release()
    }
  }
}

function parsePid(path: string): number | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    // EPERM = exists but we can't signal it (still alive); ESRCH = no such process
    return e.code === "EPERM";
  }
}
