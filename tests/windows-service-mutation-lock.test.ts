import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  WindowsServiceMutationBusyError,
  withWindowsServiceMutationLock,
} from "../src/lib/windows-service-mutation-lock";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// The lock path is injected throughout so the suite never opens the real per-user lock and
// therefore never serializes against a genuine `ocx service` run on the developer machine.
let testRoot = "";
let lockPath = "";

const noHardening = {
  hardenDirectory: () => {},
  hardenFile: () => {},
};

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for child marker ${path}`);
}

async function waitForOwnedChild(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const result = await Promise.race([
    child.exited.then(exitCode => ({ exitCode })),
    Bun.sleep(10_000).then(() => null),
  ]);
  if (result) return result.exitCode;
  child.kill();
  await child.exited;
  throw new Error("Timed out waiting for owned Windows service mutation lock child");
}

function spawnHolder(source: string): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([process.execPath, "-e", source], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  testRoot = mkdtempSync(join(import.meta.dir, ".tmp-windows-service-mutation-lock-"));
  lockPath = join(testRoot, "windows-service-mutation.sqlite");
});

afterEach(async () => {
  // Windows keeps the SQLite file mapped briefly after a child exits, so a single
  // immediate remove can still see EBUSY. Retry, then leave the temp dir behind rather
  // than failing an otherwise green assertion on a cleanup race.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      removeTreeWithRetry(testRoot);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EBUSY") throw error;
      await Bun.sleep(25);
    }
  }
});

test("a second service mutation is refused while another process holds the lock", async () => {
  const readyPath = join(testRoot, "holder-ready");
  const releasePath = join(testRoot, "holder-release");
  const lockModuleUrl = pathToFileURL(join(import.meta.dir, "../src/lib/windows-service-mutation-lock.ts")).href;
  const child = spawnHolder(`
    import { existsSync, writeFileSync } from "node:fs";
    import { withWindowsServiceMutationLock } from ${JSON.stringify(lockModuleUrl)};
    await withWindowsServiceMutationLock(async () => {
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(releasePath)})) Bun.sleepSync(10);
    }, { lockPath: ${JSON.stringify(lockPath)}, hardenDirectory: () => {}, hardenFile: () => {} });
  `);

  try {
    try {
      await waitForPath(readyPath);
    } catch (error) {
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }

    // Contention fails fast and, critically, without running the operation: a blocked
    // `ocx service repair` must never reach `schtasks` behind the holder's back.
    let ran = false;
    const startedAt = performance.now();
    await expect(withWindowsServiceMutationLock(async () => {
      ran = true;
    }, { lockPath, ...noHardening })).rejects.toBeInstanceOf(WindowsServiceMutationBusyError);
    expect(ran).toBe(false);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }

  // Once the holder exits, the next mutation plans and runs normally.
  let planned = 0;
  await withWindowsServiceMutationLock(async () => { planned += 1; }, { lockPath, ...noHardening });
  expect(planned).toBe(1);
});

test("an abruptly exited holder releases the OS-backed transaction without stale recovery", async () => {
  const enteredPath = join(testRoot, "crashed-holder-entered");
  const lockModuleUrl = pathToFileURL(join(import.meta.dir, "../src/lib/windows-service-mutation-lock.ts")).href;
  const child = spawnHolder(`
    import { writeFileSync } from "node:fs";
    import { withWindowsServiceMutationLock } from ${JSON.stringify(lockModuleUrl)};
    await withWindowsServiceMutationLock(async () => {
      writeFileSync(${JSON.stringify(enteredPath)}, "entered");
      process.exit(0);
    }, { lockPath: ${JSON.stringify(lockPath)}, hardenDirectory: () => {}, hardenFile: () => {} });
  `);

  expect(await waitForOwnedChild(child)).toBe(0);
  expect(existsSync(enteredPath)).toBe(true);

  // No stale-lock reclamation is needed, because the OS dropped the transaction on exit.
  let ran = false;
  await withWindowsServiceMutationLock(async () => { ran = true; }, { lockPath, ...noHardening });
  expect(ran).toBe(true);
});

test("a failing mutation releases the lock instead of wedging later service commands", async () => {
  await expect(withWindowsServiceMutationLock(async () => {
    throw new Error("repair failed");
  }, { lockPath, ...noHardening })).rejects.toThrow("repair failed");

  let ran = false;
  await withWindowsServiceMutationLock(async () => { ran = true; }, { lockPath, ...noHardening });
  expect(ran).toBe(true);
});

test("nested acquisition in the same process is refused rather than silently reentered", async () => {
  await expect(withWindowsServiceMutationLock(async () => {
    await withWindowsServiceMutationLock(async () => {}, { lockPath, ...noHardening });
  }, { lockPath, ...noHardening })).rejects.toBeInstanceOf(WindowsServiceMutationBusyError);

  let ran = false;
  await withWindowsServiceMutationLock(async () => { ran = true; }, { lockPath, ...noHardening });
  expect(ran).toBe(true);
});
