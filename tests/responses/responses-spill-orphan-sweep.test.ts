// The periodic counterpart of the startup orphan GC lives in responses-state.test.ts, but
// that file sits at its file-size cap. These cases prove sweepOrphanedResponseSpills
// reclaims crash/cleanup orphans while the process keeps running and never touches the
// files any live ownership path still needs.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { constants, copyFileSync, existsSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitResponseSpillPublicationTailForTests,
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  flushPendingResponseSpillsForTests,
  flushResponseState,
  rememberResponseState,
  setResponseStateByteCapForTests,
  sweepOrphanedResponseSpills,
} from "../../src/responses/state";
import {
  PERIODIC_SPILL_SWEEP_OPTS,
  RESPONSE_SPILL_DIR_NAME,
  responseSpillDirectory,
  setSpillIoForTest,
  sweepOrphanedResponseSpillsPeriodically,
  writeResponseSpillDurably,
} from "../../src/responses/spill-store";
import {
  resetHardenedStateForTests,
  setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import {
  resetWindowsPrincipalForTests,
  setAsyncWindowsPrincipalRunnerForTests,
  setWindowsPrincipalRunnerForTests,
} from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const SYNTHETIC_SID = { success: true, exitCode: 0, timedOut: false, stdout: "S-1-5-21-1-2-3-1001\nocx-test\n" };

function forceWindowsAclLane(): void {
  setPlatformForTests("win32");
  setWindowsPrincipalRunnerForTests(() => SYNTHETIC_SID);
  setAsyncWindowsPrincipalRunnerForTests(async () => SYNTHETIC_SID);
}

function isSpillAclTarget(args: string[]): boolean {
  return args.some(arg => arg.includes(RESPONSE_SPILL_DIR_NAME));
}

function fixedResponse(id: string, output: unknown[]): { id: string; output: unknown[]; status: string } {
  return { id, output, status: "completed" };
}

function rememberLarge(id: string, text: string): void {
  rememberResponseState(
    { model: "test/model", input: text, store: false },
    fixedResponse(id, [{ type: "message", role: "assistant", content: text }]),
    undefined,
    { force: true },
  );
}

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
}

function agePastGrace(path: string): void {
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(path, old, old);
}

describe("Periodic orphan response-spill sweep", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-orphan-sweep-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    // Generic cases assert the synchronous spill lane; Windows-lane cases force it themselves.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setSpillIoForTest(null);
    setAsyncIcaclsRunnerForTests(null);
    setIcaclsRunnerForTests(null);
    setPlatformForTests(null);
    setWindowsPrincipalRunnerForTests(null);
    setAsyncWindowsPrincipalRunnerForTests(null);
    resetWindowsPrincipalForTests();
    resetHardenedStateForTests();
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("is a no-op before the lazy snapshot load runs", () => {
    const orphan = writeResponseSpillDurably("resp_orphan_preload", {
      createdAt: Date.now(), items: ["orphan"],
    });
    agePastGrace(join(responseSpillDirectory(home), orphan.fileName));

    expect(sweepOrphanedResponseSpills()).toBe(0);
    expect(existsSync(join(responseSpillDirectory(home), orphan.fileName))).toBe(true);
  });

  test("reclaims an aged orphan while the process keeps running", () => {
    setResponseStateByteCapForTests(1_024);
    // rememberLarge forces ensureLoaded and leaves one live spill on disk.
    rememberLarge("resp_live_periodic", "l".repeat(8_000));
    const orphan = writeResponseSpillDurably("resp_orphan_periodic", {
      createdAt: Date.now(), items: ["orphan"],
    });
    agePastGrace(join(responseSpillDirectory(home), orphan.fileName));

    expect(sweepOrphanedResponseSpills()).toBe(1);
    expect(existsSync(join(responseSpillDirectory(home), orphan.fileName))).toBe(false);
  });

  test("keeps live stubs deferred unlinks and young files", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_keep_live", "k".repeat(8_000));
    rememberLarge("resp_keep_superseded", "o".repeat(8_000));
    const liveFile = spillFileNames(home).find(name => name.startsWith("resp_keep_live."))!;
    const supersededFile = spillFileNames(home).find(name => name.startsWith("resp_keep_superseded."))!;
    // A same-id replacement parks the old generation in pendingSpillUnlinks until the
    // next stable persist — the durable snapshot still names it, so it stays referenced.
    rememberLarge("resp_keep_superseded", "n".repeat(8_000));
    const young = writeResponseSpillDurably("resp_young_periodic", {
      createdAt: Date.now(), items: ["young"],
    });
    agePastGrace(join(responseSpillDirectory(home), liveFile));
    agePastGrace(join(responseSpillDirectory(home), supersededFile));

    expect(sweepOrphanedResponseSpills()).toBe(0);
    expect(existsSync(join(responseSpillDirectory(home), liveFile))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), supersededFile))).toBe(true);
    expect(existsSync(join(responseSpillDirectory(home), young.fileName))).toBe(true);

    // A stable persist drains the deferred unlink queue itself; the sweep is not what frees it.
    await flushResponseState();
    expect(existsSync(join(responseSpillDirectory(home), supersededFile))).toBe(false);
  });

  test("keeps an in-flight publication's temp and destination", async () => {
    forceWindowsAclLane();
    // Force the exclusive-copy publish lane so the destination exists on disk while its
    // ACL harden is still gated — the widest window an orphan sweep could see mid-flight.
    setSpillIoForTest({
      link() { throw Object.assign(new Error("no link"), { code: "EACCES" }); },
      copyFileExcl(temp, destination) { copyFileSync(temp, destination, constants.COPYFILE_EXCL); },
    });
    let releaseDestination!: () => void;
    let destinationEntered!: () => void;
    const destinationGate = new Promise<void>(resolve => { releaseDestination = resolve; });
    const destinationStarted = new Promise<void>(resolve => { destinationEntered = resolve; });
    setAsyncIcaclsRunnerForTests(async args => {
      if (!isSpillAclTarget(args)) return ICACLS_OK;
      if (args.some(arg => arg.endsWith(".spill.json"))) {
        destinationEntered();
        await destinationGate;
      }
      return ICACLS_OK;
    });
    setIcaclsRunnerForTests(() => ICACLS_OK);
    setResponseStateByteCapForTests(1_024);

    let destination = "";
    try {
      rememberLarge("resp_inflight_periodic", "i".repeat(8_000));
      await destinationStarted;
      const dir = responseSpillDirectory(home);
      destination = readdirSync(dir).find(name => name.endsWith(".spill.json"))!;
      const temp = readdirSync(dir).find(name => name.endsWith(".tmp"))!;
      agePastGrace(join(dir, destination));
      agePastGrace(join(dir, temp));

      expect(sweepOrphanedResponseSpills()).toBe(0);
      expect(existsSync(join(dir, destination))).toBe(true);
      expect(existsSync(join(dir, temp))).toBe(true);
    } finally {
      releaseDestination();
      await awaitResponseSpillPublicationTailForTests();
      await flushPendingResponseSpillsForTests();
    }
    expect(existsSync(join(responseSpillDirectory(home), destination))).toBe(true);
  });

  test("resumes past a full window of owned files on the next tick", () => {
    const dir = responseSpillDirectory(home);
    const owned = new Set<string>();
    const orphans: string[] = [];
    const total = PERIODIC_SPILL_SWEEP_OPTS.scanMax + 64;
    for (let i = 0; i < total; i += 1) {
      const ref = writeResponseSpillDurably(`resp_window_${i}`, { createdAt: Date.now(), items: [i] });
      agePastGrace(join(dir, ref.fileName));
      if (i % 20 === 0) orphans.push(ref.fileName);
      else owned.add(ref.fileName);
    }

    let removed = 0;
    for (let tick = 0; tick < 3; tick += 1) removed += sweepOrphanedResponseSpillsPeriodically(owned, dir).removed;

    expect(removed).toBe(orphans.length);
    expect(orphans.filter(name => existsSync(join(dir, name)))).toEqual([]);
    expect(spillFileNames(home)).toHaveLength(owned.size);
  });

  test("keeps advancing when enumeration alone would exhaust the tick deadline", () => {
    // Regression: the cursor used to be an offset re-skipped from a fresh
    // opendir each tick, and that skip spent the deadline — so once
    // enumeration got slow the cursor stopped moving and a trailing orphan
    // was never reached. Every name read costs 10 ms here, so a tick can
    // only process a handful of entries; progress must still accumulate.
    const dir = responseSpillDirectory(home);
    const orphan = writeResponseSpillDurably("resp_trailing_orphan", { createdAt: Date.now(), items: ["o"] });
    agePastGrace(join(dir, orphan.fileName));
    const names = Array.from({ length: PERIODIC_SPILL_SWEEP_OPTS.scanMax }, (_, i) => `owned-${i}.txt`);
    names.push(orphan.fileName);
    let clock = Date.now();
    const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
    let served = 0;
    setSpillIoForTest({
      readdirEntry() {
        clock += 10;
        return served < names.length ? names[served++]! : null;
      },
    });
    try {
      let ticks = 0;
      while (existsSync(join(dir, orphan.fileName)) && ticks < names.length) {
        sweepOrphanedResponseSpillsPeriodically(new Set(), dir);
        ticks += 1;
      }
      expect(existsSync(join(dir, orphan.fileName))).toBe(false);
      // Each name is read once: no tick re-walks the prefix.
      expect(served).toBe(names.length);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
