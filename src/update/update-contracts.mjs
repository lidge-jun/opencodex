// These parsers validate wire shape only. Their results are not authenticated.
import { parseBoundedJson } from "./update-bounded-json.mjs";
import { decodePublicKey } from "./minisign.mjs";
import { sameSignedVersion } from "./update-signed-version.mjs";

const CAPS = Object.freeze({
  "ocx.update.root/1": 65536, "ocx.update.signatures/1": 65536,
  "ocx.update.root-transition-signatures/1": 262144,
  "ocx.update.release/1": 1048576, "ocx.update.verification/1": 1048576,
  "ocx.update.tree/1": 16777216, "ocx.link-capabilities/1": 1048576,
  "ocx.update.policy/1": 4096, "ocx.update.prepared/1": 8192,
  "ocx.update.activation/1": 8192,
});
const CHANNELS = ["latest", "preview", "nightly"];
const ROLES = ["release", "tree", "desktop-artifact", "standalone-artifact", "guardian-artifact"];
const OWNERS = ["desktop", "service", "unmanaged"];
const HASH = /^[a-f0-9]{64}$/;
const ASCII_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const VERSION_PATHS = ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"];
const FAIL = () => { throw new Error("Invalid update document"); };
const text = (v, max = 4096) => typeof v === "string" && Buffer.byteLength(v, "utf8") <= max;
const id = (v) => text(v, 128) && ASCII_ID.test(v);
const assetName = (v) => text(v, 255) && ASCII_ID.test(v);
const hash = (v) => typeof v === "string" && HASH.test(v);
const integer = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const oneOf = (v, values) => values.includes(v);
const version = (v) => typeof v === "string" && sameSignedVersion(v, v);
const obj = (v, keys) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const array = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max;
const unique = (values) => new Set(values).size === values.length;
const enumSet = (v, options) => array(v, 1, options.length) && unique(v) && v.every((x) => oneOf(x, options));
const exact = (condition) => { if (!condition) FAIL(); };
const validDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(v)) return false;
  const time = Date.parse(v);
  return Number.isFinite(time) && new Date(time).toISOString() === v.replace("Z", ".000Z");
};
function base64(v, max) {
  if (typeof v !== "string" || !v || v.length > Math.ceil(max / 3) * 4) FAIL();
  const b = Buffer.from(v, "base64");
  exact(b.length <= max && b.toString("base64") === v);
  return b;
}
function utf8(b) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b); } catch { return FAIL(); }
}
function signature(v) {
  const s = utf8(base64(v, 4096));
  const lines = s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  exact(lines.length === 4 && lines[0].startsWith("untrusted comment: ")
    && lines[2].startsWith("trusted comment: ") && !s.replace(/\r\n/g, "").includes("\r"));
  const packet = base64(lines[1], 74);
  exact(packet.length === 74 && packet.subarray(0, 2).toString() === "ED" && base64(lines[3], 64).length === 64);
}
function key(v, release) {
  exact(obj(v, release ? ["keyId", "algorithm", "publicKey", "channels", "roles"] : ["keyId", "algorithm", "publicKey"]));
  exact(hash(v.keyId) && v.algorithm === "minisign-ed25519-blake2b512/1");
  const box = utf8(base64(v.publicKey, 4096));
  let decoded;
  try { decoded = decodePublicKey(box); } catch { FAIL(); }
  exact(decoded.fingerprint === v.keyId);
  if (release) exact(enumSet(v.channels, CHANNELS) && enumSet(v.roles, ROLES));
}
function root(v) {
  exact(obj(v, ["schema", "revision", "expiresAt", "rootKeys", "rootThreshold", "releaseKeys", "releaseThreshold", "channels"]));
  exact(integer(v.revision, 1) && validDate(v.expiresAt) && enumSet(v.channels, CHANNELS));
  exact(array(v.rootKeys, 1, 16) && array(v.releaseKeys, 1, 16));
  v.rootKeys.forEach((x) => key(x, false)); v.releaseKeys.forEach((x) => key(x, true));
  exact(unique(v.rootKeys.map((x) => x.keyId)) && unique(v.releaseKeys.map((x) => x.keyId)));
  exact(integer(v.rootThreshold, 1, v.rootKeys.length) && integer(v.releaseThreshold, 1, 16));
  for (const channel of v.channels) {
    for (const role of ROLES) {
      const count = v.releaseKeys.filter((k) => k.channels.includes(channel) && k.roles.includes(role)).length;
      if (count || role === "release") exact(count >= v.releaseThreshold);
    }
  }
}
function envelope(v, limit = 16) {
  exact(obj(v, ["schema", "signatures"]) && array(v.signatures, 1, limit));
  for (const entry of v.signatures) {
    exact(obj(entry, ["keyFingerprint", "signatureBox"]) && hash(entry.keyFingerprint)); signature(entry.signatureBox);
  }
  exact(unique(v.signatures.map((x) => x.keyFingerprint)));
}
function digestSize(v, max) {
  exact(obj(v, ["sha256", "size"]) && hash(v.sha256) && integer(v.size, 1, max));
}
const platforms = [["macos", "x64"], ["macos", "arm64"], ["windows", "x64"], ["linux", "x64"], ["linux", "arm64"]];
function targetTuple(t) {
  const { platform: p, arch: a, owner: o, artifactKind: k, bundleKind: b } = t;
  if (!platforms.some(([x, y]) => x === p && y === a)) return null;
  const prefix = `${p}-${a}`;
  if (o === "desktop" && k === "tauri") {
    if (p === "macos" && b === "app-tar-gz") return `${prefix}-desktop-tauri`;
    if (p === "windows" && b === "msi") return `${prefix}-desktop-tauri`;
    if (p === "linux" && a === "x64" && (b === "appimage" || b === "deb")) return `${prefix}-desktop-${b}`;
  }
  if (o === "standalone" && k === "standalone" && b === (p === "windows" ? "zip" : "tar-gz")) return `${prefix}-standalone`;
  if (["npm", "pnpm", "bun"].includes(o) && k === "tree" && b === "tar-gz") return `${prefix}-${o}`;
  if (k === "guardian" && b === "binary" && (o === "standalone" || (o === "desktop" && !(p === "linux" && a === "arm64")))) return `${prefix}-${o}-guardian`;
  return null;
}
function expectedAsset(t, ver, channel) {
  if (t.artifactKind === "guardian" || t.artifactKind === "tree") return `ocx-update-${ver}-${channel}-${t.id}${t.artifactKind === "tree" ? ".tar.gz" : ""}`;
  if (t.artifactKind === "standalone") return `ocx-${ver}-bun-${t.platform === "macos" ? "darwin" : t.platform}-${t.arch}.${t.platform === "windows" ? "zip" : "tar.gz"}`;
  const suffix = t.platform === "macos" ? "macos.app.tar.gz" : t.platform === "windows" ? "windows-x64.msi" : t.bundleKind === "deb" ? "linux-amd64.deb" : "linux-x86_64.AppImage";
  return `OpenCodex-${ver}-${suffix}`;
}
function target(t, ver, channel) {
  exact(obj(t, ["id", "platform", "arch", "owner", "artifactKind", "bundleKind", "assetName", "artifact", "tree", "capabilities"]));
  exact(id(t.id) && t.id === targetTuple(t) && assetName(t.assetName) && t.assetName === expectedAsset(t, ver, channel));
  exact(obj(t.artifact, ["sha256", "size", "signatureBox", "signerFingerprint"]) && hash(t.artifact.sha256) && hash(t.artifact.signerFingerprint) && integer(t.artifact.size, 1, 1073741824));
  signature(t.artifact.signatureBox);
  if (t.artifactKind === "tauri" || t.artifactKind === "guardian") exact(t.tree === null); else digestSize(t.tree, 16777216);
  digestSize(t.capabilities, 1048576);
}
function release(v) {
  exact(obj(v, ["schema", "version", "channel", "sequence", "sourceCommit", "rolloutNotBefore", "receipt", "releaseNotes", "targets"]));
  exact(version(v.version) && oneOf(v.channel, CHANNELS) && integer(v.sequence, 1) && typeof v.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(v.sourceCommit) && validDate(v.rolloutNotBefore));
  digestSize(v.receipt, 1048576);
  exact(array(v.releaseNotes, 0, 256));
  for (const n of v.releaseNotes) exact(obj(n, ["title", "body"]) && text(n.title, 16384) && text(n.body, 16384));
  exact(array(v.targets, 1, 64)); v.targets.forEach((t) => target(t, v.version, v.channel));
  exact(unique(v.targets.map((t) => t.id)));
}
function receipt(v) {
  exact(obj(v, ["schema", "sourceCommit", "version", "channel", "workflowRunId", "workflowAttempt", "versionSources", "assets", "universalProofs", "architectureProofs"]));
  exact(version(v.version) && oneOf(v.channel, CHANNELS) && typeof v.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(v.sourceCommit) && integer(v.workflowRunId, 1) && integer(v.workflowAttempt, 1));
  exact(array(v.versionSources, 4, 4));
  for (const x of v.versionSources) exact(obj(x, ["path", "sha256"]) && VERSION_PATHS.includes(x.path) && hash(x.sha256));
  exact(unique(v.versionSources.map((x) => x.path)) && array(v.assets, 1, 4096));
  for (const x of v.assets) exact(obj(x, ["name", "sha256", "size"]) && assetName(x.name) && hash(x.sha256) && integer(x.size, 1));
  exact(v.assets.every((x, i) => i === 0 || v.assets[i - 1].name < x.name));
  exact(array(v.universalProofs, 0, 4096) && array(v.architectureProofs, 0, 4096));
  for (const x of v.universalProofs) exact(obj(x, ["assetName", "artifactSha256", "architectures", "inspectionSha256"]) && assetName(x.assetName) && hash(x.artifactSha256) && hash(x.inspectionSha256) && array(x.architectures, 2, 2) && x.architectures[0] === "arm64" && x.architectures[1] === "x64");
  for (const x of v.architectureProofs) exact(obj(x, ["targetId", "assetName", "artifactSha256", "arch", "inspectionSha256"]) && id(x.targetId) && assetName(x.assetName) && hash(x.artifactSha256) && hash(x.inspectionSha256) && oneOf(x.arch, ["x64", "arm64"]));
  exact(unique(v.universalProofs.map((x) => JSON.stringify([x.assetName, x.artifactSha256, x.architectures, x.inspectionSha256])))
    && unique(v.architectureProofs.map((x) => JSON.stringify([x.targetId, x.assetName, x.artifactSha256, x.arch, x.inspectionSha256]))));
}
function path(v) {
  return text(v, 1024) && v.length > 0 && !v.includes("\\") && !v.includes("\0") && !v.startsWith("/") && !/^[A-Za-z]:/.test(v) && v.split("/").every((x) => x && x !== "." && x !== "..");
}
function linkTarget(v) {
  return text(v, 1024) && v.length > 0 && !v.includes("\\") && !v.includes("\0") && !v.startsWith("/") && !/^[A-Za-z]:/.test(v);
}
function tree(v) {
  exact(obj(v, ["schema", "version", "target", "entries"]) && version(v.version) && id(v.target) && array(v.entries, 0, 4096));
  const paths = new Map();
  for (const e of v.entries) {
    exact(e && typeof e === "object" && path(e.path) && !paths.has(e.path));
    if (e.type === "file") exact(obj(e, ["path", "type", "mode", "size", "sha256"]) && integer(e.mode, 0, 511) && integer(e.size, 0, 1073741824) && hash(e.sha256));
    else if (e.type === "directory") exact(obj(e, ["path", "type", "mode"]) && integer(e.mode, 0, 511));
    else if (e.type === "symlink") exact(obj(e, ["path", "type", "target"]) && linkTarget(e.target));
    else FAIL();
    paths.set(e.path, e.type);
  }
  for (const name of paths.keys()) {
    const separator = name.lastIndexOf("/");
    if (separator !== -1) exact(paths.get(name.slice(0, separator)) === "directory");
  }
}
function capability(v) {
  const fields = ["homeProvides", "childRequires", "updateActions", "installerAdapters", "recoveryProtocols", "fleetJournalReaders"];
  exact(obj(v, ["schema", "version", "channel", "target", "artifactSha256", ...fields, "compatibilityEpoch", "compatibilityVectorSha256"]));
  exact(version(v.version) && oneOf(v.channel, CHANNELS) && id(v.target) && hash(v.artifactSha256) && hash(v.compatibilityVectorSha256) && integer(v.compatibilityEpoch, 1));
  for (const field of fields) {
    const a = v[field]; exact(array(a, 0, 4096));
    for (const x of a) exact(obj(x, ["id", "version"]) && id(x.id) && integer(x.version, 1));
    exact(unique(a.map((x) => `${x.id}\0${x.version}`)));
  }
}
function policy(v) {
  exact(obj(v, ["schema", "revision", "channel", "check", "download", "install"]) && integer(v.revision, 0) && oneOf(v.channel, CHANNELS) && oneOf(v.check, ["automatic", "manual"]) && oneOf(v.download, ["automatic", "manual"]) && oneOf(v.install, ["manual", "on-quit", "when-idle"]));
}
function token(v) {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  const b = Buffer.from(v, "base64url"); return b.length === 32 && b.toString("base64url") === v;
}
function identity(v) { return typeof v === "string" && UUID.test(v); }
function prepared(v) {
  exact(obj(v, ["schema", "operationId", "candidateDigest", "stageIdentity", "stageDigest", "installationId", "ownerKind", "policyRevision"]) && identity(v.operationId) && hash(v.candidateDigest) && token(v.stageIdentity) && hash(v.stageDigest) && id(v.installationId) && oneOf(v.ownerKind, OWNERS) && integer(v.policyRevision, 0));
}
function activation(v) {
  const fields = ["schema", "action", "operationId", "generation", "runtimeInstance", "pid", "port", "installationId", "ownerKind", "candidateDigest", "stageDigest", "policyRevision", "deadlineMs"];
  const permit = v && (v.action === "commit" || v.action === "cancel");
  exact(obj(v, permit ? [...fields, "permit"] : fields) && oneOf(v.action, ["reserve", "inspect", "commit", "cancel"]) && identity(v.operationId) && integer(v.generation, 1) && id(v.runtimeInstance) && integer(v.pid, 1, 2147483647) && integer(v.port, 1, 65535) && id(v.installationId) && oneOf(v.ownerKind, OWNERS) && hash(v.candidateDigest) && hash(v.stageDigest) && integer(v.policyRevision, 0) && integer(v.deadlineMs, 0) && (!permit || token(v.permit)));
}
const VALIDATORS = Object.freeze({
  "ocx.update.root/1": root, "ocx.update.signatures/1": envelope,
  "ocx.update.root-transition-signatures/1": (value) => envelope(value, 32),
  "ocx.update.release/1": release, "ocx.update.verification/1": receipt,
  "ocx.update.tree/1": tree, "ocx.link-capabilities/1": capability,
  "ocx.update.policy/1": policy, "ocx.update.prepared/1": prepared,
  "ocx.update.activation/1": activation,
});
/** Parse a closed schema as unverified data; this does not authenticate it. */
export function parseUpdateDocument(bytes, expectedSchema) {
  if (typeof expectedSchema !== "string" || !Object.hasOwn(CAPS, expectedSchema)) FAIL();
  const value = parseBoundedJson(bytes, CAPS[expectedSchema]);
  exact(value !== null && typeof value === "object" && !Array.isArray(value) && value.schema === expectedSchema);
  VALIDATORS[expectedSchema](value);
  return value;
}
export function parseSignatureEnvelope(bytes) { return parseUpdateDocument(bytes, "ocx.update.signatures/1"); }
export function parseRootTransitionEnvelope(bytes) { return parseUpdateDocument(bytes, "ocx.update.root-transition-signatures/1"); }
