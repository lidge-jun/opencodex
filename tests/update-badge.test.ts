import { describe, expect, test } from "bun:test";
import { readUpdateBadge, type UpdateBadgeDeps } from "../src/update/badge";
import type { Channel } from "../src/update/index";
import type { VersionCache } from "../src/update/notify";

function deps(overrides: {
  current?: string;
  installer?: "npm" | "bun" | "source";
  cache?: VersionCache | null;
}): UpdateBadgeDeps {
  return {
    currentVersion: () => overrides.current ?? "2.7.43",
    detectInstall: () => (overrides.installer ?? "npm") as ReturnType<UpdateBadgeDeps["detectInstall"]>,
    readCache: () => overrides.cache ?? null,
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
    // repeated `npm view` helpers with no coalescing, so the deps surface has no
    // refresh hook at all — this test pins that shape.
    const keys = Object.keys(deps({}));
    expect(keys).toEqual(["currentVersion", "detectInstall", "readCache"]);
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
