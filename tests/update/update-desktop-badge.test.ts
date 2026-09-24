import { describe, expect, test } from "bun:test";
import {
  DESKTOP_SNAPSHOT_MAX_SESSIONS,
  DESKTOP_SNAPSHOT_TTL_MS,
  DesktopBadgeStore,
  parseDesktopSnapshot,
} from "../../src/update/desktop-badge";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALL_MS = 1_700_000_000_000;
const snapshot = (sessionId: string) => ({
  sessionId, currentVersion: "2.61.0", latestVersion: "2.62.0",
  available: true, checkedAtMs: WALL_MS, phase: "available",
});

describe("desktop badge snapshot store", () => {
  test("rejects extra fields, malformed values and forged availability", () => {
    expect(parseDesktopSnapshot({ ...snapshot(A), token: "unwanted" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), sessionId: "short" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), currentVersion: "x".repeat(65) }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), latestVersion: null }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "installed" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), checkedAtMs: WALL_MS + 60_001 }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), checkedAtMs: 946_684_799_999 }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "current" }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot({ ...snapshot(A), phase: "installing", available: false, latestVersion: null }, WALL_MS)).toBeNull();
    expect(parseDesktopSnapshot(snapshot(A), WALL_MS)).not.toBeNull();
  });

  test("an absent session is unknown desktop state, never package state", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.read(A)).toMatchObject({
      installer: "desktop", unknown: true, updateAvailable: false,
      latestVersion: null, currentVersion: "?",
    });
    expect(store.read(null).unknown).toBe(true);
  });

  test("two desktop sessions do not see one another", () => {
    let now = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS, () => now);
    expect(store.put(snapshot(A))).toBe(true);
    expect(store.read(A).updateAvailable).toBe(true);
    expect(store.read(B).unknown).toBe(true);
    now += 1_000;
    expect(store.put({
      ...snapshot(B), latestVersion: null, available: false,
      phase: "current", checkedAtMs: WALL_MS,
    })).toBe(true);
    expect(store.read(A).updateAvailable).toBe(true);
    expect(store.read(B)).toMatchObject({
      installer: "desktop", updateAvailable: false, unknown: false,
    });
  });

  test("a failed check is unknown without pending state but retains a known update", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.put({
      ...snapshot(A), latestVersion: null, available: false,
      checkedAtMs: null, phase: "error",
    })).toBe(true);
    expect(store.read(A)).toMatchObject({ unknown: true, updateAvailable: false });
    expect(store.put({ ...snapshot(A), phase: "error" })).toBe(true);
    expect(store.read(A)).toMatchObject({ unknown: false, updateAvailable: true });
  });

  test("a heartbeat extends receipt expiry and stale state disappears", () => {
    let now = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS, () => now);
    expect(store.put(snapshot(A))).toBe(true);
    now += 60_000;
    expect(store.put(snapshot(A))).toBe(true);
    now += DESKTOP_SNAPSHOT_TTL_MS - 1;
    expect(store.read(A).updateAvailable).toBe(true);
    now += 1;
    expect(store.read(A).unknown).toBe(true);
  });

  test("a 25-hour-old check remains visible while heartbeats renew receipt", () => {
    let received = 1_000;
    const store = new DesktopBadgeStore(() => WALL_MS + 25 * 60 * 60_000, () => received);
    expect(store.put(snapshot(A))).toBe(true);
    received += 60_000;
    expect(store.put({ ...snapshot(A), phase: "error" })).toBe(true);
    expect(store.read(A)).toMatchObject({ updateAvailable: true, unknown: false });
    received += DESKTOP_SNAPSHOT_TTL_MS - 1;
    expect(store.read(A).updateAvailable).toBe(true);
    received += 1;
    expect(store.read(A)).toMatchObject({ updateAvailable: false, unknown: true });
  });

  test("new sessions evict the oldest after the fixed entry limit", () => {
    const store = new DesktopBadgeStore(() => WALL_MS, () => 1_000);
    expect(store.put(snapshot(A))).toBe(true);
    for (let index = 0; index < DESKTOP_SNAPSHOT_MAX_SESSIONS; index++) {
      const id = "00000000-0000-4000-8000-" + index.toString(16).padStart(12, "0");
      expect(store.put(snapshot(id))).toBe(true);
    }
    expect(store.read(A).unknown).toBe(true);
    expect(store.read("00000000-0000-4000-8000-00000000001f").updateAvailable).toBe(true);
  });
});
