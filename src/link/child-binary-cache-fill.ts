import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFileNoFollow } from "../config/atomic-write";
import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import { CHILD_TARGET_TRIPLES, childArtifactFilename, parseSha256Sums } from "./child-binary-source";

/**
 * Fills $OPENCODEX_HOME/cache/ocx-child/<version>/ after an update (lane O2 of the
 * disposable-machines design), so a packaged Home can plant ocx-child on a bare machine.
 *
 * Trust is the update's own: the expected digests come from CHILD_RELEASE_DIGESTS_PATH inside the
 * package tree the update just installed and verified, and each binary, fetched from the GitHub
 * release of exactly that version, is cached only when its SHA-256 equals that digest. Nothing is
 * fetched without that file, for the same version, or on a downgrade; any missing or mismatching
 * build is skipped, and child-binary-source.ts keeps answering artifact_not_found for it.
 */

/** Digests of the release's ocx-child builds, relative to the package root ("<sha256>  ocx-child-<triple>[.exe]"). */
export const CHILD_RELEASE_DIGESTS_PATH = "native/ocx-child/SHA256SUMS";
export const CHILD_RELEASE_REPOSITORY = "lidge-jun/opencodex";
const MAX_CHILD_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_DIGESTS_BYTES = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function childReleaseAssetUrl(version: string, file: string): string {
  return "https://github.com/" + CHILD_RELEASE_REPOSITORY + "/releases/download/v" + encodeURIComponent(version) + "/" + encodeURIComponent(file);
}

export function childBinaryCacheDir(opencodexHome: string, version: string): string {
  return join(opencodexHome, "cache", "ocx-child", version);
}

export type ChildCacheFillOutcome =
  | { readonly kind: "skipped"; readonly reason: "invalid_version" | "not_newer" | "no_digests" }
  | { readonly kind: "filled"; readonly cached: readonly string[]; readonly failed: readonly string[] };

export interface ChildCacheFillOptions {
  /** Root of the package tree the update installed and verified. */
  readonly packageRoot: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly opencodexHome?: string;
  readonly fetchImpl?: typeof fetch;
  /** Per download. */
  readonly timeoutMs?: number;
}

function readDigests(packageRoot: string): Map<string, string> | null {
  const path = join(packageRoot, CHILD_RELEASE_DIGESTS_PATH);
  let bytes: Buffer;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > MAX_DIGESTS_BYTES) return null;
    bytes = readFileSync(path);
  } catch { return null; }
  const all = parseSha256Sums(bytes.toString("utf8"));
  const known = new Set(CHILD_TARGET_TRIPLES.map(childArtifactFilename));
  const digests = new Map([...all].filter(([file, sha]) => known.has(file) && SHA256_HEX.test(sha)));
  return digests.size > 0 ? digests : null;
}

async function download(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Uint8Array | null> {
  let response: Response;
  try { response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_CHILD_BINARY_BYTES) { await response.body.cancel().catch(() => {}); return null; }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > MAX_CHILD_BINARY_BYTES) return null;
      chunks.push(chunk);
    }
  } catch { return null; }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A cached file that already carries the expected digest, so it is not fetched again. */
function cachedMatches(path: string, expected: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && !st.isSymbolicLink() && st.size <= MAX_CHILD_BINARY_BYTES && sha256Hex(readFileSync(path)) === expected;
  } catch { return false; }
}

function writePrivate(path: string, content: string | Uint8Array): void {
  atomicWriteFileNoFollow(path, content);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export async function fillChildBinaryCacheAfterUpdate(options: ChildCacheFillOptions): Promise<ChildCacheFillOutcome> {
  const from = parseStrictSemver(options.fromVersion);
  const to = parseStrictSemver(options.toVersion);
  if (!from || !to) return { kind: "skipped", reason: "invalid_version" };
  if (compareStrictSemver(to, from) <= 0) return { kind: "skipped", reason: "not_newer" };
  const digests = readDigests(options.packageRoot);
  if (!digests) return { kind: "skipped", reason: "no_digests" };
  const home = options.opencodexHome || process.env.OPENCODEX_HOME?.trim() || join(process.env.HOME || homedir(), ".opencodex");
  const dir = childBinaryCacheDir(home, options.toVersion);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cached: string[] = [];
  const failed: string[] = [];
  for (const [file, expected] of [...digests].sort(([a], [b]) => a.localeCompare(b))) {
    const target = join(dir, file);
    if (cachedMatches(target, expected)) { cached.push(file); continue; }
    const bytes = await download(childReleaseAssetUrl(options.toVersion, file), fetchImpl, timeoutMs);
    if (!bytes || sha256Hex(bytes) !== expected) { failed.push(file); continue; }
    writePrivate(target, bytes);
    cached.push(file);
  }
  // The reader verifies every cached file against this list, so it names only verified files.
  if (cached.length > 0) writePrivate(join(dir, "SHA256SUMS"), cached.map(file => digests.get(file) + "  " + file + "\n").join(""));
  return { kind: "filled", cached, failed };
}

/**
 * The update's last step (src/update/index.ts): fill the cache for the version just installed and
 * say what happened in one line. Never throws, so it can never fail an update that already succeeded.
 */
export async function cacheChildBuildsAfterUpdate(
  options: ChildCacheFillOptions,
  out: { log: (line: string) => void; warn: (line: string) => void } = { log: console.log, warn: console.warn },
): Promise<ChildCacheFillOutcome | null> {
  let outcome: ChildCacheFillOutcome;
  try { outcome = await fillChildBinaryCacheAfterUpdate({ timeoutMs: 20_000, ...options }); } catch {
    out.warn("Remote Link: the ocx-child builds of this release could not be cached; planting on a bare machine needs a build supplied by hand.");
    return null;
  }
  if (outcome.kind === "filled") {
    if (outcome.cached.length > 0) out.log("Remote Link: cached " + outcome.cached.length + " verified ocx-child build" + (outcome.cached.length === 1 ? "" : "s") + " for v" + options.toVersion + ".");
    if (outcome.failed.length > 0) out.warn("Remote Link: " + outcome.failed.length + " ocx-child build" + (outcome.failed.length === 1 ? "" : "s") + " of this release could not be fetched or did not match the package digests; only verified builds are planted.");
  }
  return outcome;
}
