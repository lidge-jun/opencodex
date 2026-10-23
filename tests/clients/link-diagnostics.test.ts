import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkDiagnosticSink, type LinkDiagnosticRecord } from "../../src/link/diagnostics";
import { resetHardenedStateForTests, setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests,
  setPlatformForTests, setStatForTests } from "../../src/lib/windows-secret-acl";
import { setAsyncWindowsPrincipalRunnerForTests, resetWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-link-diagnostics-"));
  roots.push(configDir);
  const dir = join(configDir, "link");
  const path = join(dir, "diagnostics.jsonl");
  return { configDir, dir, path };
}
function records(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("writes only bounded metadata and opaque UUID correlation without config ownership side effects", async () => {
  const { configDir, path } = fixture();
  const sink = createLinkDiagnosticSink({ configDir, now: () => 100 });
  expect(readdirSync(configDir)).toEqual([]);
  const requestId = randomUUID();
  const checkId = randomUUID();
  sink({
    event: "owner_lookup", outcome: "match", requestId, checkId,
    generation: 3, state: "connected", elapsedMs: 1.5, attempt: 2,
    error: "private-error", body: "private-body", key: "private-key", url: "https://private.test",
    linkId: "lnk_0123456789abcdef", suppressed: "private", timestamp: "private",
  } as LinkDiagnosticRecord);
  sink({ event: "relay_failure", outcome: "auth_timeout", requestId: "lnk_0123456789abcdef",
    checkId: `${checkId}\nprivate`, state: "private-state", elapsedMs: Infinity, generation: -1, attempt: 0.5 });
  sink({ event: "private-event", outcome: "match" } as unknown as LinkDiagnosticRecord);
  sink({ event: "owner_lookup", outcome: "private-outcome" } as unknown as LinkDiagnosticRecord);
  await sink.flush();
  expect(records(path)).toEqual([
    { event: "owner_lookup", outcome: "match", requestId, checkId, generation: 3,
      state: "connected", elapsedMs: 1.5, attempt: 2, timestamp: 100 },
    { event: "relay_failure", outcome: "auth_timeout", timestamp: 100 },
  ]);
  expect(readFileSync(path, "utf8")).not.toContain("private");
  expect(readdirSync(configDir)).toEqual(["link"]);
});

test("deduplicates across changing IDs and reports suppression on the next eligible write", async () => {
  const { configDir, path } = fixture();
  let now = 0;
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  const requestId = randomUUID();
  const checkId = randomUUID();
  sink({ event: "owner_lookup", outcome: "match", requestId, checkId });
  now = 999;
  for (let i = 0; i < 50; i++) sink({ event: "owner_lookup", outcome: "match", requestId: randomUUID(), generation: i });
  sink({ event: "owner_lookup", outcome: "deadline" });
  sink({ event: "relay_retry", outcome: "match" });
  await sink.flush();
  expect(records(path)).toHaveLength(3);
  now = 1_000;
  sink({ event: "owner_lookup", outcome: "match" });
  now = 2_000;
  sink({ event: "owner_lookup", outcome: "match" });
  await sink.flush();
  const written = records(path);
  expect(written[0]).toEqual({ event: "owner_lookup", outcome: "match", requestId, checkId, timestamp: 0 });
  expect(written[3]).toEqual({ event: "owner_lookup", outcome: "match", timestamp: 1_000, suppressed: 50 });
  expect(written[4]).toEqual({ event: "owner_lookup", outcome: "match", timestamp: 2_000 });
});

test("a backward clock step starts a new diagnostic window and preserves suppression counts", async () => {
  const { configDir, path } = fixture();
  let now = 10_000;
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  const record: LinkDiagnosticRecord = { event: "relay_failure", outcome: "auth_timeout" };
  sink(record);
  now = 10_500;
  sink(record);
  now = 5_000;
  sink(record);
  now = 5_500;
  sink(record);
  now = 6_000;
  sink(record);
  await sink.flush();
  expect(records(path)).toEqual([
    { ...record, timestamp: 10_000 },
    { ...record, timestamp: 5_000, suppressed: 1 },
    { ...record, timestamp: 6_000, suppressed: 1 },
  ]);
});

test("keeps private modes and rotates at 256 KiB with only one bounded backup", async () => {
  const { configDir, dir, path } = fixture();
  let now = 0;
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  sink({ event: "owner_lookup", outcome: "match" });
  await sink.flush();
  if (process.platform !== "win32") {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(dir, 0o755);
    chmodSync(path, 0o644);
  }
  // Seed the boundary directly instead of writing megabytes through the sink.
  const seed = `${" ".repeat(256 * 1024 - 1)}\n`;
  writeFileSync(path, seed);
  writeFileSync(`${path}.1`, "old backup\n");
  now = 1_000;
  sink({ event: "owner_lookup", outcome: "match" });
  await sink.flush();
  expect(readFileSync(`${path}.1`, "utf8")).toBe(seed);
  expect(records(path)).toEqual([{ event: "owner_lookup", outcome: "match", timestamp: now }]);
  writeFileSync(path, seed);
  now = 2_000;
  sink({ event: "relay_failure", outcome: "transport_error" });
  await sink.flush();
  expect(readdirSync(dir).sort()).toEqual(["diagnostics.jsonl", "diagnostics.jsonl.1"]);
  expect(statSync(path).size).toBeLessThanOrEqual(256 * 1024);
  expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(256 * 1024);
  expect(statSync(path).size + statSync(`${path}.1`).size).toBeLessThanOrEqual(512 * 1024);
  if (process.platform !== "win32") {
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(`${path}.1`).mode & 0o777).toBe(0o600);
  }
});

test("filesystem and clock failures never escape the sink", async () => {
  const { configDir, dir, path } = fixture();
  let now = 0;
  writeFileSync(dir, "not a directory");
  const record: LinkDiagnosticRecord = { event: "relay_failure", outcome: "transport_error" };
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  expect(() => sink(record)).not.toThrow();
  await sink.flush();
  expect(existsSync(path)).toBe(false);
  expect(() => createLinkDiagnosticSink({ configDir, now: () => { throw new Error("private"); } })(record)).not.toThrow();
  expect(readFileSync(dir, "utf8")).toBe("not a directory");
  unlinkSync(dir);
  now = 999;
  sink(record);
  await sink.flush();
  expect(existsSync(path)).toBe(false);
  now = 1_000;
  sink(record);
  await sink.flush();
  expect(records(path)).toEqual([{ ...record, timestamp: 1_000, suppressed: 1 }]);
});

test.skipIf(process.platform === "win32")("refuses symlink logs without modifying their targets", async () => {
  const { configDir, dir, path } = fixture();
  const target = join(configDir, "foreign");
  mkdirSync(dir);
  writeFileSync(target, "preserve");
  symlinkSync(target, path);
  const sink = createLinkDiagnosticSink({ configDir });
  expect(() => sink({ event: "owner_lookup", outcome: "match" })).not.toThrow();
  await sink.flush();
  expect(readFileSync(target, "utf8")).toBe("preserve");
});


test("Windows diagnostic appends reuse ACLs only until the file or its permissions change", async () => {
  const { configDir, path } = fixture();
  let now = 0, grants = 0;
  let permissionFreshness: bigint | undefined;
  const observedStat = (target: string) => {
    const { dev, ino, ctimeNs } = statSync(target, { bigint: true });
    return { dev, ino, ctimeNs: target === path ? permissionFreshness ?? ctimeNs : ctimeNs };
  };
  setPlatformForTests("win32");
  resetHardenedStateForTests();
  setStatForTests(observedStat);
  setAsyncWindowsPrincipalRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false,
    stdout: "S-1-5-21-1-2-3-1001\nTEST\\user\n" }));
  setAsyncIcaclsRunnerForTests(async args => {
    if (args[0] === path && args.includes("/grant:r")) grants++;
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  const append = async () => {
    sink({ event: "relay_failure", outcome: "auth_timeout" });
    await sink.flush();
    now += 1_000;
  };
  try {
    await append();
    expect(grants).toBe(1);
    await append();
    expect(records(path)).toHaveLength(2);
    expect(grants).toBe(1);

    // Keep the old object alive so replacing the path cannot recycle its inode.
    renameSync(path, `${path}.old`);
    writeFileSync(path, "");
    await append();
    expect(records(path)).toHaveLength(1);
    expect(grants).toBe(2);
    await append();
    expect(grants).toBe(2);

    const beforePermissions = observedStat(path);
    chmodSync(path, 0o400);
    chmodSync(path, 0o600);
    // Model an observable permission change regardless of the host filesystem's ctime granularity.
    permissionFreshness = beforePermissions.ctimeNs + 1n;
    const afterPermissions = observedStat(path);
    expect(afterPermissions.dev).toBe(beforePermissions.dev);
    expect(afterPermissions.ino).toBe(beforePermissions.ino);
    expect(afterPermissions.ctimeNs).not.toBe(beforePermissions.ctimeNs);
    await append();
    expect(records(path)).toHaveLength(3);
    expect(grants).toBe(3);
  } finally {
    await sink.flush();
    setAsyncIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    setStatForTests(null);
    setAsyncWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
  }
});

test.each([false, true])("slow Windows ACL work yields and bounds the queue (clock rolls back: %s)", async rollback => {
  const { configDir, path } = fixture();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let first = true, now = 0, syncCalls = 0;
  setPlatformForTests("win32");
  resetHardenedStateForTests();
  setAsyncWindowsPrincipalRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false,
    stdout: "S-1-5-21-1-2-3-1001\nTEST\\user\n" }));
  setIcaclsRunnerForTests(() => { syncCalls++; throw new Error("synchronous ACL work is forbidden"); });
  setAsyncIcaclsRunnerForTests(async () => {
    if (first) { first = false; enter(); await blocked; }
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
  const sink = createLinkDiagnosticSink({ configDir, now: () => now });
  try {
    sink({ event: "owner_lookup", outcome: "match", attempt: 0 });
    await entered;
    for (let attempt = 1; attempt <= 100; attempt++) {
      now += 1_000;
      sink({ event: "owner_lookup", outcome: "match", attempt });
    }
    // A deadline must still be able to fire while the diagnostics child is stalled.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(existsSync(path)).toBe(false);
    expect(syncCalls).toBe(0);
    if (rollback) {
      now = 5_000;
      sink({ event: "owner_lookup", outcome: "match", attempt: 101 });
    }
    // Shutdown must return even while the ACL runner is still blocked.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([
        sink.flush(10).then(() => "drained"),
        new Promise<string>(resolve => { watchdog = setTimeout(() => resolve("blocked"), 500); }),
      ])).toBe("drained");
      expect(existsSync(path)).toBe(false);
    } finally {
      clearTimeout(watchdog);
    }
    release();
    await sink.flush();
    expect(records(path)).toHaveLength(57); // one active record plus at most 56 queued
    if (rollback) {
      now += 500;
      sink({ event: "owner_lookup", outcome: "match", attempt: 102 });
      await sink.flush();
      expect(records(path)).toHaveLength(57);
    }
    now += rollback ? 500 : 1_000;
    const attempt = rollback ? 103 : 101;
    sink({ event: "owner_lookup", outcome: "match", attempt });
    await sink.flush();
    expect(records(path).at(-1)).toMatchObject({ attempt, timestamp: now, suppressed: rollback ? 46 : 44 });
  } finally {
    release();
    await sink.flush();
    setAsyncIcaclsRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    setAsyncWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
  }
});
