import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../src/config";
import {
  clearResponseStateForTests, clearResponseStateMemoryForTests, expandPreviousResponseInput,
  rememberResponseState, previousResponseReplayFailure, runPendingResponseStatePersistForTests,
  setResponseStateByteCapForTests, flushResponseState, responseStateMetrics,
} from "../../src/responses/state";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ownerA = "a".repeat(64), ownerB = "b".repeat(64);
let release: () => void;
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-replay-storage-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearResponseStateForTests();
});
afterEach(() => {
  setResponseStateByteCapForTests(null);
  release();
  try { clearResponseStateForTests(); } finally {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  }
});
function remember(key: string | null | undefined, text = "private synthetic task"): void {
  rememberResponseState({ input: [] }, { id: "resp-collision", output: [{ type: "message", role: "assistant", content: text }] }, undefined,
    { clientThreadId: "own-thread", replayOwnerKey: key });
}
function replay(key: string | null | undefined): Record<string, unknown> {
  return expandPreviousResponseInput({ previous_response_id: "resp-collision", input: [] }, "own-thread", key) as Record<string, unknown>;
}
for (const spill of [false, true]) {
  test(`owner binding survives ${spill ? "spill and snapshot" : "resident snapshot"} reload`, async () => {
    if (spill) setResponseStateByteCapForTests(512);
    remember(ownerA, "private synthetic task".repeat(spill ? 200 : 1));
    await flushResponseState();
    await runPendingResponseStatePersistForTests();
    const snapshot = JSON.parse(readFileSync(join(getConfigDir(), "responses-state.json"), "utf8"));
    expect(snapshot.states[0][1].replayOwnerKey).toBe(ownerA);
    if (spill) expect(snapshot.states[0][1].kind).toBe("spill");
    clearResponseStateMemoryForTests();
    const before = responseStateMetrics();
    expect(previousResponseReplayFailure(replay(ownerB))?.reason).toBe("scope_mismatch");
    expect(responseStateMetrics().spillReadFailures).toBe(before.spillReadFailures);
    expect(JSON.stringify(replay(ownerA).input)).toContain("private synthetic task");
  });
}
test("a response id cannot be overwritten by another owner", () => {
  remember(ownerA);
  remember(ownerB, "foreign replacement");
  expect(previousResponseReplayFailure(replay(ownerB))?.reason).toBe("scope_mismatch");
  expect(JSON.stringify(replay(ownerA).input)).toContain("private synthetic task");
  expect(JSON.stringify(replay(ownerA).input)).not.toContain("foreign replacement");
});
test("bound requests reject legacy entries and missing owner never authorizes replay", () => {
  remember(undefined);
  expect(previousResponseReplayFailure(replay(ownerA))?.reason).toBe("scope_mismatch");
  expect(previousResponseReplayFailure(replay(null))?.reason).toBe("scope_mismatch");
});
test("legacy API cannot read bound entries", () => {
  remember(ownerA);
  expect(previousResponseReplayFailure(replay(undefined))?.reason).toBe("scope_mismatch");
});
test("malformed snapshot binding cannot become legacy authority", async () => {
  remember(ownerA);
  await runPendingResponseStatePersistForTests();
  const path = join(getConfigDir(), "responses-state.json");
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  snapshot.states[0][1].replayOwnerKey = "malformed";
  writeFileSync(path, JSON.stringify(snapshot));
  clearResponseStateMemoryForTests();
  expect(replay(ownerA).input).toEqual([]);
  expect(previousResponseReplayFailure(replay(ownerA))).toBeDefined();
});
test("foreign replay is refused before reading a corrupt spill", async () => {
  setResponseStateByteCapForTests(512);
  remember(ownerA, "synthetic spill payload".repeat(200));
  await flushResponseState();
  await runPendingResponseStatePersistForTests();
  const snapshot = JSON.parse(readFileSync(join(getConfigDir(), "responses-state.json"), "utf8"));
  const stub = snapshot.states[0][1];
  expect(stub.kind).toBe("spill");
  writeFileSync(join(getConfigDir(), "responses-state-spill", stub.spill.fileName), "corrupt");
  clearResponseStateMemoryForTests();
  expect(previousResponseReplayFailure(replay(ownerB))?.reason).toBe("scope_mismatch");
  expect(responseStateMetrics().spillReadFailures).toBe(0);
  expect(previousResponseReplayFailure(replay(ownerA))?.reason).toBe("spill_corrupt");
  expect(responseStateMetrics().spillReadFailures).toBe(1);
});
