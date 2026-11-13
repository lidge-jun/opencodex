import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_TARGET_TRIPLES, childArtifactFilename, resolveChildBinarySource } from "../../src/link/child-binary-source";
import {
  CHILD_CACHE_ARTIFACT_FILES, CHILD_RELEASE_DIGESTS_PATH, childBinaryCacheDir, childReleaseAssetUrl, compareReleaseVersions,
  fillChildBinaryCacheForVersion, fillChildBinaryCacheOnStart,
} from "../../src/link/child-binary-cache-fill.mjs";
import { compareStrictSemver, parseStrictSemver } from "../../src/lib/strict-semver";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Lane O2: an updated Home of version V fills cache/ocx-child/V/ from the GitHub release of V, trusting
// only the digests inside its own installed package, so a packaged Home can plant ocx-child after an update.

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
const recordPath = () => join(home, "cache", "ocx-child", ".home-version");
/** The evidence of an upgrade: this Home last completed a fill as `version`. */
function ranBefore(version = "2.99.0"): void {
  mkdirSync(join(home, "cache", "ocx-child"), { recursive: true, mode: 0o700 });
  writeFileSync(recordPath(), version + "\n", { mode: 0o600 });
}
const recorded = () => readFileSync(recordPath(), "utf8").trim();

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
  test("after an update, probe answers plantable for every build the package digests vouch for", async () => {
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

  test("a build whose bytes do not match the package digest is never cached, and the next start retries", async () => {
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

  test("one good build is cached and listed alone when another fails", async () => {
    bothDigests();
    ranBefore();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 500 });
    await fill(fetchImpl);
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(resolve("linux-x64").ok).toBe(true);
    expect(resolve("darwin-arm64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("a build the package no longer vouches for loses its manifest line when its refetch fails, and its file stays", async () => {
    ranBefore();
    const oldBuild = new TextEncoder().encode("operator build");
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), oldBuild, { mode: 0o600 });
    // A build placed by hand for a target the release does not list keeps its line.
    const handBuild = new TextEncoder().encode("hand build");
    writeFileSync(join(cacheDir(), "ocx-child-windows-x64.exe"), handBuild, { mode: 0o600 });
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(oldBuild) + "  ocx-child-linux-x64\n" + sha(handBuild) + "  ocx-child-windows-x64.exe\n", { mode: 0o600 });
    expect(resolve("linux-x64").ok).toBe(true);
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(await fill(release({ "ocx-child-linux-x64": 503 }).fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
    expect(readFileSync(join(cacheDir(), "ocx-child-linux-x64"))).toEqual(Buffer.from(oldBuild));
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(handBuild) + "  ocx-child-windows-x64.exe\n");
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "checksum_mismatch" });
  });

  test("a stale manifest is removed when no listed build is left", async () => {
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

  test("a downgraded Home fetches nothing: a newer version's cache exists", async () => {
    bothDigests();
    mkdirSync(join(home, "cache", "ocx-child", "2.101.0"), { recursive: true });
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "downgrade" });
    expect(requested).toEqual([]);
    expect(existsSync(cacheDir())).toBe(false);
  });

  test.each([
    ["a fresh install (no record) records its version", null, "first_start", VERSION],
    ["a restart of the same version with a build missing", VERSION, "not_an_upgrade", VERSION],
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

  test.each([
    ["a package without the digest file", null],
    ["a digest file naming no ocx-child build", sha(linuxBuild) + "  ocx-linux-x64\n"],
    ["a digest file with a malformed digest", "abc  ocx-child-linux-x64\n"],
  ])("%s fetches nothing and only records its version", async (_name, digests) => {
    if (digests !== null) shipDigests(digests);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(requested).toEqual([]);
    expect(readdirSync(join(home, "cache", "ocx-child"))).toEqual([".home-version"]);
    expect(recorded()).toBe(VERSION);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("the first release that ships digests fills: the release before it recorded the baseline", async () => {
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    expect(await fill(fetchImpl, "2.99.0")).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(recorded()).toBe("2.99.0");
    bothDigests();
    expect(await fill(fetchImpl)).toMatchObject({ kind: "filled", fetched: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], failed: [] });
    expect(requested).toHaveLength(2);
    expect(resolve("linux-x64").ok).toBe(true);
  });

  test("a package without digests never lowers the record and never fails on an unsafe home", async () => {
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

  test("an oversized download is refused", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    ranBefore();
    const fetchImpl = (async () => new Response(linuxBuild, { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
  });
});

describe.skipIf(process.platform === "win32")("nobody else can substitute a build", () => {
  test("a matching cached build the reader would refuse (writable by others) is fetched again", async () => {
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
    ["the version directory", () => join(home, "cache", "ocx-child", VERSION), true, 0o770],
    ["cache/ocx-child", () => join(home, "cache", "ocx-child"), true, 0o777],
    ["cache", () => join(home, "cache"), false, 0o775],
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

  test("a directory above the cache that others can write is refused; a sticky one (like /tmp) is not", async () => {
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

describe.skipIf(process.platform === "win32")("the cache is never written through a symlink", () => {
  test.each([
    ["the version directory", () => join(home, "cache", "ocx-child", VERSION), true],
    ["cache/ocx-child", () => join(home, "cache", "ocx-child"), false],
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

  test("a version directory swapped for a symlink during a download receives nothing", async () => {
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
  test("reads the running package version, retries an incomplete fill, reports in one line, and never throws", async () => {
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

  test("a package without digests says nothing and only records its version", async () => {
    const logs: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { logs.push(line); } };
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home }, out)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(logs).toEqual([]);
    expect([readdirSync(join(home, "cache", "ocx-child")), recorded()]).toEqual([[".home-version"], VERSION]);
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
