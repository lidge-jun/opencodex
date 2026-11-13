import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_TARGET_TRIPLES, childArtifactFilename, resolveChildBinarySource } from "../../src/link/child-binary-source";
import {
  CHILD_CACHE_ARTIFACT_FILES, CHILD_RELEASE_DIGESTS_PATH, childBinaryCacheDir, childReleaseAssetUrl, compareReleaseVersions,
  fillChildBinaryCacheForVersion, fillChildBinaryCacheOnStart,
} from "../../src/link/child-binary-cache-fill.mjs";
import { compareStrictSemver, parseStrictSemver } from "../../src/lib/strict-semver";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Lane O2: a Home of version V fills cache/ocx-child/V/ from the GitHub release of V, trusting only
// the digests inside its own installed package, so a packaged Home can plant ocx-child after an update.

const VERSION = "2.100.0";
const linuxBuild = new TextEncoder().encode("linux build bytes");
const macBuild = new TextEncoder().encode("mac build bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let root: string, packageRoot: string, home: string, empty: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-child-cache-fill-"));
  packageRoot = join(root, "package");
  home = join(root, "opencodex-home");
  empty = join(root, "empty");
  for (const dir of [packageRoot, home, empty]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: VERSION }));
});
afterEach(() => removeTreeWithRetry(root));

function shipDigests(lines: string): void {
  mkdirSync(join(packageRoot, "native", "ocx-child"), { recursive: true });
  writeFileSync(join(packageRoot, CHILD_RELEASE_DIGESTS_PATH), lines);
}
const bothDigests = () => shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");

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
    // The next start finds the verified files and fetches nothing.
    const again = release({});
    expect(await fill(again.fetchImpl)).toMatchObject({ kind: "filled", fetched: [], failed: [] });
    expect(again.requested).toEqual([]);
    expect(readdirSync(cacheDir()).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a build whose bytes do not match the package digest is never cached", async () => {
    bothDigests();
    const { fetchImpl } = release({ "ocx-child-linux-x64": new TextEncoder().encode("tampered"), "ocx-child-darwin-arm64": 404 });
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"] });
    expect(existsSync(join(cacheDir(), "ocx-child-linux-x64"))).toBe(false);
    expect(existsSync(join(cacheDir(), "SHA256SUMS"))).toBe(false);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("one good build is cached and listed alone when another fails", async () => {
    bothDigests();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 500 });
    await fill(fetchImpl);
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(resolve("linux-x64").ok).toBe(true);
    expect(resolve("darwin-arm64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("an older cached build the package no longer vouches for is withdrawn when its refetch fails", async () => {
    const oldBuild = new TextEncoder().encode("older build");
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), oldBuild, { mode: 0o600 });
    // A build placed by hand for a target the release does not list keeps its line.
    const handBuild = new TextEncoder().encode("hand build");
    writeFileSync(join(cacheDir(), "ocx-child-windows-x64.exe"), handBuild, { mode: 0o600 });
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(oldBuild) + "  ocx-child-linux-x64\n" + sha(handBuild) + "  ocx-child-windows-x64.exe\n", { mode: 0o600 });
    expect(resolve("linux-x64").ok).toBe(true);
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(await fill(release({ "ocx-child-linux-x64": 503 }).fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
    expect(existsSync(join(cacheDir(), "ocx-child-linux-x64"))).toBe(false);
    expect(readFileSync(join(cacheDir(), "SHA256SUMS"), "utf8")).toBe(sha(handBuild) + "  ocx-child-windows-x64.exe\n");
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("a stale manifest is removed when no build is left", async () => {
    const oldBuild = new TextEncoder().encode("older build");
    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(cacheDir(), "ocx-child-linux-x64"), oldBuild, { mode: 0o600 });
    writeFileSync(join(cacheDir(), "SHA256SUMS"), sha(oldBuild) + "  ocx-child-linux-x64\n", { mode: 0o600 });
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    await fill(release({}).fetchImpl);
    expect(readdirSync(cacheDir())).toEqual([]);
  });

  test("a downgraded Home fetches nothing: a newer version's cache exists", async () => {
    bothDigests();
    mkdirSync(join(home, "cache", "ocx-child", "2.101.0"), { recursive: true });
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "downgrade" });
    expect(requested).toEqual([]);
    expect(existsSync(cacheDir())).toBe(false);
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
  ])("%s keeps every Home as it is today: no request, no cache", async (_name, digests) => {
    if (digests !== null) shipDigests(digests);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fill(fetchImpl)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(requested).toEqual([]);
    expect(existsSync(join(home, "cache"))).toBe(false);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("an oversized download is refused", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    const fetchImpl = (async () => new Response(linuxBuild, { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
    expect(await fill(fetchImpl)).toEqual({ kind: "filled", cached: [], fetched: [], failed: ["ocx-child-linux-x64"] });
  });
});

describe.skipIf(process.platform === "win32")("the cache is never written through a symlink", () => {
  test.each([
    ["the version directory", () => join(home, "cache", "ocx-child", VERSION)],
    ["cache/ocx-child", () => join(home, "cache", "ocx-child")],
  ])("%s as a symlink is refused before any write", async (_name, link) => {
    bothDigests();
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
  test("reads the running package version, reports in one line, and never throws", async () => {
    bothDigests();
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 404 });
    const logs: string[] = [], warns: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { warns.push(line); } };
    await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl }, out);
    expect(logs).toEqual(["[link] cached 1 verified ocx-child build for v" + VERSION + "."]);
    expect(warns).toHaveLength(1);
    // A later start that fetches nothing says nothing.
    logs.length = 0; warns.length = 0;
    await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home, fetchImpl: release({ "ocx-child-linux-x64": linuxBuild }).fetchImpl }, out);
    expect(logs).toEqual([]);
    // A failure inside the fill is reported, not thrown.
    writeFileSync(join(root, "not-a-dir"), "x");
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: join(root, "not-a-dir"), fetchImpl }, out)).toBeNull();
    expect(warns).toHaveLength(2);
  });

  test("a package without digests says nothing and touches nothing", async () => {
    const logs: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { logs.push(line); } };
    expect(await fillChildBinaryCacheOnStart({ packageRoot, opencodexHome: home }, out)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(logs).toEqual([]);
    expect(existsSync(join(home, "cache"))).toBe(false);
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
