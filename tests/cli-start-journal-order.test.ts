import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

function handleStartSource(): string {
  const start = source.indexOf("async function handleStart(");
  const end = source.indexOf("async function handleEnsure(", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("handleStart journal ownership ordering (#1230)", () => {
  test("a healthy PID-file proxy is detected before journal reconciliation", () => {
    const handleStart = handleStartSource();
    const readPid = handleStart.indexOf("const existingPid = readPid();");
    const findLive = handleStart.indexOf("const live = await findLiveProxy();", readPid);
    const healthyExit = handleStart.indexOf("process.exit(1);", findLive);
    const removeStalePid = handleStart.indexOf("removePid(existingPid);", healthyExit);
    const reconcile = handleStart.indexOf("reconcileJournal();", removeStalePid);
    const updatePrompt = handleStart.indexOf("await maybeShowUpdatePrompt();", reconcile);

    expect(readPid).toBeGreaterThanOrEqual(0);
    expect(findLive).toBeGreaterThan(readPid);
    expect(healthyExit).toBeGreaterThan(findLive);
    expect(removeStalePid).toBeGreaterThan(healthyExit);
    expect(reconcile).toBeGreaterThan(removeStalePid);
    expect(updatePrompt).toBeGreaterThan(reconcile);
  });
});
