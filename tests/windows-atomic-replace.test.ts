/**
 * The Windows-tolerant atomic replace.
 *
 * Windows can refuse rename with EBUSY/EPERM/EACCES while another process holds
 * the target — a scanner that just indexed the file, a sync client, a backup
 * agent. The hold is usually momentary, so a small bounded retry turns an
 * operational failure back into a successful publish.
 *
 * These cases pin the envelope itself: which errors are transient, which
 * platform retries at all, and that the retry count is bounded rather than
 * hopeful. The envelope is deliberately small (two retries, ~75ms), so an
 * accidental widening should fail here.
 */
import { describe, expect, test } from "bun:test";

import { renameAtomicFile, type AtomicRenameIO } from "../src/lib/windows-atomic-replace";

/** A rename that fails `failures` times with `code`, then succeeds. */
function io(failures: number, code = "EBUSY", platform: NodeJS.Platform = "win32") {
  const sleeps: number[] = [];
  let attempts = 0;
  const seam: AtomicRenameIO & { sleeps: number[]; attempts: () => number } = {
    platform,
    rename: () => {
      attempts += 1;
      if (attempts <= failures) {
        const error = new Error(code) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
    },
    sleep: (ms: number) => { sleeps.push(ms); },
    sleeps,
    attempts: () => attempts,
  };
  return seam;
}

describe("renameAtomicFile", () => {
  test("a clean replace does not sleep", () => {
    const seam = io(0);
    renameAtomicFile("a", "b", seam);
    expect(seam.attempts()).toBe(1);
    expect(seam.sleeps).toEqual([]);
  });

  test("a transient sharing violation is retried and then succeeds", () => {
    const seam = io(1);
    renameAtomicFile("a", "b", seam);
    expect(seam.attempts()).toBe(2);
    expect(seam.sleeps).toEqual([25]);
  });

  test("the envelope is two retries with a rising backoff, then it gives up", () => {
    const seam = io(99);
    expect(() => renameAtomicFile("a", "b", seam)).toThrow("EBUSY");
    // Three attempts total: the original plus two retries.
    expect(seam.attempts()).toBe(3);
    expect(seam.sleeps).toEqual([25, 50]);
  });

  test.each(["EBUSY", "EPERM", "EACCES"])("%s is treated as transient on Windows", code => {
    const seam = io(1, code);
    renameAtomicFile("a", "b", seam);
    expect(seam.attempts()).toBe(2);
  });

  test("any other error surfaces immediately", () => {
    const seam = io(99, "ENOENT");
    expect(() => renameAtomicFile("a", "b", seam)).toThrow("ENOENT");
    expect(seam.attempts()).toBe(1);
    expect(seam.sleeps).toEqual([]);
  });

  test("POSIX never retries, even on a code Windows would tolerate", () => {
    // rename(2) replaces unconditionally; a sharing-violation retry there would
    // only paper over a real error.
    const seam = io(99, "EBUSY", "linux");
    expect(() => renameAtomicFile("a", "b", seam)).toThrow("EBUSY");
    expect(seam.attempts()).toBe(1);
  });
});
