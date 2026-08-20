import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCodexRefreshFileLock } from "../src/codex/account-store";

function lockPath(directory: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return join(directory, `codex-refresh-${digest}.lock`);
}

describe("CODEX_HOME refresh file lock", () => {
  test("does not steal a fresh reclaim owner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "fresh-reclaim";
    const path = lockPath(directory, key);
    writeFileSync(`${path}.reclaim`, JSON.stringify({ owner: "fresh", pid: process.pid, acquiredAt: Date.now() }) + "\n");
    const abort = AbortSignal.abort(new DOMException("cancelled", "AbortError"));
    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: abort,
      run: async () => undefined,
      directory,
    })).rejects.toBeInstanceOf(DOMException);
    expect(readdirSync(directory)).toContain(`${path.split("/").at(-1)}.reclaim`);
    rmSync(directory, { recursive: true, force: true });
  });

  test("does not replace a reclaim owner while waiting for a primary lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "fresh-reclaim-wait";
    const path = lockPath(directory, key);
    const reclaimOwner = { owner: "fresh-reclaim-owner", pid: process.pid, acquiredAt: Date.now() };
    writeFileSync(path, JSON.stringify({ owner: "primary-owner", pid: 0, acquiredAt: 0 }) + "\n");
    writeFileSync(`${path}.reclaim`, JSON.stringify(reclaimOwner) + "\n");

    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: AbortSignal.timeout(20),
      run: async () => undefined,
      directory,
    })).rejects.toBeInstanceOf(DOMException);
    expect(JSON.parse(readFileSync(`${path}.reclaim`, "utf8"))).toEqual(reclaimOwner);
    rmSync(directory, { recursive: true, force: true });
  });

  test("release contention follows the caller signal bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "release-contention";
    const path = lockPath(directory, key);
    let runEntered = false;

    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: AbortSignal.timeout(20),
      run: async () => {
        runEntered = true;
        writeFileSync(`${path}.reclaim`, JSON.stringify({ owner: "fresh", pid: process.pid, acquiredAt: Date.now() }) + "\n");
      },
      directory,
    })).rejects.toBeInstanceOf(DOMException);
    expect(runEntered).toBe(true);
    expect(readdirSync(directory).sort()).toEqual([`${path.split("/").at(-1)}`, `${path.split("/").at(-1)}.reclaim`].sort());
    rmSync(directory, { recursive: true, force: true });
  });

  test("release contention honors an already expired caller signal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "release-expired-signal";
    const path = lockPath(directory, key);
    const controller = new AbortController();
    let runEntered = false;

    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: controller.signal,
      run: async () => {
        runEntered = true;
        writeFileSync(`${path}.reclaim`, JSON.stringify({ owner: "fresh", pid: process.pid, acquiredAt: Date.now() }) + "\n");
        controller.abort(new DOMException("deadline", "TimeoutError"));
      },
      directory,
    })).rejects.toBeInstanceOf(DOMException);
    expect(runEntered).toBe(true);
    expect(readdirSync(directory).sort()).toEqual([`${path.split("/").at(-1)}`, `${path.split("/").at(-1)}.reclaim`].sort());
    rmSync(directory, { recursive: true, force: true });
  });

  test("release contention cleanup lets a later caller acquire after reclaim owner exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "release-eventual-cleanup";
    const path = lockPath(directory, key);
    const controller = new AbortController();

    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: controller.signal,
      run: async () => {
        writeFileSync(`${path}.reclaim`, JSON.stringify({ owner: "fresh", pid: process.pid, acquiredAt: Date.now() }) + "\n");
        controller.abort(new DOMException("deadline", "TimeoutError"));
      },
      directory,
    })).rejects.toBeInstanceOf(DOMException);
    rmSync(`${path}.reclaim`, { force: true });

    await withCodexRefreshFileLock({
      lockKey: key,
      signal: AbortSignal.timeout(2_000),
      run: async () => undefined,
      directory,
    });
    expect(readdirSync(directory)).toEqual([]);
    rmSync(directory, { recursive: true, force: true });
  });

  test("release contention cleanup survives reclaim ownership beyond one retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "release-long-contention";
    const path = lockPath(directory, key);
    const controller = new AbortController();

    await expect(withCodexRefreshFileLock({
      lockKey: key,
      signal: controller.signal,
      run: async () => {
        writeFileSync(`${path}.reclaim`, JSON.stringify({ owner: "fresh", pid: process.pid, acquiredAt: Date.now() }) + "\n");
        controller.abort(new DOMException("deadline", "TimeoutError"));
        setTimeout(() => rmSync(`${path}.reclaim`, { force: true }), 1_200);
      },
      directory,
    })).rejects.toBeInstanceOf(DOMException);

    await withCodexRefreshFileLock({
      lockKey: key,
      signal: AbortSignal.timeout(4_000),
      run: async () => undefined,
      directory,
    });
    expect(readdirSync(directory)).toEqual([]);
    rmSync(directory, { recursive: true, force: true });
  });

  test("quarantines malformed debris and releases owner-safe locks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ocx-refresh-lock-"));
    const key = "malformed-orphan";
    const path = lockPath(directory, key);
    writeFileSync(path, "not-json\n");
    await withCodexRefreshFileLock({
      lockKey: key,
      signal: AbortSignal.timeout(5_000),
      run: async () => undefined,
      directory,
    });
    expect(readdirSync(directory)).toEqual([]);
    rmSync(directory, { recursive: true, force: true });
  });
});
