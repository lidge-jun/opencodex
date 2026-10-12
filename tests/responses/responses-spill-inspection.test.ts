import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  flushResponseState,
  inspectResponseSpillStorage,
  rememberResponseState,
  setResponseStateByteCapForTests,
} from "../../src/responses/state";
import { collectReferencedSpillFileNames } from "../../src/responses/state/spill-inspect";
import {
  inspectResponseSpillDir,
  recoverOrphanedResponseSpills,
  RESPONSE_SPILL_ORPHAN_GRACE_MS,
  RESPONSE_SPILL_SCAN_MAX,
  responseSpillDirectory,
  setSpillIoForTest,
  writeResponseSpillDurably,
} from "../../src/responses/spill-store";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function spillFileNames(home: string): string[] {
  const dir = responseSpillDirectory(home);
  return existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".spill.json")) : [];
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

describe("response spill directory inspection", () => {
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-spill-inspect-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    // Generic cases assert the synchronous spill lane; a Windows host would queue them.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setSpillIoForTest(null);
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("classifies files into owned, orphan candidate, and plain leftover", () => {
    const dir = responseSpillDirectory(home);
    const owned = writeResponseSpillDurably("resp_owned", { createdAt: Date.now(), items: ["a"] });
    const orphan = writeResponseSpillDurably("resp_orphan", { createdAt: Date.now(), items: ["b"] });
    const young = writeResponseSpillDurably("resp_young", { createdAt: Date.now(), items: ["c"] });
    writeFileSync(join(dir, "unrelated.bin"), "keep");
    const old = new Date(Date.now() - RESPONSE_SPILL_ORPHAN_GRACE_MS - 60_000);
    // Aging a REFERENCED file must not make it an orphan: the reference wins.
    utimesSync(join(dir, owned.fileName), old, old);
    utimesSync(join(dir, orphan.fileName), old, old);

    const result = inspectResponseSpillDir(new Set([owned.fileName]), dir);

    expect(result.files).toBe(4);
    expect(result.bytes).toBe(
      [owned, orphan, young].reduce((total, ref) => total + ref.payloadBytes, 0)
        + statSync(join(dir, "unrelated.bin")).size,
    );
    expect(result.ownedFiles).toBe(1);
    expect(result.ownedBytes).toBe(owned.payloadBytes);
    expect(result.orphanFiles).toBe(1);
    expect(result.orphanBytes).toBe(orphan.payloadBytes);
    expect(result.truncated).toBe(false);
    // Dry run: nothing is unlinked.
    for (const name of [owned.fileName, orphan.fileName, young.fileName, "unrelated.bin"]) {
      expect(existsSync(join(dir, name))).toBe(true);
    }
  });

  test("the report and the reclaim agree on the orphan set", () => {
    const dir = responseSpillDirectory(home);
    const kept = writeResponseSpillDurably("resp_kept", { createdAt: Date.now(), items: ["k"] });
    const old = new Date(Date.now() - RESPONSE_SPILL_ORPHAN_GRACE_MS - 60_000);
    const orphans = [
      writeResponseSpillDurably("resp_orphan_1", { createdAt: Date.now(), items: ["1"] }),
      writeResponseSpillDurably("resp_orphan_2", { createdAt: Date.now(), items: ["2"] }),
    ];
    for (const ref of orphans) utimesSync(join(dir, ref.fileName), old, old);

    const inspect = inspectResponseSpillDir(new Set([kept.fileName]), dir);
    const reclaim = recoverOrphanedResponseSpills(new Set([kept.fileName]), dir);

    expect(reclaim.removed).toBe(inspect.orphanFiles);
    expect(reclaim.bytesRemoved).toBe(inspect.orphanBytes);
    expect(existsSync(join(dir, kept.fileName))).toBe(true);
  });

  test("scan cap marks the report truncated through the injected directory seam", () => {
    // The injected seam lets the cap be proven without materializing thousands of
    // files: an endless name stream stops exactly at the scan bound.
    setSpillIoForTest({ readdirEntry: () => "endless.spill.json" });
    const result = inspectResponseSpillDir(new Set(), responseSpillDirectory(home));
    expect(result.scanned).toBe(RESPONSE_SPILL_SCAN_MAX);
    expect(result.truncated).toBe(true);
  });

  test("collectReferencedSpillFileNames unions spill stubs and pending unlinks", () => {
    const referenced = collectReferencedSpillFileNames(
      [
        { kind: "spill", createdAt: 1, spill: { version: 1, fileName: "a.spill.json", digest: "d".repeat(64), payloadBytes: 1 }, sizeBytes: 1 },
        { kind: "resident", createdAt: 1, items: [], sizeBytes: 1 },
      ],
      [{ version: 1, fileName: "b.spill.json", digest: "d".repeat(64), payloadBytes: 1 }],
    );
    expect([...referenced].sort()).toEqual(["a.spill.json", "b.spill.json"]);
  });

  test("inspectResponseSpillStorage counts a snapshot-referenced file as owned with empty memory", async () => {
    // The doctor scenario: a fresh process has nothing in memory, so the durable
    // snapshot is the only ownership evidence — and the report must still count
    // the file as owned rather than orphan.
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_live", "x".repeat(8_000));
    await flushResponseState();
    const live = spillFileNames(home)[0]!;
    const orphan = writeResponseSpillDurably("resp_orphan", { createdAt: Date.now(), items: ["orphan"] });
    const old = new Date(Date.now() - RESPONSE_SPILL_ORPHAN_GRACE_MS - 60_000);
    utimesSync(join(responseSpillDirectory(home), orphan.fileName), old, old);

    clearResponseStateMemoryForTests();
    const result = inspectResponseSpillStorage();

    expect(result.ownedFiles).toBe(1);
    expect(result.ownedBytes).toBe(statSync(join(responseSpillDirectory(home), live)).size);
    expect(result.orphanFiles).toBe(1);
    expect(result.orphanBytes).toBe(orphan.payloadBytes);
    expect(existsSync(join(responseSpillDirectory(home), orphan.fileName))).toBe(true);
  });

  test("inspectResponseSpillStorage counts a pending superseded generation as owned", async () => {
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_swap", "a".repeat(8_000));
    await flushResponseState();
    rememberLarge("resp_swap", "b".repeat(8_000));
    // Between the stub swap and the next stable snapshot the OLD generation sits in
    // pendingSpillUnlinks: still owned, never an orphan. This is synchronous — the
    // debounced persist cannot interleave inside a single turn.
    const result = inspectResponseSpillStorage();
    expect(result.files).toBe(2);
    expect(result.ownedFiles).toBe(2);
    expect(result.orphanFiles).toBe(0);
  });

  test("a missing or corrupt snapshot contributes no references and never throws", () => {
    writeResponseSpillDurably("resp_solo", { createdAt: Date.now(), items: ["s"] });
    writeFileSync(join(home, "responses-state.json"), "not json");
    const result = inspectResponseSpillStorage();
    expect(result.ownedFiles).toBe(0);
    expect(result.files).toBe(1);
  });
});
