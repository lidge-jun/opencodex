import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitResponseSpillPublicationTailForTests,
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  getAccountedResponseSpillBytesForTests,
  getSpilledResponseBytesForTests,
  pendingResponseSpillMetricsForTests,
  rememberResponseState,
  responseStateMetrics,
  setResponseSpillAsyncAclAttemptBudgetForTests,
  setResponseSpillShutdownBudgetForTests,
  setResponseStateByteCapForTests,
  setSpilledResponseByteCapForTests,
} from "../../src/responses/state";
import {
  RESPONSE_SPILL_DIR_NAME,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
  setResponseSpillNowForTests,
  setResponseSpillPayloadCapForTests,
  setSpillIoForTest,
} from "../../src/responses/spill-store";
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setNowForTests,
  setPlatformForTests,
  setStatForTests,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const SYNTHETIC_SID = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nocx-test\n" };
const TEXT = "x".repeat(8_000);

function forceWindowsAclLane(): void {
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => SYNTHETIC_SID);
  setAsyncWindowsPrincipalRunnerForTests(async () => SYNTHETIC_SID);
}

function isSpillAclTarget(args: string[]): boolean {
  return args.some(arg => arg.includes(RESPONSE_SPILL_DIR_NAME));
}

function rememberLarge(id: string, text = TEXT): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    { id, output: [{ type: "message", role: "assistant", content: text }], status: "completed" },
    undefined,
    { force: true },
  );
}

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
}

function spillTempNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".tmp")) : [];
}

/** Price every physical file, including publish temps and failed-unlink debt. */
function bytesOnDisk(home: string): number {
  const dir = responseSpillDirectory(home);
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const name of readdirSync(dir)) {
    try { total += statSync(join(dir, name)).size; } catch { /* raced with an unlink */ }
  }
  return total;
}

function expectReplay(id: string, text = TEXT): void {
  const expanded = expandPreviousResponseInput({ previous_response_id: id, input: "next" }) as { input: unknown[] };
  expect(expanded.input).toEqual([
    { role: "user", content: text },
    { type: "message", role: "assistant", content: text },
    { role: "user", content: "next" },
  ]);
}

describe("Response spill admission headroom (#6747)", () => {
  let home: string;
  let clock: number;
  let clockSpy: ReturnType<typeof spyOn>;
  const priorHome = process.env["OPENCODEX_HOME"];
  const priorAclTimeout = process.env["OPENCODEX_ACL_TIMEOUT_MS"];
  const releases: Array<() => void> = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-spill-headroom-"));
    process.env["OPENCODEX_HOME"] = home;
    delete process.env["OPENCODEX_ACL_TIMEOUT_MS"];
    clearResponseStateMemoryForTests();
    resetHardenedStateForTests();
    resetWindowsPrincipalForTests();
    forceWindowsAclLane();
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
    // Fixed, same-width timestamps make equal payloads equal envelopes. Increment only
    // between stores to give retention order an unambiguous age independent of wall time.
    clock = Date.now();
    clockSpy = spyOn(Date, "now").mockImplementation(() => clock);
    setNowForTests(() => clock);
    setResponseSpillNowForTests(() => clock);
    setResponseStateByteCapForTests(1_024);
    setSpilledResponseByteCapForTests(null);
    setResponseSpillShutdownBudgetForTests({ totalMs: 120, fallbackReserveMs: 80 });
  });

  afterEach(async () => {
    // Never let an assertion failure strand the serialized tail or its ACL runner.
    for (const release of releases.splice(0)) release();
    try {
      await awaitResponseSpillPublicationTailForTests();
    } finally {
      setSpillIoForTest(null);
      setResponseSpillNowForTests(null);
      setResponseSpillPayloadCapForTests(null);
      setAsyncIcaclsRunnerForTests(null);
      setIcaclsRunnerForTests(null);
      setNowForTests(null);
      setPlatformForTests(null);
      setWindowsPrincipalRunnerForTests(null);
      setAsyncWindowsPrincipalRunnerForTests(null);
      resetWindowsPrincipalForTests();
      setStatForTests(null);
      resetHardenedStateForTests();
      setResponseSpillShutdownBudgetForTests(null);
      setResponseSpillAsyncAclAttemptBudgetForTests(null);
      setResponseStateByteCapForTests(null);
      setSpilledResponseByteCapForTests(null);
      clearResponseStateForTests();
      clockSpy.mockRestore();
      removeTreeWithRetry(home);
      if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
      else process.env["OPENCODEX_HOME"] = priorHome;
      if (priorAclTimeout === undefined) delete process.env["OPENCODEX_ACL_TIMEOUT_MS"];
      else process.env["OPENCODEX_ACL_TIMEOUT_MS"] = priorAclTimeout;
    }
  });

  async function seed(id: string, text = TEXT): Promise<{ bytes: number; file: string }> {
    const beforeBytes = getSpilledResponseBytesForTests();
    const beforeNames = new Set(spillFileNames(home));
    clock += 1;
    rememberLarge(id, text);
    await awaitResponseSpillPublicationTailForTests();
    const bytes = getSpilledResponseBytesForTests() - beforeBytes;
    const file = spillFileNames(home).find(name => !beforeNames.has(name));
    expect(bytes).toBeGreaterThan(0);
    expect(file).toBeDefined();
    expect(statSync(join(responseSpillDirectory(home), file!)).size).toBe(bytes);
    return { bytes, file: file! };
  }

  function exists(file: string): boolean {
    return existsSync(join(responseSpillDirectory(home), file));
  }

  function gateAcl(): { started: Promise<void>; release: () => void } {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    releases.push(release);
    setAsyncIcaclsRunnerForTests(async args => {
      // Snapshot hardens share this runner on Windows; they must remain ungated.
      if (!isSpillAclTarget(args) || !args.some(arg => arg.endsWith(".tmp"))) return ICACLS_OK;
      entered();
      await gate;
      return ICACLS_OK;
    });
    return { started, release };
  }

  function failUnlink(file: string, code: "EBUSY" | "EPERM" = "EBUSY"): string[] {
    const attempts: string[] = [];
    setSpillIoForTest({ unlink(path) {
      attempts.push(path);
      if (path === join(responseSpillDirectory(home), file)) {
        throw Object.assign(new Error("fixture: spill still locked"), { code });
      }
      unlinkSync(path);
    } });
    return attempts;
  }

  test("case 1: under-cap admission evicts oldest to fit the next publication", async () => {
    const oldest = await seed("resp_a");
    const middle = await seed("resp_b");
    const newestSeed = await seed("resp_c");
    expect(middle.bytes).toBe(oldest.bytes);
    expect(newestSeed.bytes).toBe(oldest.bytes);
    const cap = Math.floor(oldest.bytes * 4.5);
    setSpilledResponseByteCapForTests(cap);
    expect(getAccountedResponseSpillBytesForTests()).toBeLessThan(cap);
    clock += 1;
    rememberLarge("resp_d");
    // Admission happens before any async file creation, so this also bounds the
    // peak reservation rather than just the much smaller final installed payload.
    expect(getAccountedResponseSpillBytesForTests()).toBeLessThanOrEqual(cap);
    await awaitResponseSpillPublicationTailForTests();
    expect(exists(oldest.file)).toBe(false);
    expect(exists(middle.file)).toBe(true);
    expect(exists(newestSeed.file)).toBe(true);
    expect(spillFileNames(home)).toHaveLength(3);
    expect(responseStateMetrics()).toMatchObject({ tombstoneCount: 0, spillCapacityRefusals: 0 });
    expect(responseStateMetrics().spillHeadroomEvictions).toBeGreaterThanOrEqual(1);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_d");
  });

  test("case 12: an envelope over the replay ceiling never evicts for headroom", async () => {
    // Measure the incoming envelope with a same-length id, then start from an empty store.
    const probe = await seed("resp_prb", "y".repeat(16_000));
    clearResponseStateForTests();
    const a = await seed("resp_a");
    const b = await seed("resp_b");
    const c = await seed("resp_c");
    expect(probe.bytes).toBeGreaterThan(a.bytes);
    setResponseSpillPayloadCapForTests(probe.bytes - 1);
    // Without the replay ceiling this publication would fit after evicting the oldest seed.
    const cap = 2 * a.bytes + 2 * probe.bytes + Math.floor(a.bytes / 2);
    setSpilledResponseByteCapForTests(cap);
    expect(getAccountedResponseSpillBytesForTests() + 2 * probe.bytes).toBeGreaterThan(cap);
    clock += 1;
    rememberLarge("resp_big", "y".repeat(16_000));
    await awaitResponseSpillPublicationTailForTests();
    for (const seeded of [a, b, c]) expect(exists(seeded.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, tombstoneCount: 1 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
  });

  test("case 2: exact fit preserves every seed without a headroom eviction", async () => {
    const a = await seed("resp_a");
    const b = await seed("resp_b");
    const cap = getAccountedResponseSpillBytesForTests() + 2 * b.bytes;
    setSpilledResponseByteCapForTests(cap);
    clock += 1;
    rememberLarge("resp_c");
    expect(getAccountedResponseSpillBytesForTests()).toBe(cap);
    await awaitResponseSpillPublicationTailForTests();
    expect(exists(a.file)).toBe(true);
    expect(exists(b.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 0, tombstoneCount: 0 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_c");
  });

  test("case 3: an impossible two-envelope footprint refuses without evicting a seed", async () => {
    const a = await seed("resp_a");
    const cap = Math.floor(a.bytes * 1.5);
    setSpilledResponseByteCapForTests(cap);
    rememberLarge("resp_b");
    await awaitResponseSpillPublicationTailForTests();
    expect(exists(a.file)).toBe(true);
    expect(spillFileNames(home)).toEqual([a.file]);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
  });

  test("case 4: same-id admission prices its inherited generation and evicts enough", async () => {
    const unrelated = await seed("resp_a");
    const inherited = await seed("resp_b");
    const cap = 3 * inherited.bytes;
    setSpilledResponseByteCapForTests(cap);
    clock += 1;
    rememberLarge("resp_b", "y".repeat(8_000));
    expect(exists(unrelated.file)).toBe(false);
    expect(getAccountedResponseSpillBytesForTests()).toBe(cap);
    await awaitResponseSpillPublicationTailForTests();
    // The inherited file is deferred, still priced until a stable snapshot commits.
    expect(exists(inherited.file)).toBe(true);
    expect(getAccountedResponseSpillBytesForTests()).toBe(2 * inherited.bytes);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 1, spillCapacityRefusals: 0 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_b", "y".repeat(8_000));
  });

  test("case 4 refusal: inherited plus footprint cannot fit, unrelated seed survives", async () => {
    const unrelated = await seed("resp_a");
    const inherited = await seed("resp_b");
    const cap = Math.floor(2.5 * inherited.bytes);
    setSpilledResponseByteCapForTests(cap);
    rememberLarge("resp_b", "y".repeat(8_000));
    await awaitResponseSpillPublicationTailForTests();
    expect(exists(unrelated.file)).toBe(true);
    expect(exists(inherited.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
  });

  test("case 5: an in-flight reservation is pinned during the second admission", async () => {
    const seedSpill = await seed("resp_a");
    const cap = Math.floor(3.5 * seedSpill.bytes);
    setSpilledResponseByteCapForTests(cap);
    const gate = gateAcl();
    clock += 1;
    rememberLarge("resp_b");
    await gate.started;
    const pinned = getAccountedResponseSpillBytesForTests() - getSpilledResponseBytesForTests();
    expect(pinned).toBe(2 * seedSpill.bytes);
    const temp = spillTempNames(home)[0]!;
    expect(temp).toBeDefined();
    rememberLarge("resp_c");
    expect(exists(seedSpill.file)).toBe(true);
    expect(exists(temp)).toBe(true);
    expect(pendingResponseSpillMetricsForTests().count).toBe(1);
    expect(getAccountedResponseSpillBytesForTests()).toBe(seedSpill.bytes + pinned);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 1 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    gate.release();
    await awaitResponseSpillPublicationTailForTests();
    expectReplay("resp_b");
    expectReplay("resp_a");
  });

  test("case 6: shutdown fallback reclaims feasible superseded headroom", async () => {
    const unrelated = await seed("resp_a");
    const inherited = await seed("resp_b");
    const gate = gateAcl();
    clock += 1;
    rememberLarge("resp_b", "y".repeat(8_000));
    await gate.started;
    expect(getAccountedResponseSpillBytesForTests()).toBe(4 * inherited.bytes);
    const cap = Math.floor(3.5 * inherited.bytes);
    // Lower after admission to exercise fallback's own re-admission, not the queue's.
    setSpilledResponseByteCapForTests(cap);
    let syncSpillCalls = 0;
    setIcaclsRunnerForTests(args => {
      if (isSpillAclTarget(args)) syncSpillCalls += 1;
      return ICACLS_OK;
    });
    await flushResponseState();
    expect(syncSpillCalls).toBeGreaterThan(0);
    expect(exists(unrelated.file)).toBe(false);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 1, spillCapacityRefusals: 0, tombstoneCount: 0 });
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
    expect(spillTempNames(home)).toHaveLength(0);
    expect(getAccountedResponseSpillBytesForTests()).toBe(inherited.bytes);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_b", "y".repeat(8_000));
    gate.release();
    await awaitResponseSpillPublicationTailForTests();
    expectReplay("resp_b", "y".repeat(8_000));
  });

  test("case 7: impossible shutdown superseded footprint preserves unrelated spills", async () => {
    const unrelated = await seed("resp_a");
    const inherited = await seed("resp_b");
    const gate = gateAcl();
    clock += 1;
    rememberLarge("resp_b", "y".repeat(8_000));
    await gate.started;
    const cap = Math.floor(2.5 * inherited.bytes);
    setSpilledResponseByteCapForTests(cap);
    await expect(flushResponseState()).rejects.toThrow(/shutdown fallback incomplete/);
    expect(exists(unrelated.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
    expect(getAccountedResponseSpillBytesForTests()).toBe(unrelated.bytes);
    expect(spillTempNames(home)).toHaveLength(0);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
    gate.release();
  });

  test("case 8: deferred superseded generations are reclaimed before older installed spills", async () => {
    const unrelated = await seed("resp_a");
    const deferred = await seed("resp_b");
    await seed("resp_b", "y".repeat(8_000));
    expect(exists(deferred.file)).toBe(true);
    const cap = getSpilledResponseBytesForTests() + deferred.bytes;
    setSpilledResponseByteCapForTests(cap);
    clock += 1;
    rememberLarge("resp_c");
    expect(exists(deferred.file)).toBe(false);
    expect(exists(unrelated.file)).toBe(true);
    expect(getAccountedResponseSpillBytesForTests()).toBe(cap);
    await awaitResponseSpillPublicationTailForTests();
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 1, spillCapacityRefusals: 0, tombstoneCount: 0 });
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
    expectReplay("resp_b", "y".repeat(8_000));
    expectReplay("resp_c");
  });

  test("case 9: newest admitted continuation survives snapshot flush and disk reload", async () => {
    const a = await seed("resp_a");
    await seed("resp_b");
    await seed("resp_c");
    const cap = Math.floor(4.5 * a.bytes);
    setSpilledResponseByteCapForTests(cap);
    clock += 1;
    rememberLarge("resp_d");
    await awaitResponseSpillPublicationTailForTests();
    await flushResponseState();
    clearResponseStateMemoryForTests();
    expectReplay("resp_d");
    expect(exists(a.file)).toBe(false);
    expect(responseStateMetrics()).toMatchObject({ spillStubCount: 3, tombstoneCount: 0 });
    expect(getAccountedResponseSpillBytesForTests()).toBeLessThanOrEqual(cap);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
  });

  test("case 10: no-superseded fallback with cleanup debt refuses without collateral eviction", async () => {
    const unrelated = await seed("resp_a");
    const gate = gateAcl();
    clock += 1;
    rememberLarge("resp_b");
    await gate.started;
    const temp = spillTempNames(home)[0]!;
    expect(temp).toBeDefined();
    failUnlink(temp, "EPERM");
    const cap = Math.floor(2.5 * unrelated.bytes);
    setSpilledResponseByteCapForTests(cap);
    await expect(flushResponseState()).rejects.toThrow(/shutdown fallback incomplete/);
    expect(exists(temp)).toBe(true);
    expect(exists(unrelated.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 0, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(pendingResponseSpillMetricsForTests()).toEqual({ count: 0, bytes: 0 });
    expect(getSpilledResponseBytesForTests()).toBe(unrelated.bytes);
    expect(getAccountedResponseSpillBytesForTests()).toBe(2 * unrelated.bytes);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a");
    setSpillIoForTest(null);
    gate.release();
    await awaitResponseSpillPublicationTailForTests();
    expect(getAccountedResponseSpillBytesForTests()).toBe(unrelated.bytes);
  });

  test("case 11a: failed large oldest unlink makes admission impossible and preserves the small continuation", async () => {
    const largeText = "a".repeat(24_000);
    const smallText = "b".repeat(3_000);
    const a = await seed("resp_a", largeText);
    const b = await seed("resp_b", smallText);
    const cap = a.bytes + Math.floor(1.5 * b.bytes);
    expect(cap).toBeGreaterThanOrEqual(a.bytes + b.bytes);
    expect(cap).toBeLessThan(a.bytes + 2 * b.bytes);
    setSpilledResponseByteCapForTests(cap);
    const attempts = failUnlink(a.file);
    rememberLarge("resp_c", smallText);
    await awaitResponseSpillPublicationTailForTests();
    expect(attempts).toEqual([join(responseSpillDirectory(home), a.file)]);
    expect(exists(a.file)).toBe(true);
    expect(exists(b.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 1, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(getSpilledResponseBytesForTests()).toBe(b.bytes);
    expect(getAccountedResponseSpillBytesForTests()).toBe(a.bytes + b.bytes);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_b", smallText);
  });

  test("case 11b: failed small victim stays charged, next victim frees room, orphan recovery clears the charge", async () => {
    const smallText = "a".repeat(3_000);
    const largeText = "b".repeat(24_000);
    const a = await seed("resp_a", smallText);
    const b = await seed("resp_b", largeText);
    const cap = a.bytes + 2 * b.bytes;
    setSpilledResponseByteCapForTests(cap);
    const attempts = failUnlink(a.file, "EPERM");
    clock += 1;
    rememberLarge("resp_c", largeText);
    expect(attempts.slice(0, 2)).toEqual([
      join(responseSpillDirectory(home), a.file), join(responseSpillDirectory(home), b.file),
    ]);
    expect(getAccountedResponseSpillBytesForTests()).toBe(cap);
    await awaitResponseSpillPublicationTailForTests();
    expect(exists(a.file)).toBe(true);
    expect(exists(b.file)).toBe(false);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 2, spillCapacityRefusals: 0, tombstoneCount: 0 });
    expect(getSpilledResponseBytesForTests()).toBe(b.bytes);
    expect(getAccountedResponseSpillBytesForTests()).toBe(a.bytes + b.bytes);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_c", largeText);

    // Run the production orphan predicate and unlink, retaining all files except the
    // logically evicted victim. Advance Date.now past its real mtime and default grace.
    setSpillIoForTest(null);
    const before = getAccountedResponseSpillBytesForTests();
    clock = Math.max(clock, statSync(join(responseSpillDirectory(home), a.file)).mtimeMs) + 20 * 60_000;
    const references = new Set(spillFileNames(home).filter(name => name !== a.file));
    const recovered = recoverOrphanedResponseSpills(references, responseSpillDirectory(home));
    expect(recovered).toMatchObject({ removed: 1, failed: 0, bytesRemoved: a.bytes });
    expect(exists(a.file)).toBe(false);
    expect(getAccountedResponseSpillBytesForTests()).toBe(before - a.bytes);
    expectReplay("resp_c", largeText);
    rememberLarge("resp_d", largeText);
    await awaitResponseSpillPublicationTailForTests();
    expectReplay("resp_d", largeText);
    expect(responseStateMetrics().spillCapacityRefusals).toBe(0);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
  });

  test("case 11c: failed deferred unlink makes admission impossible before an installed continuation is evicted", async () => {
    const deferred = await seed("resp_a", "a".repeat(24_000));
    const smallText = "b".repeat(3_000);
    const installed = await seed("resp_a", smallText);
    const cap = deferred.bytes + Math.floor(1.5 * installed.bytes);
    expect(cap).toBeGreaterThanOrEqual(deferred.bytes + installed.bytes);
    expect(cap).toBeLessThan(deferred.bytes + 2 * installed.bytes);
    setSpilledResponseByteCapForTests(cap);
    const attempts = failUnlink(deferred.file);
    rememberLarge("resp_b", smallText);
    await awaitResponseSpillPublicationTailForTests();
    expect(attempts).toEqual([join(responseSpillDirectory(home), deferred.file)]);
    expect(exists(deferred.file)).toBe(true);
    expect(exists(installed.file)).toBe(true);
    expect(responseStateMetrics()).toMatchObject({ spillHeadroomEvictions: 1, spillCapacityRefusals: 1, tombstoneCount: 1 });
    expect(getSpilledResponseBytesForTests()).toBe(installed.bytes);
    expect(getAccountedResponseSpillBytesForTests()).toBe(deferred.bytes + installed.bytes);
    expect(bytesOnDisk(home)).toBeLessThanOrEqual(cap);
    expectReplay("resp_a", smallText);
  });
});
