import { describe, expect, test } from "bun:test";
import { readUpdateBadge, type UpdateBadgeDeps } from "../../src/update/badge";
import type { Channel } from "../../src/update/index";
import type { VersionCache } from "../../src/update/notify";

function deps(overrides: {
  current?: string;
  installer?: "npm" | "bun" | "source";
  cache?: VersionCache | null;
  now?: number;
}): UpdateBadgeDeps {
  return {
    currentVersion: () => overrides.current ?? "2.7.43",
    detectInstall: () => (overrides.installer ?? "npm") as ReturnType<UpdateBadgeDeps["detectInstall"]>,
    readCache: () => overrides.cache ?? null,
    ...(overrides.now === undefined ? {} : { now: () => overrides.now! }),
  };
}

function cache(latest: string, tag: Channel = "latest"): VersionCache {
  return { latest_version: latest, last_checked_at: new Date().toISOString(), tag };
}

describe("readUpdateBadge", () => {
  test("a newer cached version marks the badge available", () => {
    const badge = readUpdateBadge(deps({ current: "2.7.43", cache: cache("2.7.44") }));
    expect(badge.updateAvailable).toBe(true);
    expect(badge.latestVersion).toBe("2.7.44");
    expect(badge.canUpdate).toBe(true);
  });

  test("the same or an older cached version does not", () => {
    expect(readUpdateBadge(deps({ current: "2.7.43", cache: cache("2.7.43") })).updateAvailable).toBe(false);
    expect(readUpdateBadge(deps({ current: "2.7.43", cache: cache("2.7.42") })).updateAvailable).toBe(false);
  });

  test("a source checkout reports no update and no one-click path", () => {
    const badge = readUpdateBadge(deps({ installer: "source", cache: cache("9.9.9") }));
    expect(badge.updateAvailable).toBe(false);
    expect(badge.canUpdate).toBe(false);
  });

  test("a source build version is treated the same way", () => {
    const badge = readUpdateBadge(deps({ current: "0.0.0", cache: cache("2.7.44") }));
    expect(badge.updateAvailable).toBe(false);
  });

  test("a cold cache reports unknown rather than a confident 'no update'", () => {
    const badge = readUpdateBadge(deps({ cache: null }));
    expect(badge.updateAvailable).toBe(false);
    expect(badge.latestVersion).toBeNull();
    expect(badge.unknown).toBe(true);
  });

  test("a cached answer is not unknown", () => {
    expect(readUpdateBadge(deps({ cache: cache("2.7.44") })).unknown).toBe(false);
    expect(readUpdateBadge(deps({ installer: "source" })).unknown).toBe(false);
  });

  test("reading the badge never spawns a registry refresh", () => {
    // The GUI polls this endpoint. A refresh-on-read would let repeated polls launch
    // repeated manager `view` helpers with no coalescing, so the deps surface has no
    // refresh hook at all — this test pins that shape.
    const keys = Object.keys(deps({}));
    expect(keys).toEqual(["currentVersion", "detectInstall", "readCache"]);
  });


  test("cache remains known just before 40 hours and becomes unknown at 40 hours", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    const recent = { ...cache("2.7.44"), last_checked_at: new Date(now - 40 * 60 * 60 * 1000 + 60_000).toISOString() };
    expect(readUpdateBadge(deps({ now, cache: recent })).unknown).toBe(false);
    const stale = { ...recent, last_checked_at: new Date(now - 40 * 60 * 60 * 1000).toISOString() };
    const badge = readUpdateBadge(deps({ now, cache: stale }));
    expect(badge.unknown).toBe(true);
    expect(badge.latestVersion).toBeNull();
    expect(badge.updateAvailable).toBe(false);
  });

  test("invalid and future cache timestamps are unknown", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    for (const last_checked_at of ["invalid", new Date(now + 1).toISOString()]) {
      expect(readUpdateBadge(deps({ now, cache: { ...cache("2.7.44"), last_checked_at } })).unknown).toBe(true);
    }
  });

  test("preview versions resolve on the preview channel", () => {
    const badge = readUpdateBadge(deps({
      current: "2.8.0-preview.1",
      cache: cache("2.8.0-preview.2", "preview"),
    }));
    expect(badge.channel).toBe("preview");
    expect(badge.updateAvailable).toBe(true);
  });
});
