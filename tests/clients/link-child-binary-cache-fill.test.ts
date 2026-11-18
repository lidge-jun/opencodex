import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_TARGET_TRIPLES, childArtifactFilename, resolveChildBinarySource } from "../../src/link/child-binary-source";
import {
  CHILD_CACHE_ARTIFACT_FILES, CHILD_RELEASE_DIGESTS_PATH, childBinaryCacheDir, childReleaseAssetUrl, compareReleaseVersions,
  fillChildBinaryCacheForVersion, fillChildBinaryCacheOnStart,
} from "../../src/link/child-binary-cache-fill.mjs";
import { compareStrictSemver, parseStrictSemver } from "../../src/lib/strict-semver";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { startChildBinaryCacheFill } from "../../src/link/child-binary-cache-start";
import { CONFIG_UNINSTALL_MANIFEST, recordOwnedConfigPath, removeOwnedConfigState } from "../../src/lib/config-ownership";
import * as ownershipModule from "../../src/lib/config-ownership";
import * as pathsModule from "../../src/config/paths";
import * as fsModule from "node:fs";

// Lane O2: an updated Home of version V fills ocx-child-builds/V/ from the GitHub release of V, trusting
// only the digests inside its own installed package, so a packaged Home can plant ocx-child after an update.

// A Windows Home never fills: fillChildBinaryCacheForVersion answers unsupported_platform right after the version check, before it
// reads the digest file or touches the Home, because the fill proves its directories private by POSIX owner ids and mode bits, and
// those checks read process.platform. A test that needs the fill to run is skipped on Windows; passing platform "linux" there would
// run the fill with its POSIX checks switched off, a combination no Home runs. The gates that answer before the platform check, the
// reader parity and the Windows answer itself run on every platform.
const fillRuns = process.platform !== "win32";


const VERSION = "2.100.0";
const linuxBuild = new TextEncoder().encode("linux build bytes");
const macBuild = new TextEncoder().encode("mac build bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let root: string, packageRoot: string, home: string, empty: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-child-cache-fill-"));
  // Laid out as an npm global install: a source checkout never fills (see "startup").
  packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
  home = join(root, "opencodex-home");
  empty = join(root, "empty");
  for (const dir of [packageRoot, home, empty]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: VERSION }));
});
afterEach(() => removeTreeWithRetry(root));

function shipDigests(lines: string, into = packageRoot): void {
  mkdirSync(join(into, "native", "ocx-child"), { recursive: true });
  writeFileSync(join(into, CHILD_RELEASE_DIGESTS_PATH), lines);
}
const bothDigests = () => shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");
const versionsDir = () => join(home, "ocx-child-builds", ".versions");
/** The evidence of an upgrade: this Home last completed a fill as `version` (or ran it, "<version> baseline"). */
function ranBefore(version = "2.99.0"): void {
  mkdirSync(versionsDir(), { recursive: true, mode: 0o700 });
  const [v, kind] = version.split(" ");
  writeFileSync(join(versionsDir(), v + "." + (kind ?? "filled")), "", { mode: 0o600 });
}
/** The newest recorded version, "<version>" when its fill completed, "<version> baseline" otherwise. */
function recorded(): string {
  const markers = readdirSync(versionsDir()).map(name => /^(.+)\.(baseline|filled)$/.exec(name)!).filter(Boolean);
  const newest = markers.map(m => m[1]!).reduce((a, b) => (compareReleaseVersions(a, b) === 1 ? a : b));
  return markers.some(m => m[1] === newest && m[2] === "filled") ? newest : newest + " baseline";
}

function release(assets: Record<string, Uint8Array | number>, during?: () => void) {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    during?.();
    const name = decodeURIComponent(url.split("/").at(-1)!);
    const asset = url.startsWith("https://github.com/lidge-jun/opencodex/releases/download/v" + VERSION + "/") ? assets[name] : undefined;
    if (asset === undefined) return new Response("not found", { status: 404 });
    if (typeof asset === "number") return new Response("", { status: asset });
    return new Response(asset, { status: 200, headers: { "content-length": String(asset.byteLength) } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const fill = (fetchImpl: typeof fetch, version = VERSION) => fillChildBinaryCacheForVersion({ packageRoot, version, opencodexHome: home, fetchImpl });
const cacheDir = () => childBinaryCacheDir(home, VERSION);
const resolve = (triple: "linux-x64" | "darwin-arm64") => resolveChildBinarySource(triple, {
  env: {}, opencodexHome: home, version: VERSION, repoRoot: empty, execPath: join(empty, "ocx"), allowLocalRelease: false,
});

describe("filling the ocx-child cache for the running version", () => {
  test.skipIf(!fillRuns)("after an update, probe answers plantable for every build the package digests vouch for", async () => {
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
    bothDigests();
    ranBefore();
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], fetched: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], failed: [] });
    expect(requested.sort()).toEqual([childReleaseAssetUrl(VERSION, "ocx-child-darwin-arm64"), childReleaseAssetUrl(VERSION, "ocx-child-linux-x64")].sort());
    const linux = resolve("linux-x64");
    expect(linux.ok && linux.artifact.source).toBe("cache");
    expect(linux.ok && linux.artifact.sha256).toBe(sha(linuxBuild));
    expect(resolve("darwin-arm64").ok).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(cacheDir()).mode & 0o777).toBe(0o700);
      expect(statSync(join(cacheDir(), "ocx-child-linux-x64")).mode & 0o777).toBe(0o600);
    }
    // The completed fill is recorded, so the next start of this version fetches nothing.
    expect(recorded()).toBe(VERSION);
    const again = release({});
    expect(await fill(again.fetchImpl)).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    expect(again.requested).toEqual([]);
    expect(readdirSync(cacheDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test.skipIf(!fillRuns)("a build whose bytes do not match the package digest is never cached, and the next start retries", async () => {
    bothDigests();
    ranBefore();
    const { fetchImpl } = release({ "ocx-child-linux-x64": new TextEncoder().encode("tampered"), "ocx-child-darwin-arm64": 404 });
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"] });
    expect(existsSync(join(cacheDir(), "ocx-child-linux-x64"))).toBe(false);
    expect(existsSync(join(cacheDir(), "SHA256SUMS"))).toBe(false);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
    expect(recorded()).toBe("2.99.0");
    expect(await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl)).toMatchObject({ kind: "filled", failed: [] });
    expect(resolve("linux-x64").ok).toBe(true);
    expect(recorded()).toBe(VERSION);
  });

  test.skipIf(!fillRuns)("one good build is cached and listed alone when another fails", async () => {
    bothDigests();
    ranBefore();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 500 });
    await fill(fetchImpl);
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(resolve("linux-x64").ok).toBe(true);
    expect(resolve("darwin-arm64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test.skipIf(!fillRuns)("a build the package no longer vouches for loses its manifest line when its refetch fails, and the fill deletes no build file", async () => {
    ranBefore();
    const oldBuild = new TextEncoder().encode("earlier build");
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), oldBuild, { mode: 0o600 });
    // A line for a target the release does not list is left as it is: the fill manages only the builds its digests name.
    const unlistedBuild = new TextEncoder().encode("unlisted target build");
    writeFileSync(join(cacheDir(), "ocx-child-windows-x64.exe"), unlistedBuild, { mode: 0o600 });
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(oldBuild) + "  ocx-child-linux-x64\n" + sha(unlistedBuild) + "  ocx-child-windows-x64.exe\n", { mode: 0o600 });
    expect(resolve("linux-x64").ok).toBe(true);
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(await fill(release({ "ocx-child-linux-x64": 503 }).fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
    expect(readFileSync(join(cacheDir(), "ocx-child-linux-x64"))).toEqual(Buffer.from(oldBuild));
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(unlistedBuild) + "  ocx-child-windows-x64.exe\n");
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  test.skipIf(!fillRuns)("a stale manifest is removed when no listed build is left", async () => {
    ranBefore();
    const oldBuild = new TextEncoder().encode("older build");
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), oldBuild, { mode: 0o600 });
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(oldBuild) + "  ocx-child-linux-x64\n", { mode: 0o600 });
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    await fill(release({}).fetchImpl);
    expect(readdirSync(cacheDir())).toEqual(["ocx-child-linux-x64"]);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  test.skipIf(!fillRuns)("a downgraded Home fetches nothing: a newer version's cache exists", async () => {
    bothDigests();
    mkdirSync(join(home, "ocx-child-builds", "2.101.0"), { recursive: true });
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "downgrade" });
    expect(requested).toEqual([]);
    expect(existsSync(cacheDir())).toBe(false);
  });

  test.skipIf(!fillRuns).each([
    ["a fresh install (no record) records its version as a baseline", null, "first_start", VERSION + " baseline"],
    ["a restart of the same version after a first start", VERSION + " baseline", "not_an_upgrade", VERSION + " baseline"],
    ["a downgrade from a version that never made a cache directory", "2.101.0", "downgrade", "2.101.0"],
  ])("without evidence of an upgrade nothing is fetched: %s", async (_name, before, reason, after) => {
    bothDigests();
    if (before !== null) ranBefore(before);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason } as never);
    expect(requested).toEqual([]);
    expect(existsSync(cacheDir())).toBe(false);
    expect(recorded()).toBe(after);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("an unparsable version fetches nothing", async () => {
    bothDigests();
    const { fetchImpl, requested } = release({});
    expect(await fill(fetchImpl, "../2.100.0")).toEqual({ kind: "skipped", reason: "invalid_version" });
    expect(requested).toEqual([]);
  });

  test.skipIf(!fillRuns)("a package without the digest file fetches nothing and only records its version", async () => {
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(requested).toEqual([]);
    expect(readdirSync(join(home, "ocx-child-builds"))).toEqual([".versions"]);
    expect(recorded()).toBe(VERSION + " baseline");
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test.skipIf(!fillRuns)("a completed fill whose manifest lost lines (overlapping fills) is repaired from the verified files, without downloading", async () => {
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(linuxBuild) + "  ocx-child-linux-x64\n", { mode: 0o600 });
    expect(resolve("darwin-arm64").ok).toBe(false);
    const again = release({});
    expect(await fill(again.fetchImpl)).toEqual({ kind: "filled", cached: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], fetched: [], failed: [] });
    expect([again.requested, resolve("darwin-arm64").ok, recorded()]).toEqual([[], true, VERSION]);
  });

  test.skipIf(!fillRuns)("a same-version start never downloads: a lost manifest only re-lists the builds still verified on disk", async () => {
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    rmSync(join(cacheDir(), "SHA256SUMS"));
    rmSync(join(cacheDir(), "ocx-child-darwin-arm64"));
    const again = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    // Nothing was attempted, so nothing is reported as failed (and startup warns about nothing).
    expect(await fill(again.fetchImpl)).toEqual({ kind: "filled", cached: ["ocx-child-linux-x64"], fetched: [], failed: [] });
    expect([again.requested, resolve("linux-x64").ok, resolve("darwin-arm64").ok, recorded()]).toEqual([[], true, false, VERSION]);
  });

  test.skipIf(!fillRuns)("an older fill that finishes after a newer version was recorded never lowers the record", async () => {
    bothDigests();
    ranBefore();
    // While this 2.100.0 fill downloads, a 2.101.0 Home records its completed fill.
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }, () => ranBefore("2.101.0"));
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", failed: [] });
    expect(recorded()).toBe("2.101.0");
    expect(readdirSync(versionsDir()).sort()).toEqual(["2.100.0.filled", "2.101.0.filled", "2.99.0.filled"]);
    // A start of the newer version is a restart, not an upgrade: it downloads nothing.
    const restart = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(restart.fetchImpl, "2.101.0")).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    expect(restart.requested).toEqual([]);
  });

  test.skipIf(!fillRuns)("a completed fill whose manifest still covers the package fetches nothing, even with a build deleted", async () => {
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    rmSync(join(cacheDir(), "ocx-child-darwin-arm64"));
    const again = release({ "ocx-child-darwin-arm64": macBuild });
    expect(await fill(again.fetchImpl)).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    expect(again.requested).toEqual([]);
  });

  test.skipIf(!fillRuns)("the manifest is rebuilt from the disk when written: a build another fill placed meanwhile stays listed", async () => {
    bothDigests();
    ranBefore();
    // This fill's darwin download fails, but an overlapping fill publishes the verified build meanwhile.
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 503 }, () => {
      if (existsSync(cacheDir())) writeFileSync(join(cacheDir(), "ocx-child-darwin-arm64"), macBuild, { mode: 0o600 });
    });
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], fetched: ["ocx-child-linux-x64"], failed: [] });
    expect([resolve("darwin-arm64").ok, resolve("linux-x64").ok, recorded()]).toEqual([true, true, VERSION]);
  });

  test.skipIf(!fillRuns).each([
    ["names no ocx-child build", sha(linuxBuild) + "  ocx-linux-x64\n"],
    ["has a malformed digest", "abc  ocx-child-linux-x64\n"],
    ["is empty", ""],
  ])("a digest file that %s writes nothing and keeps the record, so a repaired file still fills", async (_name, digests) => {
    ranBefore();
    shipDigests(digests);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "invalid_digests" });
    expect([requested, recorded(), readdirSync(join(home, "ocx-child-builds"))]).toEqual([[], "2.99.0", [".versions"]]);
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", fetched: ["ocx-child-linux-x64"], failed: [] });
    expect(recorded()).toBe(VERSION);
  });

  test.skipIf(!fillRuns || process.getuid?.() === 0)("an unreadable digest file is not an absent one", async () => {
    ranBefore();
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    chmodSync(join(packageRoot, CHILD_RELEASE_DIGESTS_PATH), 0o000);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "invalid_digests" });
    expect([requested, recorded()]).toEqual([[], "2.99.0"]);
    chmodSync(join(packageRoot, CHILD_RELEASE_DIGESTS_PATH), 0o600);
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", failed: [] });
  });

  test.skipIf(!fillRuns)("the first release that ships digests fills: the release before it recorded the baseline", async () => {
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(fetchImpl, "2.99.0")).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(recorded()).toBe("2.99.0 baseline");
    bothDigests();
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", fetched: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], failed: [] });
    expect(requested).toHaveLength(2);
    expect(resolve("linux-x64").ok).toBe(true);
  });

  test.skipIf(!fillRuns)("a package without digests never lowers the record and never fails on an unsafe home", async () => {
    ranBefore("2.101.0");
    expect(await fill(release({}).fetchImpl)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(recorded()).toBe("2.101.0");
    if (process.platform !== "win32") {
      chmodSync(home, 0o777);
      expect(await fill(release({}).fetchImpl, "2.102.0")).toEqual({ kind: "skipped", reason: "no_digests" });
      expect(recorded()).toBe("2.101.0");
      chmodSync(home, 0o755);
    }
  });

  test("Windows fetches and writes nothing: no mode bits prove the cache private", async () => {
    bothDigests();
    ranBefore();
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fillChildBinaryCacheForVersion({ packageRoot, version: VERSION, opencodexHome: home, fetchImpl, platform: "win32" })).toEqual({ kind: "skipped", reason: "unsupported_platform" });
    expect([requested, existsSync(cacheDir()), recorded()]).toEqual([[], false, "2.99.0"]);
  });

  test.skipIf(!fillRuns)("an oversized download is refused", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const fetchImpl = (async () => new Response(linuxBuild, { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
  });
});

describe.skipIf(!fillRuns)("nobody else can substitute a build", () => {
  test.skipIf(!fillRuns)("a matching cached build the reader would refuse (writable by others) is fetched again", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), linuxBuild);
    chmodSync(join(cacheDir(), "ocx-child-linux-x64"), 0o666);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: ["ocx-child-linux-x64"], fetched: ["ocx-child-linux-x64"], failed: [] });
    expect(requested).toHaveLength(1);
    expect(statSync(join(cacheDir(), "ocx-child-linux-x64")).mode & 0o777).toBe(0o600);
    expect(resolve("linux-x64").ok).toBe(true);
  });

  test.each([
    ["the version directory", () => join(home, "ocx-child-builds", VERSION), true, 0o770],
    ["ocx-child-builds", () => join(home, "ocx-child-builds"), true, 0o777],
    ["the Home directory", () => home, false, 0o775],
    ["the version markers (ocx-child-builds/.versions)", () => versionsDir(), true, 0o777],
  ])("%s writable by others is refused before any download", async (_name, dir, record, mode) => {
    bothDigests();
    if (record) ranBefore();
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    chmodSync(dir(), mode);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    await expect(fill(fetchImpl)).rejects.toThrow("unsafe cache directory");
    expect(requested).toEqual([]);
    expect(existsSync(join(cacheDir(), "SHA256SUMS"))).toBe(false);
  });

  test.skipIf(!fillRuns)("a directory above the cache that others can write is refused; a sticky one (like /tmp) is not", async () => {
    bothDigests();
    ranBefore();
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    chmodSync(home, 0o775);
    await expect(fill(fetchImpl)).rejects.toThrow("unsafe cache directory");
    chmodSync(home, 0o755);
    chmodSync(root, 0o777);
    await expect(fill(fetchImpl)).rejects.toThrow("unsafe cache directory");
    expect(requested).toEqual([]);
    chmodSync(root, 0o1777);
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", failed: [] });
    chmodSync(root, 0o700);
  });
});

describe.skipIf(!fillRuns)("one fill at a time per OPENCODEX_HOME", () => {
  const lockPath = () => join(home, "ocx-child-builds", ".fill.lock");

  test.skipIf(!fillRuns)("an overlapping fill whose download would fail skips, and cannot undo the one that succeeds", async () => {
    bothDigests();
    ranBefore();
    let releaseDownload!: () => void;
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    let entered!: () => void;
    const inFetch = new Promise<void>(resolve => { entered = resolve; });
    const good = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => { entered(); await gate; return good.fetchImpl(input, init); }) as typeof fetch;
    const first = fill(slow);
    await inFetch;
    const failing = release({ "ocx-child-linux-x64": 503, "ocx-child-darwin-arm64": 503 });
    expect(await fill(failing.fetchImpl)).toEqual({ kind: "skipped", reason: "busy" });
    expect(failing.requested).toEqual([]);
    releaseDownload();
    expect(await first).toMatchObject({ kind: "filled", failed: [] });
    expect(recorded()).toBe(VERSION);
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(existsSync(lockPath())).toBe(false);
  });

  test.skipIf(!fillRuns)("a lock left by a process that is gone is reclaimed", async () => {
    bothDigests();
    ranBefore();
    writeFileSync(lockPath(), "99999999.deadbeef\n", { mode: 0o600 });
    expect(await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl)).toMatchObject({ kind: "filled", failed: [] });
    expect(existsSync(lockPath())).toBe(false);
  });

  test.skipIf(!fillRuns)("a live process's lock older than an hour is reclaimed; a fresh one is respected", async () => {
    bothDigests();
    ranBefore();
    writeFileSync(lockPath(), process.pid + ".feedface\n", { mode: 0o600 });
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "busy" });
    const later = () => Date.now() + 2 * 60 * 60 * 1000;
    expect(await fillChildBinaryCacheForVersion({ packageRoot, version: VERSION, opencodexHome: home, fetchImpl, now: later })).toMatchObject({ kind: "filled", failed: [] });
  });

  test.skipIf(!fillRuns)("a fill that lost its lock during a download publishes no manifest and no record", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild }, () => writeFileSync(lockPath(), "1.otherfill\n"));
    await expect(fill(fetchImpl)).rejects.toThrow("cache fill lock lost");
    expect([existsSync(join(cacheDir(), "SHA256SUMS")), recorded(), readFileSync(lockPath(), "utf8")]).toEqual([false, "2.99.0", "1.otherfill\n"]);
  });
});

describe.skipIf(!fillRuns)("the cache is never written through a symlink", () => {
  test.each([
    ["the version directory", () => join(home, "ocx-child-builds", VERSION), true],
    ["ocx-child-builds", () => join(home, "ocx-child-builds"), false],
  ])("%s as a symlink is refused before any write", async (_name, link, record) => {
    bothDigests();
    if (record) ranBefore();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(join(link(), ".."), { recursive: true });
    symlinkSync(elsewhere, link());
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    await expect(fill(fetchImpl)).rejects.toThrow("unsafe cache directory");
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test.skipIf(!fillRuns)("a version directory swapped for a symlink during a download receives nothing", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    let swapped = false;
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild }, () => {
      if (swapped) return;
      swapped = true;
      renameSync(cacheDir(), join(root, "moved-away"));
      symlinkSync(elsewhere, cacheDir());
    });
    await expect(fill(fetchImpl)).rejects.toThrow("cache directory changed");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(cacheDir()).isSymbolicLink()).toBe(true);
  });
});

describe("startup", () => {
  test.skipIf(!fillRuns)("reads the running package version, retries an incomplete fill, reports in one line, and never throws", async () => {
    bothDigests();
    ranBefore();
    const logs: string[] = [], warns: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { warns.push(line); } };
    await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl: release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 404 }).fetchImpl }, out);
    expect(logs).toEqual(["[link] cached 1 verified ocx-child build for v" + VERSION + "."]);
    expect(warns).toHaveLength(1);
    // The next start of the same version finishes the fill.
    logs.length = 0;
    await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl: release({ "ocx-child-darwin-arm64": macBuild }).fetchImpl }, out);
    expect(logs).toEqual(["[link] cached 1 verified ocx-child build for v" + VERSION + "."]);
    // After that a start fetches nothing and says nothing.
    logs.length = 0;
    const quiet = release({});
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl: quiet.fetchImpl }, out)).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    expect([logs, quiet.requested, warns.length]).toEqual([[], [], 1]);
    // A failure inside the fill is reported, not thrown.
    writeFileSync(join(root, "not-a-dir"), "x");
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: join(root, "not-a-dir"), fetchImpl: quiet.fetchImpl }, out)).toBeNull();
    expect(warns).toHaveLength(2);
  });

  test("a source checkout carrying the digest file fetches nothing and touches nothing", async () => {
    const checkout = join(root, "opencodex-checkout");
    mkdirSync(checkout);
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: VERSION }));
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n", checkout);
    ranBefore();
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    const logs: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { logs.push(line); } };
    expect(await fillChildBinaryCacheOnStart({ packageRoot: checkout, opencodexHome: home, fetchImpl }, out)).toEqual({ kind: "skipped", reason: "source_checkout" });
    expect([requested, logs, existsSync(cacheDir()), recorded()]).toEqual([[], [], false, "2.99.0"]);
  });

  test.skipIf(!fillRuns)("a digest file that cannot be used is reported in one line", async () => {
    ranBefore();
    shipDigests("abc  ocx-child-linux-x64\n");
    const warns: string[] = [];
    const out = { log: () => {}, warn: (line: string) => { warns.push(line); } };
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home }, out)).toEqual({ kind: "skipped", reason: "invalid_digests" });
    expect(warns).toEqual(["[link] this package's ocx-child digest file could not be read; no ocx-child build was cached."]);
  });

  test.skipIf(!fillRuns)("a package without digests says nothing and only records its version", async () => {
    const logs: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { logs.push(line); } };
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home }, out)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(logs).toEqual([]);
    expect([readdirSync(join(home, "ocx-child-builds")), recorded()]).toEqual([[".versions"], VERSION + " baseline"]);
  });
});

describe("parity with the reader", () => {
  test("the cached file names are exactly the targets child-binary-source.ts plants", () => {
    expect([...CHILD_CACHE_ARTIFACT_FILES].sort()).toEqual(CHILD_TARGET_TRIPLES.map(childArtifactFilename).sort());
  });

  test("version precedence matches the shared strict semver comparison", () => {
    const versions = ["2.100.0", "2.99.0", "2.100.0-rc.1", "2.100.0-rc.2", "2.100.0-alpha", "2.100.0+build", "10.0.0", "2.100.1-0"];
    for (const left of versions) for (const right of versions) {
      expect(compareReleaseVersions(left, right)).toBe(compareStrictSemver(parseStrictSemver(left)!, parseStrictSemver(right)!));
    }
    expect(compareReleaseVersions("../1.0.0", "1.0.0")).toBeNull();
  });
});

describe("final review: uninstall, startup gates and download edges", () => {
  const quiet = { log: () => {}, warn: () => {} };

  const ownedPaths = () => (JSON.parse(readFileSync(join(home, CONFIG_UNINSTALL_MANIFEST), "utf8")) as { paths: string[] }).paths;
  const start = (fetchImpl = release({}).fetchImpl) => startChildBinaryCacheFill("standalone", { configDir: home, packageRoot, bundledVersion: VERSION, fetchImpl }, quiet);
  const fillDir = () => join(home, "ocx-child-builds");
  /** A Home created before this change: owned, but its manifest does not list ocx-child-builds. */
  function olderOwnedHome(): void {
    expect(recordOwnedConfigPath(home, join(home, "config.json"))).toBe(true);
    const manifestPath = join(home, CONFIG_UNINSTALL_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: manifest.paths.filter(path => path !== "ocx-child-builds") }, null, 2) + "\n", { mode: 0o600 });
  }

  test.skipIf(!fillRuns)("a new Home lists ocx-child-builds only once the fill has created it, and uninstall removes it", async () => {
    expect(recordOwnedConfigPath(home, join(home, "config.json"))).toBe(true);
    expect(ownedPaths()).not.toContain("ocx-child-builds");
    expect(await start()).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(readdirSync(versionsDir())).toEqual([VERSION + ".baseline"]);
    expect(ownedPaths()).toContain("ocx-child-builds");
    expect(ownedPaths().filter(path => path.startsWith("cache"))).toEqual([]);
    expect(removeOwnedConfigState(home).status).toBe("removed");
    expect(existsSync(fillDir())).toBe(false);
  });

  test.skipIf(!fillRuns)("an empty Home gets its ownership metadata before the fill creates its directory", async () => {
    expect(await start()).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(ownedPaths()).toContain("ocx-child-builds");
  });

  test.skipIf(!fillRuns || process.getuid?.() === 0)("an existing empty directory others can write is not claimed", async () => {
    olderOwnedHome();
    mkdirSync(fillDir(), { mode: 0o700 });
    chmodSync(fillDir(), 0o775);
    bothDigests();
    expect(await start()).toEqual({ kind: "skipped", reason: "foreign_directory" });
    expect([ownedPaths().includes("ocx-child-builds"), readdirSync(fillDir())]).toEqual([false, []]);
  });

  test.skipIf(!fillRuns)("a registration the manifest has no room for removes the directory it just created", async () => {
    olderOwnedHome();
    const manifestPath = join(home, CONFIG_UNINSTALL_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
    const filler = Array.from({ length: 1024 - manifest.paths.length }, (_, index) => "filler-" + String(index).padStart(4, "0"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: [...manifest.paths, ...filler].sort() }, null, 2) + "\n", { mode: 0o600 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await start()).toEqual({ kind: "skipped", reason: "ownership_unavailable" });
    } finally { warn.mockRestore(); }
    expect([ownedPaths().includes("ocx-child-builds"), existsSync(fillDir())]).toEqual([false, false]);
  });

  test.skipIf(!fillRuns)("a failed registration keeps an empty private directory it adopted rather than created", async () => {
    olderOwnedHome();
    mkdirSync(fillDir(), { mode: 0o700 });
    const manifestPath = join(home, CONFIG_UNINSTALL_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { paths: string[] };
    const filler = Array.from({ length: 1024 - manifest.paths.length }, (_, index) => "filler-" + String(index).padStart(4, "0"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, paths: [...manifest.paths, ...filler].sort() }, null, 2) + "\n", { mode: 0o600 });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await start()).toEqual({ kind: "skipped", reason: "ownership_unavailable" });
    } finally { warn.mockRestore(); }
    expect([ownedPaths().includes("ocx-child-builds"), existsSync(fillDir())]).toEqual([false, true]);
  });

  test.skipIf(!fillRuns)("an uninstall that finishes between creating the directory and registering it stops the fill", async () => {
    olderOwnedHome();
    bothDigests();
    const register = ownershipModule.registerOwnedConfigPath;
    const racing = spyOn(ownershipModule, "registerOwnedConfigPath").mockImplementation((configDir: string, candidate: string) => {
      expect(removeOwnedConfigState(home).status).toBe("partial");
      return register(configDir, candidate);
    });
    try {
      expect(await start()).toEqual({ kind: "skipped", reason: "uninstall_in_progress" });
    } finally { racing.mockRestore(); }
    expect(existsSync(fillDir())).toBe(false);
  });

  test.skipIf(!fillRuns).each([["absent", false], ["empty", true]])("an older Home registers an %s ocx-child-builds before the fill writes it", async (_name, precreate) => {
    olderOwnedHome();
    if (precreate) mkdirSync(fillDir(), { mode: 0o700 });
    expect(await start()).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(ownedPaths()).toContain("ocx-child-builds");
    expect(removeOwnedConfigState(home).status).toBe("removed");
  });

  test.skipIf(!fillRuns)("the operator's cache/ is never claimed or written, and its files survive uninstall, also those added after a fill", async () => {
    olderOwnedHome();
    const handPlaced = join(home, "cache", "ocx-child", "2.99.0", "ocx-child-linux-x64");
    mkdirSync(join(home, "cache", "ocx-child", "2.99.0"), { recursive: true, mode: 0o700 });
    writeFileSync(handPlaced, linuxBuild, { mode: 0o700 });
    writeFileSync(join(home, "cache", "notes.txt"), "mine");
    bothDigests();
    // The upgrade evidence an earlier start of this Home left, in the directory it claimed then.
    expect(recordOwnedConfigPath(home, fillDir())).toBe(true);
    ranBefore();
    expect(await start(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl))
      .toEqual({ kind: "filled", cached: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], fetched: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], failed: [] });
    writeFileSync(join(home, "cache", "later.txt"), "added after the fill");
    expect(ownedPaths().filter(path => path.startsWith("cache"))).toEqual([]);
    expect(readdirSync(join(home, "cache")).sort()).toEqual(["later.txt", "notes.txt", "ocx-child"]);
    expect(removeOwnedConfigState(home).status).toBe("partial");
    expect([readFileSync(handPlaced, "utf8"), readFileSync(join(home, "cache", "notes.txt"), "utf8"), readFileSync(join(home, "cache", "later.txt"), "utf8"), existsSync(fillDir())])
      .toEqual(["linux build bytes", "mine", "added after the fill", false]);
  });

  test.skipIf(!fillRuns)("the reader takes an operator's build in cache/ocx-child before the one the Home filled", async () => {
    const operatorBuild = new TextEncoder().encode("operator linux build");
    const operatorDir = join(home, "cache", "ocx-child", VERSION);
    mkdirSync(operatorDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(operatorDir, "ocx-child-linux-x64"), operatorBuild, { mode: 0o600 });
    writeFileSync(join(operatorDir, "SHA256SUMS"), sha(operatorBuild) + "  ocx-child-linux-x64\n", { mode: 0o600 });
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    const linux = resolve("linux-x64");
    expect(linux.ok && Buffer.from(linux.artifact.bytes).toString()).toBe("operator linux build");
    const mac = resolve("darwin-arm64");
    expect(mac.ok && Buffer.from(mac.artifact.bytes).toString()).toBe("mac build bytes");
  });

  test.skipIf(!fillRuns)("an unlisted ocx-child-builds that already holds entries is not adopted or written", async () => {
    olderOwnedHome();
    mkdirSync(join(fillDir(), "2.99.0"), { recursive: true, mode: 0o700 });
    writeFileSync(join(fillDir(), "2.99.0", "notes.txt"), "not OpenCodex's");
    bothDigests();
    expect(await start()).toEqual({ kind: "skipped", reason: "foreign_directory" });
    expect([ownedPaths().includes("ocx-child-builds"), readdirSync(fillDir())]).toEqual([false, ["2.99.0"]]);
    expect(removeOwnedConfigState(home).status).toBe("partial");
    expect(readFileSync(join(fillDir(), "2.99.0", "notes.txt"), "utf8")).toBe("not OpenCodex's");
  });

  test.skipIf(!fillRuns)("a start during an uninstall stops and creates nothing", async () => {
    olderOwnedHome();
    const manifestPath = join(home, CONFIG_UNINSTALL_MANIFEST);
    writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, "utf8")), uninstallStartedAt: Date.now() }, null, 2) + "\n", { mode: 0o600 });
    bothDigests();
    expect(await start()).toEqual({ kind: "skipped", reason: "uninstall_in_progress" });
    expect(existsSync(fillDir())).toBe(false);
  });

  test.skipIf(!fillRuns)("a Home without ownership metadata fills as before (its uninstall removes nothing)", async () => {
    writeFileSync(join(home, "config.json"), "{}");
    expect(await start()).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(readdirSync(versionsDir())).toEqual([VERSION + ".baseline"]);
  });

  test("a start stopped by a gate claims nothing", async () => {
    olderOwnedHome();
    expect(await startChildBinaryCacheFill("standalone", { configDir: home, packageRoot, bundledVersion: "2.99.9" }, quiet)).toEqual({ kind: "skipped", reason: "version_mismatch" });
    expect(ownedPaths().includes("ocx-child-builds")).toBe(false);
  });

  test.skipIf(!fillRuns || process.getuid?.() === 0)("a Home directory others can write is refused before anything is claimed", async () => {
    olderOwnedHome();
    bothDigests();
    chmodSync(home, 0o775);
    try {
      expect(await start()).toBeNull();
    } finally { chmodSync(home, 0o700); }
    expect([ownedPaths().includes("ocx-child-builds"), existsSync(fillDir())]).toEqual([false, false]);
  });

  // A Windows Home: the startup step stops at the platform gate, before the claim and before any read of the Home's fill state.
  test("a Windows Home's startup step answers unsupported_platform, claims nothing and writes nothing", async () => {
    olderOwnedHome();
    bothDigests();
    ranBefore();
    const markers = readdirSync(versionsDir());
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await startChildBinaryCacheFill("standalone", { configDir: home, packageRoot, bundledVersion: VERSION, fetchImpl, platform: "win32" }, quiet)).toEqual({ kind: "skipped", reason: "unsupported_platform" });
    expect([requested, ownedPaths().includes("ocx-child-builds"), existsSync(cacheDir()), readdirSync(versionsDir())]).toEqual([[], false, false, markers]);
  });

  // The same on a real Windows runner with nothing injected: the platform the code reads by default is the one that skips.
  test.skipIf(fillRuns)("on Windows the startup step skips by itself, claims nothing and writes nothing", async () => {
    olderOwnedHome();
    bothDigests();
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await start(fetchImpl)).toEqual({ kind: "skipped", reason: "unsupported_platform" });
    expect([requested, ownedPaths().includes("ocx-child-builds"), existsSync(fillDir())]).toEqual([[], false, false]);
  });


  test("a client runtime records and writes nothing", async () => {
    expect(await startChildBinaryCacheFill("client", { configDir: home, packageRoot, bundledVersion: VERSION }, quiet)).toBeNull();
    expect(readdirSync(home)).toEqual([]);
  });

  test("OCX_DISABLE_CHILD_CACHE_FILL=1 reads and writes nothing", async () => {
    bothDigests();
    ranBefore();
    const previous = process.env.OCX_DISABLE_CHILD_CACHE_FILL;
    process.env.OCX_DISABLE_CHILD_CACHE_FILL = "1";
    try {
      const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
      expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl }, quiet)).toEqual({ kind: "skipped", reason: "disabled" });
      expect([requested, existsSync(cacheDir())]).toEqual([[], false]);
    } finally {
      if (previous === undefined) delete process.env.OCX_DISABLE_CHILD_CACHE_FILL; else process.env.OCX_DISABLE_CHILD_CACHE_FILL = previous;
    }
  });

  test("a package.json that is not the running code's version records nothing", async () => {
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, bundledVersion: "2.99.9" }, quiet)).toEqual({ kind: "skipped", reason: "version_mismatch" });
    expect(existsSync(join(home, "ocx-child-builds"))).toBe(false);
  });

  test.skipIf(!fillRuns || process.getuid?.() === 0)("a same-version restart takes no lock and writes nothing", async () => {
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    const root = join(home, "ocx-child-builds");
    chmodSync(root, 0o500);
    try {
      expect(await fill(release({}).fetchImpl)).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    } finally { chmodSync(root, 0o700); }
  });

  test.skipIf(!fillRuns)("a version directory removed by hand after a completed fill stays removed and nothing is reported failed", async () => {
    bothDigests();
    ranBefore();
    await fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl);
    rmSync(cacheDir(), { recursive: true });
    expect(await fill(release({}).fetchImpl)).toEqual({ kind: "skipped", reason: "not_an_upgrade" });
    expect(existsSync(cacheDir())).toBe(false);
  });

  test.skipIf(!fillRuns)("a publish that cannot reach its final name leaves no temp file behind", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    mkdirSync(join(cacheDir(), "ocx-child-linux-x64"), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64", "occupied"), "x");
    await expect(fill(release({ "ocx-child-linux-x64": linuxBuild }).fetchImpl)).rejects.toThrow();
    expect(readdirSync(cacheDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  const streamOf = (chunks: Uint8Array[], failAfter?: number) => new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && failAfter-- === 0) { controller.error(new Error("connection reset")); return; }
      const next = chunks.shift();
      if (next) controller.enqueue(next); else controller.close();
    },
  });

  test.skipIf(!fillRuns).each([
    ["a body larger than the cap without a content-length", () => new Response(streamOf(Array.from({ length: 33 }, () => new Uint8Array(1024 * 1024))))],
    ["a body stream that errors part way", () => new Response(streamOf([linuxBuild.slice(0, 4), linuxBuild.slice(4)], 1))],
  ])("%s is refused", async (_name, answer) => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const fetchImpl = (async () => answer()) as unknown as typeof fetch;
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
  });

  test.skipIf(!fillRuns)("a download that hangs is abandoned at its deadline", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const hang = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
    expect(await fillChildBinaryCacheForVersion({ packageRoot, version: VERSION, opencodexHome: home, fetchImpl: hang, timeoutMs: 5 }))
      .toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
  });

  test.skipIf(!fillRuns)("cache directories owned by another user are refused", async () => {
    bothDigests();
    ranBefore();
    const uid = spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      await expect(fill(release({}).fetchImpl)).rejects.toThrow("unsafe cache directory");
    } finally { uid.mockRestore(); }
  });
});

describe.skipIf(!fillRuns)("the reader and the fill resolve the same Home", () => {
  test.skipIf(!fillRuns)("with no Home passed, the reader finds what the startup step filled for a ~ spelling of OPENCODEX_HOME", async () => {
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = "~/ocx-child-reader-home-" + Date.now();
    const configDir = spyOn(pathsModule, "getConfigDir").mockReturnValue(home);
    try {
      expect(recordOwnedConfigPath(home, join(home, "config.json"))).toBe(true);
      expect(recordOwnedConfigPath(home, join(home, "ocx-child-builds"))).toBe(true);
      bothDigests();
      ranBefore();
      const quiet = { log: () => {}, warn: () => {} };
      const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
      expect((await startChildBinaryCacheFill("standalone", { packageRoot, bundledVersion: VERSION, fetchImpl }, quiet))?.kind).toBe("filled");
      const found = resolveChildBinarySource("linux-x64", { version: VERSION, repoRoot: empty, execPath: join(empty, "ocx"), allowLocalRelease: false });
      expect(found.ok && Buffer.from(found.artifact.bytes).toString()).toBe("linux build bytes");
    } finally {
      configDir.mockRestore();
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
  });
});

describe.skipIf(!fillRuns)("the fill lock's temp file", () => {
  test.skipIf(!fillRuns)("a lock write that fails leaves no .lock.tmp behind", async () => {
    bothDigests();
    ranBefore();
    const fsync = spyOn(fsModule, "fsyncSync").mockImplementationOnce(() => { throw Object.assign(new Error("no space"), { code: "ENOSPC" }); });
    try {
      await expect(fill(release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild }).fetchImpl)).rejects.toThrow("no space");
    } finally { fsync.mockRestore(); }
    expect(readdirSync(join(home, "ocx-child-builds")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe.skipIf(!fillRuns)("uninstall after a full fill", () => {
  test.skipIf(!fillRuns)("builds, manifest, markers, a stale lock and leftover temps all go, and uninstall ends removed", async () => {
    expect(recordOwnedConfigPath(home, join(home, "config.json"))).toBe(true);
    bothDigests();
    const quiet = { log: () => {}, warn: () => {} };
    expect(await startChildBinaryCacheFill("standalone", { configDir: home, packageRoot, bundledVersion: VERSION, fetchImpl: release({}).fetchImpl }, quiet))
      .toEqual({ kind: "skipped", reason: "first_start" });
    rmSync(versionsDir(), { recursive: true });
    ranBefore();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect((await startChildBinaryCacheFill("standalone", { configDir: home, packageRoot, bundledVersion: VERSION, fetchImpl }, quiet))?.kind).toBe("filled");
    const fillRoot = join(home, "ocx-child-builds");
    writeFileSync(join(fillRoot, ".fill.lock"), "999999999.deadbeef\n", { mode: 0o600 });
    writeFileSync(join(fillRoot, ".ocx-child-cache.999999999.0011223344aa.tmp"), "partial", { mode: 0o600 });
    writeFileSync(join(cacheDir(), ".ocx-child-cache.999999999.5566778899bb.tmp"), "partial", { mode: 0o600 });
    expect(readdirSync(cacheDir()).sort()).toContain("SHA256SUMS");
    writeFileSync(join(home, "config.json"), "{}");
    expect(removeOwnedConfigState(home)).toEqual({ status: "removed", residualPaths: [] });
    expect(existsSync(home)).toBe(false);
  });
});

describe("the fill is always given its Home", () => {
  test("a call without opencodexHome is refused before anything is read or written, whatever OPENCODEX_HOME says", async () => {
    const previous = process.env.OPENCODEX_HOME;
    const elsewhere = join(root, "env-home");
    process.env.OPENCODEX_HOME = elsewhere;
    try {
      await expect(fillChildBinaryCacheForVersion({ packageRoot, version: VERSION } as never)).rejects.toThrow("opencodexHome");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
    expect(existsSync(elsewhere)).toBe(false);
  });
});
