import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(import.meta.dir, ".tmp-stale-state-purge-test");
let prevOpencodexHome: string | undefined;

describe("snapshot-guarded stale-state purge", () => {
  beforeEach(() => {
    prevOpencodexHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (prevOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevOpencodexHome;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("removePidIfValueIs deletes only when the file still matches the snapshot", async () => {
    const { getPidPath, removePidIfValueIs } = await import("../src/config");

    writeFileSync(getPidPath(), "123");
    removePidIfValueIs(999); // concurrent start rewrote the file since the snapshot
    expect(existsSync(getPidPath())).toBe(true);
    expect(readFileSync(getPidPath(), "utf-8")).toBe("123");

    removePidIfValueIs(123);
    expect(existsSync(getPidPath())).toBe(false);

    removePidIfValueIs(null); // nothing on disk: no-op, no throw
  });

  test("removeRuntimePortIfPidIs deletes matching and invalid-snapshot records, keeps fresh ones", async () => {
    const { getConfigDir, removeRuntimePortIfPidIs } = await import("../src/config");
    const runtimePath = join(getConfigDir(), "runtime-port.json");

    writeFileSync(runtimePath, JSON.stringify({ pid: 42, port: 58195 }));
    removeRuntimePortIfPidIs(7); // a different (fresh) record — keep it
    expect(existsSync(runtimePath)).toBe(true);

    removeRuntimePortIfPidIs(42);
    expect(existsSync(runtimePath)).toBe(false);

    // Invalid content snapshots as null and is purged as stale.
    writeFileSync(runtimePath, "not json");
    removeRuntimePortIfPidIs(null);
    expect(existsSync(runtimePath)).toBe(false);
  });

  test("handleStop snapshots stale state before probing and purges through the guards", () => {
    const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
    const stopFn = cliSource.slice(cliSource.indexOf("async function handleStop()"), cliSource.indexOf("async function handleUninstall()"));

    const snapshotAt = stopFn.indexOf("const stalePidValue = readPidFileValue()");
    const probeAt = stopFn.indexOf("await findLiveProxy()");
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(probeAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(probeAt);
    expect(stopFn).toContain("removePidIfValueIs(stalePidValue)");
    expect(stopFn).toContain("removeRuntimePortIfPidIs(staleRuntimePid)");
    expect(stopFn).not.toContain("removePid();");
    expect(stopFn).not.toContain("removeRuntimePort();");
  });

  test("gui opens the actual bind host and recover-history surfaces a locked DB", () => {
    const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
    expect(cliSource).toContain("const guiHost = probeHostname(live?.hostname ?? config.hostname)");
    const recoverFn = cliSource.slice(cliSource.indexOf("function handleRecoverHistory()"), cliSource.indexOf("switch (command)"));
    expect(recoverFn).toContain("if (r.failed)");
    expect(recoverFn).toContain("process.exit(1)");
  });
});
