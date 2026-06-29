import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getUpgradeVersionForPopup,
  isNewer,
  isSourceBuildVersion,
  readVersionCache,
  writeVersionCache,
  type VersionCache,
} from "../src/update-notify";

const prevHome = process.env.OPENCODEX_HOME;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ocx-version-"));
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("isNewer — latest channel", () => {
  test("higher patch/minor/major is newer", () => {
    expect(isNewer("2.7.0", "2.6.4", "latest")).toBe(true);
    expect(isNewer("2.6.5", "2.6.4", "latest")).toBe(true);
    expect(isNewer("3.0.0", "2.9.9", "latest")).toBe(true);
  });
  test("equal or older is not newer", () => {
    expect(isNewer("2.6.4", "2.6.4", "latest")).toBe(false);
    expect(isNewer("2.6.3", "2.6.4", "latest")).toBe(false);
  });
  test("prereleases are ignored on the stable channel", () => {
    expect(isNewer("2.7.0-preview.1", "2.6.4", "latest")).toBe(false);
  });
});

describe("isNewer — preview channel", () => {
  test("higher preview number on the same base is newer", () => {
    expect(isNewer("2.7.0-preview.5", "2.7.0-preview.3", "preview")).toBe(true);
  });
  test("equal preview is not newer", () => {
    expect(isNewer("2.7.0-preview.3", "2.7.0-preview.3", "preview")).toBe(false);
  });
  test("stable with a strictly higher base is newer than a preview (O3)", () => {
    expect(isNewer("2.8.0", "2.7.0-preview.3", "preview")).toBe(true);
  });
  test("stable with the same base as the preview is NOT newer (O3)", () => {
    expect(isNewer("2.7.0", "2.7.0-preview.5", "preview")).toBe(false);
  });
  test("higher base preview beats lower base preview", () => {
    expect(isNewer("2.8.0-preview.1", "2.7.0-preview.9", "preview")).toBe(true);
  });
});

describe("isSourceBuildVersion", () => {
  test("only 0.0.0 is a source build", () => {
    expect(isSourceBuildVersion("0.0.0")).toBe(true);
    expect(isSourceBuildVersion("2.6.4")).toBe(false);
  });
});

describe("version cache I/O", () => {
  const base: VersionCache = {
    latest_version: "2.7.0",
    last_checked_at: new Date().toISOString(),
    tag: "latest",
  };

  test("round-trips through the config dir", () => {
    writeVersionCache(base);
    expect(readVersionCache("latest")).toMatchObject({ latest_version: "2.7.0", tag: "latest" });
  });

  test("returns null when the cached channel differs (stale-channel invalidation)", () => {
    writeVersionCache(base);
    expect(readVersionCache("preview")).toBeNull();
  });

  test("missing cache reads as null", () => {
    expect(readVersionCache("latest")).toBeNull();
  });
});

describe("getUpgradeVersionForPopup", () => {
  const cache: VersionCache = {
    latest_version: "2.7.0",
    last_checked_at: new Date().toISOString(),
    tag: "latest",
  };

  test("surfaces a newer version", () => {
    expect(getUpgradeVersionForPopup(cache, "2.6.4", "latest")).toBe("2.7.0");
  });
  test("no popup when not newer", () => {
    expect(getUpgradeVersionForPopup(cache, "2.7.0", "latest")).toBeNull();
  });
  test("dismissed version is suppressed", () => {
    expect(getUpgradeVersionForPopup({ ...cache, dismissed_version: "2.7.0" }, "2.6.4", "latest")).toBeNull();
  });
  test("a strictly newer release re-surfaces after a dismissal", () => {
    const dismissed: VersionCache = { ...cache, latest_version: "2.7.1", dismissed_version: "2.7.0" };
    expect(getUpgradeVersionForPopup(dismissed, "2.6.4", "latest")).toBe("2.7.1");
  });
  test("null cache means no popup", () => {
    expect(getUpgradeVersionForPopup(null, "2.6.4", "latest")).toBeNull();
  });
});

describe("cli wiring", () => {
  const root = new URL("../", import.meta.url);
  const readText = (p: string) => Bun.file(new URL(p, root)).text();

  test("update prompt runs before the server binds a port", async () => {
    const cli = await readText("src/cli.ts");
    const promptIndex = cli.indexOf("await maybeShowUpdatePrompt()");
    const portIndex = cli.indexOf("const port = await chooseListenPort");
    const serverIndex = cli.indexOf("startServer(port)");
    expect(promptIndex).toBeGreaterThan(-1);
    expect(portIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(portIndex);
    expect(promptIndex).toBeLessThan(serverIndex);
  });

  test("hidden __refresh-version subcommand is wired", async () => {
    const cli = await readText("src/cli.ts");
    expect(cli).toContain("case \"__refresh-version\"");
    expect(cli).toContain("refreshVersionCache");
  });
});
