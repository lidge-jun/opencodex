// Plain ESM shared by the Node launcher (bin/ocx.mjs) and the Bun updater (src/update/index.ts):
// the launcher runs under Node and cannot import TypeScript. Types: child-binary-cache-fill.d.mts.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstallFromPath } from "../update/install-detection.mjs";

/**
 * Fills $OPENCODEX_HOME/cache/ocx-child/<version>/ when an updated Home of that version starts (lane
 * O2 of the disposable-machines design), so a packaged Home can plant ocx-child on a bare machine
 * after an update by any installer.
 *
 * Trust is the update's own: the expected digests come from CHILD_RELEASE_DIGESTS_PATH inside the
 * running package tree, which its installer verified, and each binary, fetched from the GitHub
 * release of exactly that version, is cached only when its SHA-256 equals that digest. Nothing is
 * fetched without that file, from a source checkout, on Windows, or without evidence of an upgrade:
 * cache/ocx-child/.home-version records the last version whose fill completed, or "<version> baseline"
 * for a version that ran and fetched nothing (a first start, or a package without digests, silently,
 * so the first release that ships them sees an upgrade), and only a running version newer than it fills. A first start (no record: a fresh install) records
 * its version and fetches nothing, a restart of the same version fetches nothing, and a record or
 * cache directory for a newer version means a downgrade. A listed build that cannot be verified loses its manifest line,
 * so it can never stay trusted under an older manifest, but its file is left in place (it may be an
 * operator's); the record stays behind until every listed build is verified, so the next start retries.
 * A digest file that is there but unreadable or unusable is not an absent one: nothing is written and
 * the record stays, so a repaired package still fills. Overlapping fills cannot lose a build: the
 * manifest is rebuilt from the builds verified on disk when it is written, and a completed record
 * whose manifest no longer covers the package's digests is repaired on the next start (re-listing
 * verified files, downloading only what is missing). cache/ocx-child/.fill.lock (reclaimed once its
 * process is gone or after an hour) keeps concurrent starts from downloading twice; it is not the guarantee.
 *
 * Nobody else can substitute a build: each of cache, cache/ocx-child and the version
 * directory must be a real directory (never a symlink; created 0700 when missing) owned by this user
 * and writable by nobody else, and every directory above them must be owned by this user or root and
 * writable by nobody else unless sticky. Every write re-checks the target directory's identity, so a
 * directory swapped in during a download receives nothing. An existing build counts only when it
 * passes the reader's file checks as well as the digest. Windows has no mode bits to establish that
 * privacy, so there the fill does nothing and builds are placed by hand.
 */

/** Digests of the release's ocx-child builds, relative to the package root ("<sha256>  ocx-child-<triple>[.exe]"). */
export const CHILD_RELEASE_DIGESTS_PATH = "native/ocx-child/SHA256SUMS";
export const CHILD_RELEASE_REPOSITORY = "lidge-jun/opencodex";
/** The build file names child-binary-source.ts plants from (childArtifactFilename of every target). */
export const CHILD_CACHE_ARTIFACT_FILES = Object.freeze([
  "ocx-child-darwin-arm64", "ocx-child-darwin-x64", "ocx-child-linux-x64", "ocx-child-linux-arm64", "ocx-child-windows-x64.exe",
]);
const MAX_CHILD_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_RECORD = ".home-version";
const POSIX = process.platform !== "win32";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function childReleaseAssetUrl(version, file) {
  return "https://github.com/" + CHILD_RELEASE_REPOSITORY + "/releases/download/v" + encodeURIComponent(version) + "/" + encodeURIComponent(file);
}

export function childBinaryCacheDir(opencodexHome, version) {
  return join(opencodexHome, "cache", "ocx-child", version);
}

function parseVersion(value) {
  if (typeof value !== "string" || value.length > 96) return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], pre: match[4] === undefined ? [] : match[4].split(".") };
}

/** SemVer precedence (build metadata ignored): -1 older, 0 equal, 1 newer. */
export function compareReleaseVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** "<sha256>  <file>" lines, the format child-binary-source.ts reads (parseSha256Sums). */
function parseManifest(text) {
  const entries = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9A-Fa-f]{64})\s+\*?([^\s/\\]+)$/.exec(line);
    if (match) entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function readRegular(path, maxBytes) {
  let st;
  try { st = lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) throw new Error("not a regular file: " + path);
  return readFileSync(path);
}

/** null: no digest file (every release so far); "invalid": there but unreadable or unusable; else the digests. */
function readDigests(packageRoot) {
  let bytes;
  try { bytes = readRegular(join(packageRoot, CHILD_RELEASE_DIGESTS_PATH), MAX_MANIFEST_BYTES); } catch { return "invalid"; }
  if (bytes === null) return null;
  const known = new Set(CHILD_CACHE_ARTIFACT_FILES);
  const digests = new Map([...parseManifest(bytes.toString("utf8"))].filter(([file, sha]) => known.has(file) && SHA256_HEX.test(sha)));
  return digests.size > 0 ? digests : "invalid";
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Every directory above the cache: owned by this user or root, writable by nobody else unless sticky (/tmp). */
function assertTrustedAncestors(home) {
  if (!POSIX) return;
  let dir = realpathSync(home);
  for (;;) {
    const st = lstatSync(dir);
    const owner = st.uid === currentUid() || st.uid === 0;
    const writers = (st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0;
    if (!st.isDirectory() || !owner || !writers) throw new Error("unsafe cache directory: " + dir);
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** A real directory (never a symlink) private to this user, created 0700 when missing; returns its identity. */
function realDirectory(path) {
  let st;
  try { st = lstatSync(path); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(path, { mode: 0o700 });
    st = lstatSync(path);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe cache directory: " + path);
  if (POSIX && (st.uid !== currentUid() || (st.mode & 0o022) !== 0)) throw new Error("unsafe cache directory: " + path);
  return { dev: st.dev, ino: st.ino };
}

function sameDirectory(path, identity) {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && st.dev === identity.dev && st.ino === identity.ino;
  } catch { return false; }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Exclusive private temp beside the target, then rename: a symlink at the name is replaced, never followed. */
function publish(dir, identity, name, bytes) {
  if (!sameDirectory(dir, identity)) throw new Error("cache directory changed");
  const temp = join(dir, ".ocx-child-cache." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (!sameDirectory(dir, identity)) { try { unlinkSync(temp); } catch { /* the directory moved away */ } throw new Error("cache directory changed"); }
  renameSync(temp, join(dir, name));
}

function unpublish(dir, identity, name) {
  if (!sameDirectory(dir, identity)) throw new Error("cache directory changed");
  try { unlinkSync(join(dir, name)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

/**
 * "<version>": that version's fill completed; "<version> baseline": that version ran and fetched
 * nothing (a first start, or a package without digests). null: absent or unreadable, no evidence.
 */
function readVersionRecord(dir) {
  let bytes;
  try { bytes = readRegular(join(dir, VERSION_RECORD), 256); } catch { return null; }
  const [version, kind, ...rest] = (bytes?.toString("utf8") ?? "").trim().split(/\s+/);
  if (!parseVersion(version) || rest.length > 0 || (kind !== undefined && kind !== "baseline")) return null;
  return { version, filled: kind === undefined };
}

/** The release builds verified on disk right now: what a manifest may list, whoever wrote them. */
function verifiedOnDisk(dir, digests) {
  const verified = new Map();
  for (const [file, expected] of digests) {
    const bytes = readCachedBuild(join(dir, file));
    if (bytes && sha256Hex(bytes) === expected) verified.set(file, expected);
  }
  return verified;
}

function readCacheManifest(dir) {
  return parseManifest((readRegular(join(dir, "SHA256SUMS"), MAX_MANIFEST_BYTES) ?? Buffer.alloc(0)).toString("utf8"));
}

/** A completed fill's manifest still lists every build the package vouches for. */
function manifestCovers(dir, digests) {
  let listed;
  try { listed = readCacheManifest(dir); } catch { return false; }
  return [...digests].every(([file, sha]) => listed.get(file) === sha);
}

/** An existing build the reader would accept: a non-empty regular file, never a symlink, writable only by this user. */
function readCachedBuild(path) {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > MAX_CHILD_BINARY_BYTES) return null;
  if (POSIX && (st.uid !== currentUid() || (st.mode & 0o022) !== 0)) return null;
  try { return readFileSync(path); } catch { return null; }
}

async function download(url, fetchImpl, timeoutMs) {
  let response;
  try { response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) }); } catch { return null; }
  if (!response.ok || !response.body) return null;
  if (Number(response.headers.get("content-length") ?? "0") > MAX_CHILD_BINARY_BYTES) {
    try { await response.body.cancel(); } catch { /* already closed */ }
    return null;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_CHILD_BINARY_BYTES) return null;
      chunks.push(chunk);
    }
  } catch { return null; }
  return Buffer.concat(chunks, size);
}

/** A cache directory for a version newer than this one: this Home was downgraded. */
function newerVersionCached(home, version) {
  let names;
  try { names = readdirSync(join(home, "cache", "ocx-child")); } catch { return false; }
  return names.some(name => compareReleaseVersions(name, version) === 1);
}

/** The package tree this module was loaded from: <root>/src/link/child-binary-cache-fill.mjs. */
export function runningPackageRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * Keeps Home processes sharing one OPENCODEX_HOME from downloading the same builds at once. It is an
 * optimisation, never the guarantee: two fills can still overlap after a stale lock is reclaimed, so
 * the manifest is rebuilt from what is verified on disk when it is written, and a completed record
 * whose manifest no longer covers the package's digests is repaired on the next start.
 */
const FILL_LOCK = ".fill.lock";
/** A fill takes at most a few minutes (five builds, 20 s each); an older lock is a crash's leftover. */
const STALE_LOCK_MS = 60 * 60 * 1000;

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function readLock(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 256) return null;
    const token = readFileSync(path, "utf8").trim();
    const pid = Number(token.split(".")[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? { token, pid, mtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}

function removeQuietly(path) {
  try { unlinkSync(path); } catch { /* already gone */ }
}

/**
 * The lock file appears whole or not at all (linked from a private temp), names "<pid>.<nonce>", and
 * is reclaimed only when its process is gone or it is older than STALE_LOCK_MS. null: another fill runs.
 */
function acquireFillLock(root, rootIdentity, now) {
  const path = join(root, FILL_LOCK);
  const token = process.pid + "." + randomBytes(8).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sameDirectory(root, rootIdentity)) throw new Error("cache directory changed");
    const temp = join(root, ".ocx-child-cache." + token + ".lock.tmp");
    const fd = openSync(temp, "wx", 0o600);
    try { writeSync(fd, token + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(temp, path); return { path, token }; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    finally { removeQuietly(temp); }
    const holder = readLock(path);
    if (holder && processAlive(holder.pid) && now() - holder.mtimeMs < STALE_LOCK_MS) return null;
    // Move the leftover aside, and put it back if a live fill took the lock in the meantime.
    const aside = join(root, ".ocx-child-cache." + token + ".stale.tmp");
    try { renameSync(path, aside); } catch { continue; }
    if (readLock(aside)?.token !== holder?.token) {
      try { linkSync(aside, path); } catch { /* a third fill holds it now */ }
      removeQuietly(aside);
      return null;
    }
    removeQuietly(aside);
  }
  return null;
}

function assertFillLockHeld(lock) {
  if (readLock(lock.path)?.token !== lock.token) throw new Error("cache fill lock lost");
}

function releaseFillLock(lock) {
  if (lock && readLock(lock.path)?.token === lock.token) removeQuietly(lock.path);
}

export async function fillChildBinaryCacheForVersion(options) {
  if (compareReleaseVersions(options.version, options.version) === null) return { kind: "skipped", reason: "invalid_version" };
  if ((options.platform ?? process.platform) === "win32") return { kind: "skipped", reason: "unsupported_platform" };
  const digests = readDigests(options.packageRoot);
  // A digest file that is there but unusable is not "no digests": the record stays, so a repair still fills.
  if (digests === "invalid") return { kind: "skipped", reason: "invalid_digests" };
  const home = options.opencodexHome || process.env.OPENCODEX_HOME?.trim() || join(process.env.HOME || homedir(), ".opencodex");
  const root = join(home, "cache", "ocx-child");
  let rootIdentity, lock = null, recorded;
  try {
    assertTrustedAncestors(home);
    if (newerVersionCached(home, options.version)) return { kind: "skipped", reason: "downgrade" };
    realDirectory(join(home, "cache"));
    rootIdentity = realDirectory(root);
    lock = acquireFillLock(root, rootIdentity, options.now ?? Date.now);
    if (!lock) return { kind: "skipped", reason: "busy" };
    recorded = readVersionRecord(root);
  } catch (error) {
    releaseFillLock(lock);
    // Without digests only the baseline record was at stake: stay silent, as before this lane.
    if (!digests) return { kind: "skipped", reason: "no_digests" };
    throw error;
  }
  try {
    const record = kind => { assertFillLockHeld(lock); publish(root, rootIdentity, VERSION_RECORD, Buffer.from(options.version + (kind === "baseline" ? " baseline" : "") + "\n")); };
    if (!digests) {
      // The baseline a later digest-bearing release needs to recognise its start as an upgrade.
      if (recorded === null || compareReleaseVersions(options.version, recorded.version) === 1) { try { record("baseline"); } catch { /* best effort */ } }
      return { kind: "skipped", reason: "no_digests" };
    }
    if (recorded === null) { record("baseline"); return { kind: "skipped", reason: "first_start" }; }
    const order = compareReleaseVersions(options.version, recorded.version);
    if (order === -1) return { kind: "skipped", reason: "downgrade" };
    const dir = childBinaryCacheDir(home, options.version);
    // The same version again: nothing to do, unless its completed fill lost manifest lines (overlapping fills).
    if (order === 0 && (!recorded.filled || manifestCovers(dir, digests))) return { kind: "skipped", reason: "not_an_upgrade" };
    const identity = realDirectory(dir);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const fetched = [];
    const failed = [];
    for (const [file, expected] of [...digests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const present = readCachedBuild(join(dir, file));
      if (present && sha256Hex(present) === expected) continue;
      const bytes = await download(childReleaseAssetUrl(options.version, file), fetchImpl, timeoutMs);
      if (bytes && sha256Hex(bytes) === expected) {
        publish(dir, identity, file, bytes);
        fetched.push(file);
      } else {
        failed.push(file);
      }
    }
    assertFillLockHeld(lock);
    // Rebuilt from the disk as it is now, so an overlapping fill's verified builds stay listed and a
    // build the release does not vouch for never stays under an older line (its file stays: it may be
    // an operator's, and unlisted the reader refuses it). Lines for builds the release does not list,
    // placed by hand, are kept.
    const verified = verifiedOnDisk(dir, digests);
    const manifest = new Map([...readCacheManifest(dir)].filter(([file]) => !digests.has(file)));
    for (const [file, sha] of verified) manifest.set(file, sha);
    if (manifest.size > 0) publish(dir, identity, "SHA256SUMS", Buffer.from([...manifest].map(([file, sha]) => sha + "  " + file + "\n").join("")));
    else unpublish(dir, identity, "SHA256SUMS");
    // An incomplete fill leaves the older record, so the next start of this version retries.
    if (verified.size === digests.size) record("filled");
    const cached = [...verified.keys()].sort();
    return { kind: "filled", cached, fetched, failed: failed.filter(file => !verified.has(file)) };
  } finally {
    releaseFillLock(lock);
  }
}

/** The running package's version, from its own package.json; null when unreadable. */
export function runningPackageVersion(packageRoot = runningPackageRoot()) {
  try {
    const parsed = JSON.parse(readRegular(join(packageRoot, "package.json"), MAX_MANIFEST_BYTES)?.toString("utf8") ?? "null");
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch { return null; }
}

/**
 * Startup step (src/server/index.ts): fill the cache for the running version in the background and
 * say what happened in one line. Never throws and never delays the server.
 */
export async function fillChildBinaryCacheOnStart(options = {}, out = { log: console.log, warn: console.warn }) {
  let outcome;
  const packageRoot = options.packageRoot ?? runningPackageRoot();
  const version = options.version ?? runningPackageVersion(packageRoot) ?? "";
  try {
    // A source checkout (a developer's server, the test suite) never fetches a release.
    if (detectInstallFromPath(packageRoot) === "source") return { kind: "skipped", reason: "source_checkout" };
    outcome = await fillChildBinaryCacheForVersion({ timeoutMs: 20_000, ...options, packageRoot, version });
  } catch {
    out.warn("[link] the ocx-child builds of this release could not be cached; planting on a bare machine needs a build supplied by hand.");
    return null;
  }
  if (outcome.kind === "filled") {
    const fetched = outcome.fetched.length;
    if (fetched > 0) out.log("[link] cached " + fetched + " verified ocx-child build" + (fetched === 1 ? "" : "s") + " for v" + version + ".");
    if (outcome.failed.length > 0) out.warn("[link] " + outcome.failed.length + " ocx-child build" + (outcome.failed.length === 1 ? "" : "s") + " of this release could not be fetched or did not match the package digests; only verified builds are planted.");
  }
  if (outcome.kind === "skipped" && outcome.reason === "invalid_digests") out.warn("[link] this package's ocx-child digest file could not be read; no ocx-child build was cached.");
  return outcome;
}
