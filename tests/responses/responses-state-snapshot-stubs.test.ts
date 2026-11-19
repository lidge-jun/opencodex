import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
  expandPreviousResponseInput,
  flushResponseState,
  rememberResponseState,
  responseStateMetrics,
  setResponseStateByteCapForTests,
  setResponseStateSnapshotByteCapForTests,
} from "../../src/responses/state";
import { responseSpillDirectory } from "../../src/responses/spill-store";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

describe("Responses snapshot spill stub retention", () => {
  // Sandbox OPENCODEX_HOME: the state store snapshots to disk, and these tests must never
  // touch the real ~/.opencodex.
  let home: string;
  const priorHome = process.env["OPENCODEX_HOME"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-state-snapshot-test-"));
    process.env["OPENCODEX_HOME"] = home;
    clearResponseStateMemoryForTests();
    // Generic cases assert the synchronous spill lane. A Windows host would otherwise route
    // them through the queued async publication and they would read stale state.
    setPlatformForTests("linux");
  });

  afterEach(() => {
    setPlatformForTests(null);
    setResponseStateByteCapForTests(null);
    setResponseStateSnapshotByteCapForTests(null);
    clearResponseStateForTests();
    removeTreeWithRetry(home);
    if (priorHome === undefined) delete process.env["OPENCODEX_HOME"];
    else process.env["OPENCODEX_HOME"] = priorHome;
  });

  test("a malformed spill stub leaves later rows replayable and durable writes available", async () => {
    const createdAt = Date.now();
    writeFileSync(join(home, "responses-state.json"), JSON.stringify({ version: 2, states: [
      ["resp_bad_stub", { kind: "spill", createdAt, spill: {
        version: 1, fileName: "invalid.spill.json", digest: { toString: null }, payloadBytes: 0,
      } }],
      ["resp_saved_row", { createdAt, items: [{ type: "message", role: "user", content: "saved row" }] }],
    ] }));
    const replay = (id: string) => JSON.stringify(expandPreviousResponseInput({ previous_response_id: id, input: "next" }));
    const savedReplay = replay("resp_saved_row");
    expect(responseStateMetrics().spillStubCount).toBe(0);

    rememberLarge("resp_new_row", "new durable row");
    await flushResponseState();
    clearResponseStateMemoryForTests();

    expect({ savedReplay, reloaded: replay("resp_saved_row"), written: replay("resp_new_row") }).toEqual({
      savedReplay: expect.stringContaining("saved row"),
      reloaded: expect.stringContaining("saved row"),
      written: expect.stringContaining("new durable row"),
    });
  });

  test("a restart keeps spilled continuations replayable when residents fill the snapshot budget", async () => {
    setResponseStateSnapshotByteCapForTests(8_192);
    // Demote two older entries to durable spill; demotion is oldest-first, so
    // these sit at the tail of the newest-first snapshot selection.
    setResponseStateByteCapForTests(1_024);
    rememberLarge("resp_spill_oldest", "a".repeat(2_048));
    rememberLarge("resp_spill_second", "b".repeat(2_048));
    expect(responseStateMetrics().spillStubCount).toBe(2);
    const spillDir = responseSpillDirectory();
    const stubFileNames = readdirSync(spillDir).filter(name => name.endsWith(".spill.json"));
    expect(stubFileNames).toBeArrayOfSize(2);

    // Newer resident payloads together exceed the snapshot budget; each is still
    // under the 2 MiB per-entry cap that would exclude it individually.
    setResponseStateByteCapForTests(null);
    rememberLarge("resp_resident_older", "r".repeat(2_600));
    rememberLarge("resp_resident_newest", "s".repeat(2_600));
    expect(responseStateMetrics().residentCount).toBe(2);
    await flushResponseState();

    // The stubs are the only durable references the spill files have: the
    // snapshot must still name them even when the budget cannot hold the
    // newest residents as well.
    const snapshotText = readFileSync(join(home, "responses-state.json"), "utf8");
    for (const fileName of stubFileNames) {
      expect(snapshotText).toContain(fileName);
    }

    clearResponseStateMemoryForTests();
    for (const [id, payload] of [["resp_spill_oldest", "aaaa"], ["resp_spill_second", "bbbb"]] as const) {
      const replay = JSON.stringify(expandPreviousResponseInput({
        previous_response_id: id,
        input: "next",
      }));
      expect(replay).toContain(payload);
    }
    // The stubs survive the reload, and their files remain on disk for replay.
    expect(responseStateMetrics().spillStubCount).toBe(2);
    for (const fileName of stubFileNames) {
      expect(existsSync(join(spillDir, fileName))).toBe(true);
    }
    // The newest resident still wins the remaining budget.
    const newestReplay = JSON.stringify(expandPreviousResponseInput({
      previous_response_id: "resp_resident_newest",
      input: "next",
    }));
    expect(newestReplay).toContain("ssss");
  });
});
