import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChildBinarySource } from "../../src/link/child-binary-source";
import { CHILD_RELEASE_DIGESTS_PATH, cacheChildBuildsAfterUpdate, childBinaryCacheDir, childReleaseAssetUrl, fillChildBinaryCacheAfterUpdate } from "../../src/link/child-binary-cache-fill";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Lane O2: after an update, the Home fills cache/ocx-child/<version>/ from the release of that
// version, trusting only the digests inside the package tree the update installed and verified.

const FROM = "2.99.0";
const TO = "2.100.0";
const linuxBuild = new TextEncoder().encode("linux build bytes");
const macBuild = new TextEncoder().encode("mac build bytes");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let root: string;
let packageRoot: string;
let home: string;
let empty: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-child-cache-fill-"));
  packageRoot = join(root, "package");
  home = join(root, "opencodex-home");
  empty = join(root, "empty");
  for (const dir of [packageRoot, home, empty]) mkdirSync(dir, { recursive: true });
});
afterEach(() => removeTreeWithRetry(root));

function shipDigests(lines: string): void {
  const path = join(packageRoot, CHILD_RELEASE_DIGESTS_PATH);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, lines);
}

function release(assets: Record<string, Uint8Array | number>) {
  const requested: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    const name = decodeURIComponent(url.split("/").at(-1)!);
    const asset = url.startsWith("https://github.com/lidge-jun/opencodex/releases/download/v" + TO + "/") ? assets[name] : undefined;
    if (asset === undefined) return new Response("not found", { status: 404 });
    if (typeof asset === "number") return new Response("", { status: asset });
    return new Response(asset, { status: 200, headers: { "content-length": String(asset.byteLength) } });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const resolve = (triple: "linux-x64" | "darwin-arm64") => resolveChildBinarySource(triple, {
  env: {}, opencodexHome: home, version: TO, repoRoot: empty, execPath: join(empty, "ocx"), allowLocalRelease: false,
});

describe("filling the ocx-child cache after an update", () => {
  test("after an update, probe answers plantable for every build the release digests vouch for", async () => {
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": macBuild });
    const outcome = await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl });
    expect(outcome).toEqual({ kind: "filled", cached: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"], failed: [] });
    expect(requested.sort()).toEqual([childReleaseAssetUrl(TO, "ocx-child-darwin-arm64"), childReleaseAssetUrl(TO, "ocx-child-linux-x64")].sort());
    const linux = resolve("linux-x64");
    expect(linux.ok && linux.artifact.source).toBe("cache");
    expect(linux.ok && linux.artifact.sha256).toBe(sha(linuxBuild));
    expect(resolve("darwin-arm64").ok).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(childBinaryCacheDir(home, TO)).mode & 0o777).toBe(0o700);
      expect(statSync(join(childBinaryCacheDir(home, TO), "ocx-child-linux-x64")).mode & 0o777).toBe(0o600);
    }
    // A second run finds the verified files and fetches nothing.
    const again = release({});
    expect(await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl: again.fetchImpl })).toMatchObject({ kind: "filled", failed: [] });
    expect(again.requested).toEqual([]);
  });

  test("a build whose bytes do not match the package digest is never cached", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");
    const { fetchImpl } = release({ "ocx-child-linux-x64": new TextEncoder().encode("tampered"), "ocx-child-darwin-arm64": 404 });
    const outcome = await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl });
    expect(outcome).toEqual({ kind: "filled", cached: [], failed: ["ocx-child-darwin-arm64", "ocx-child-linux-x64"] });
    expect(existsSync(join(childBinaryCacheDir(home, TO), "ocx-child-linux-x64"))).toBe(false);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("one good build is cached and listed alone when another fails", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 500 });
    await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl });
    expect(readFileSync(join(childBinaryCacheDir(home, TO), "SHA256SUMS"), "utf8")).toBe(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    expect(resolve("linux-x64").ok).toBe(true);
    expect(resolve("darwin-arm64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test.each([
    ["a downgrade", TO, FROM],
    ["the same version", TO, TO],
    ["an unparsable version", "garbage", TO],
  ])("%s fetches nothing and writes nothing", async (_name, from, to) => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    const outcome = await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: from, toVersion: to, opencodexHome: home, fetchImpl });
    expect(outcome.kind).toBe("skipped");
    expect(requested).toEqual([]);
    expect(existsSync(join(home, "cache"))).toBe(false);
  });

  test.each([
    ["a package without the digest file", null],
    ["a digest file naming no ocx-child build", sha(linuxBuild) + "  ocx-linux-x64\n"],
    ["a digest file with a malformed digest", "abc  ocx-child-linux-x64\n"],
  ])("%s keeps every Home as it is today: no request, no cache", async (_name, digests) => {
    if (digests !== null) shipDigests(digests);
    const { fetchImpl, requested } = release({ "ocx-child-linux-x64": linuxBuild });
    expect(await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl })).toEqual({ kind: "skipped", reason: "no_digests" });
    expect(requested).toEqual([]);
    expect(existsSync(join(home, "cache"))).toBe(false);
    expect(resolve("linux-x64")).toEqual({ ok: false, reason: "artifact_not_found" });
  });

  test("an oversized download is refused before it is buffered", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    const fetchImpl = (async () => new Response(linuxBuild, { status: 200, headers: { "content-length": String(64 * 1024 * 1024) } })) as unknown as typeof fetch;
    const outcome = await fillChildBinaryCacheAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl });
    expect(outcome).toEqual({ kind: "filled", cached: [], failed: ["ocx-child-linux-x64"] });
  });
});

describe("the update's last step", () => {
  test("reports what it cached in one line and never throws", async () => {
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n" + sha(macBuild) + "  ocx-child-darwin-arm64\n");
    const { fetchImpl } = release({ "ocx-child-linux-x64": linuxBuild, "ocx-child-darwin-arm64": 404 });
    const logs: string[] = [], warns: string[] = [];
    const out = { log: (line: string) => { logs.push(line); }, warn: (line: string) => { warns.push(line); } };
    await cacheChildBuildsAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl }, out);
    expect(logs).toEqual(["Remote Link: cached 1 verified ocx-child build for v" + TO + "."]);
    expect(warns).toHaveLength(1);
    // A package without digests says nothing at all.
    removeTreeWithRetry(join(packageRoot, "native"));
    logs.length = 0; warns.length = 0;
    expect(await cacheChildBuildsAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: home, fetchImpl }, out)).toEqual({ kind: "skipped", reason: "no_digests" });
    expect([...logs, ...warns]).toEqual([]);
    // A failure inside the fill is reported, not thrown.
    shipDigests(sha(linuxBuild) + "  ocx-child-linux-x64\n");
    writeFileSync(join(root, "not-a-dir"), "x");
    expect(await cacheChildBuildsAfterUpdate({ packageRoot, fromVersion: FROM, toVersion: TO, opencodexHome: join(root, "not-a-dir"), fetchImpl }, out)).toBeNull();
    expect(warns).toHaveLength(1);
  });
});
