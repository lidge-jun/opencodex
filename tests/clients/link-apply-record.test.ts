/**
 * OCX-6: the Child's apply record. Its `appliedAt` is the time a different Home settings document
 * was applied; an idempotent re-apply keeps it, a write failure is reported, and the apply lock
 * keeps two applies from interleaving.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HomeCodexSettingsDocument } from "../../src/link/codex-settings";
import {
  homeCodexSettingsPath,
  homeCodexSettingsReceipt,
  readHomeCodexSettingsRecord,
  recordHomeCodexSettings,
  withLinkApply,
  withdrawChangingHomeCodexSettingsRecord,
} from "../../src/client/link-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK_ID = `lnk_${"c".repeat(16)}`;
const OTHER_LINK = `lnk_${"d".repeat(16)}`;
const document = (fastMode: boolean, name = "home-box"): HomeCodexSettingsDocument => ({
  version: 1,
  home: { name, version: "2.91.0" },
  settings: { fastMode, multiAgentMode: "v1", webSearchSidecarEnabled: true, subagentDefaults: null },
});
const at = (iso: string) => () => new Date(iso);

let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-link-apply-record-"));
  process.env.OPENCODEX_HOME = root;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

describe("apply record", () => {
  test("the first apply stamps appliedAt; the same settings keep it; new settings restamp it", () => {
    const first = recordHomeCodexSettings(LINK_ID, { source: "home", document: document(true), fetchedAt: "2026-10-21T01:00:00.000Z" }, at("2026-10-21T01:00:01.000Z"));
    expect(first?.appliedAt).toBe("2026-10-21T01:00:01.000Z");

    // Same values from a renamed Home, read later: the apply time stays, the read time moves.
    const again = recordHomeCodexSettings(LINK_ID, { source: "home", document: document(true, "renamed"), fetchedAt: "2026-10-21T02:00:00.000Z" }, at("2026-10-21T02:00:01.000Z"));
    expect(again).toMatchObject({ appliedAt: "2026-10-21T01:00:01.000Z", fetchedAt: "2026-10-21T02:00:00.000Z" });
    expect(readHomeCodexSettingsRecord(LINK_ID)?.appliedAt).toBe("2026-10-21T01:00:01.000Z");

    const changed = recordHomeCodexSettings(LINK_ID, { source: "home", document: document(false), fetchedAt: "2026-10-21T03:00:00.000Z" }, at("2026-10-21T03:00:01.000Z"));
    expect(changed?.appliedAt).toBe("2026-10-21T03:00:01.000Z");
  });

  test("a cached or local source records nothing", () => {
    expect(recordHomeCodexSettings(LINK_ID, { source: "cached", document: document(true), fetchedAt: "2026-10-21T01:00:00.000Z", reason: "offline" })).toBeNull();
    expect(recordHomeCodexSettings(LINK_ID, { source: "local", reason: "old Home" })).toBeNull();
    expect(readHomeCodexSettingsRecord(LINK_ID)).toBeNull();
  });

  test("another link's record never lends its apply time", () => {
    const previous = homeCodexSettingsReceipt(OTHER_LINK, document(true), "2026-10-21T01:00:00.000Z", "2026-10-21T01:00:00.000Z", null);
    const receipt = homeCodexSettingsReceipt(LINK_ID, document(true), "2026-10-21T05:00:00.000Z", "2026-10-21T05:00:01.000Z", previous);
    expect(receipt.appliedAt).toBe("2026-10-21T05:00:01.000Z");
  });

  test("a record written before OCX-6 reads its fetch time as the apply time", () => {
    const path = homeCodexSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ linkId: LINK_ID, fetchedAt: "2026-10-01T00:00:00.000Z", document: document(true) }));
    expect(readHomeCodexSettingsRecord(LINK_ID)?.appliedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a record that cannot be written is an error, not a silent success", () => {
    // A directory where the record file belongs makes the atomic rename fail.
    mkdirSync(join(homeCodexSettingsPath(), "blocked"), { recursive: true });
    expect(() => recordHomeCodexSettings(LINK_ID, { source: "home", document: document(true), fetchedAt: "2026-10-21T01:00:00.000Z" })).toThrow();
    expect(readHomeCodexSettingsRecord(LINK_ID)).toBeNull();
  });
});

describe("apply lock", () => {
  test("a second apply while one is in flight fails fast and changes nothing", async () => {
    const lockPath = join(root, "link", "apply-lock.sqlite");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const first = withLinkApply(async () => { entered(); await held; return "first"; }, lockPath);
    await inside;
    let ran = false;
    await expect(withLinkApply(async () => { ran = true; return "second"; }, lockPath))
      .rejects.toThrow("another Home settings apply is in progress");
    expect(ran).toBe(false);
    release();
    expect(await first).toBe("first");
    expect(await withLinkApply(async () => "third", lockPath)).toBe("third");
  });

  test("a busy lock inside the apply is reported as itself, not as another apply", async () => {
    const lockPath = join(root, "link", "apply-lock.sqlite");
    const inner = Object.assign(new Error("client_lifecycle_busy"), { code: "client_lifecycle_busy" });
    await expect(withLinkApply(async () => { throw inner; }, lockPath)).rejects.toBe(inner);
  });
});

describe("withdrawing a record that is about to change", () => {
  test("different settings withdraw the record first; the same settings keep it", () => {
    recordHomeCodexSettings(LINK_ID, { source: "home", document: document(true), fetchedAt: "2026-10-21T01:00:00.000Z" }, at("2026-10-21T01:00:01.000Z"));
    expect(withdrawChangingHomeCodexSettingsRecord(LINK_ID, document(true, "renamed"))).toBe(false);
    expect(readHomeCodexSettingsRecord(LINK_ID)?.appliedAt).toBe("2026-10-21T01:00:01.000Z");
    expect(withdrawChangingHomeCodexSettingsRecord(LINK_ID, document(false))).toBe(true);
    // A failed injection or record write now reports no applied digest, never the old one.
    expect(readHomeCodexSettingsRecord(LINK_ID)).toBeNull();
  });
});
