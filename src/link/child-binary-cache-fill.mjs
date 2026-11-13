// Plain ESM shared by the Node launcher (bin/ocx.mjs) and the Bun updater (src/update/index.ts):
// the launcher runs under Node and cannot import TypeScript. Types: child-binary-cache-fill.d.mts.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
 * fetched without that file, from a source checkout, or without evidence of an upgrade:
 * cache/ocx-child/.home-version records the last version whose fill completed, and only a running
 * version newer than it fills. A first start (no record: a fresh install) records its version and
 * fetches nothing, a restart of the same version fetches nothing, and a record or cache directory for
 * a newer version means a downgrade. A listed build that cannot be verified loses its manifest line,
 * so it can never stay trusted under an older manifest, but its file is left in place (it may be an
 * operator's); the record stays behind until every listed build is verified, so the next start retries.
 *
 * Nobody else can substitute a build: on POSIX each of cache, cache/ocx-child and the version
 * directory must be a real directory (never a symlink; created 0700 when missing) owned by this user
 * and writable by nobody else, and every directory above them must be owned by this user or root and
 * writable by nobody else unless sticky. Every write re-checks the target directory's identity, so a
 * directory swapped in during a download receives nothing. (On Windows the profile's ACLs stand in for
 * the mode checks; only the symlink and identity checks apply.)
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

function readDigests(packageRoot) {
  let bytes;
  try { bytes = readRegular(join(packageRoot, CHILD_RELEASE_DIGESTS_PATH), MAX_MANIFEST_BYTES); } catch { return null; }
  if (!bytes || bytes.byteLength === 0) return null;
  const known = new Set(CHILD_CACHE_ARTIFACT_FILES);
  const digests = new Map([...parseManifest(bytes.toString("utf8"))].filter(([file, sha]) => known.has(file) && SHA256_HEX.test(sha)));
  return digests.size > 0 ? digests : null;
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

/** The last version whose fill completed, or null (absent or unreadable: no evidence of an upgrade). */
function readVersionRecord(dir) {
  let bytes;
  try { bytes = readRegular(join(dir, VERSION_RECORD), 256); } catch { return null; }
  const value = bytes?.toString("utf8").trim() ?? "";
  return parseVersion(value) ? value : null;
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

export async function fillChildBinaryCacheForVersion(options) {
  if (compareReleaseVersions(options.version, options.version) === null) return { kind: "skipped", reason: "invalid_version" };
  const digests = readDigests(options.packageRoot);
  if (!digests) return { kind: "skipped", reason: "no_digests" };
  const home = options.opencodexHome || process.env.OPENCODEX_HOME?.trim() || join(process.env.HOME || homedir(), ".opencodex");
  assertTrustedAncestors(home);
  if (newerVersionCached(home, options.version)) return { kind: "skipped", reason: "downgrade" };
  realDirectory(join(home, "cache"));
  const root = join(home, "cache", "ocx-child");
  const rootIdentity = realDirectory(root);
  const recorded = readVersionRecord(root);
  const record = () => publish(root, rootIdentity, VERSION_RECORD, Buffer.from(options.version + "\n"));
  if (recorded === null) { record(); return { kind: "skipped", reason: "first_start" }; }
  const order = compareReleaseVersions(options.version, recorded);
  if (order === -1) return { kind: "skipped", reason: "downgrade" };
  if (order === 0) return { kind: "skipped", reason: "not_an_upgrade" };
  const dir = childBinaryCacheDir(home, options.version);
  const identity = realDirectory(dir);
  // Entries the release does not list (a build an operator placed by hand) keep their lines.
  const manifest = new Map([...parseManifest((readRegular(join(dir, "SHA256SUMS"), MAX_MANIFEST_BYTES) ?? Buffer.alloc(0)).toString("utf8"))]
    .filter(([file]) => !digests.has(file)));
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const cached = [];
  const fetched = [];
  const failed = [];
  for (const [file, expected] of [...digests].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let present = null;
    try { present = readRegular(join(dir, file), MAX_CHILD_BINARY_BYTES); } catch { present = null; }
    if (present && sha256Hex(present) === expected) { manifest.set(file, expected); cached.push(file); continue; }
    const bytes = await download(childReleaseAssetUrl(options.version, file), fetchImpl, timeoutMs);
    if (bytes && sha256Hex(bytes) === expected) {
      publish(dir, identity, file, bytes);
      manifest.set(file, expected);
      cached.push(file);
      fetched.push(file);
    } else {
      // Never leave a build the current release does not vouch for under an older manifest line;
      // the file itself stays (it may be an operator's), unlisted, so the reader refuses it.
      failed.push(file);
    }
  }
  if (manifest.size > 0) publish(dir, identity, "SHA256SUMS", Buffer.from([...manifest].map(([file, sha]) => sha + "  " + file + "\n").join("")));
  else unpublish(dir, identity, "SHA256SUMS");
  // An incomplete fill leaves the older record, so the next start of this version retries.
  if (failed.length === 0) record();
  return { kind: "filled", cached, fetched, failed };
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
  return outcome;
}
