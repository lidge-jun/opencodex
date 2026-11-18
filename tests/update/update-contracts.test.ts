import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseRootTransitionEnvelope, parseSignatureEnvelope, parseUpdateDocument } from "../../src/update/update-contracts.mjs";
import type { UpdateDocumentSchemas } from "../../src/update/update-contracts.mjs";
import { repoPath } from "../helpers/repo-root";

type Schema = keyof UpdateDocumentSchemas;
const h = "a".repeat(64);
const packet = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8, 4), Buffer.alloc(32, 7)]);
const fingerprint = createHash("sha256").update(packet.subarray(10)).digest("hex");
const publicKey = Buffer.from(`untrusted comment: fixture\n${packet.toString("base64")}\n`).toString("base64");
const vector = JSON.parse(readFileSync(repoPath("tests/fixtures/minisign/prehashed-vector.json"), "utf8"));
const box = Buffer.from(vector.signatureBox).toString("base64");
const digest = { sha256: h, size: 1 };
const key = { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey };
const token = Buffer.alloc(32, 9).toString("base64url");
const op = "12345678-1234-1234-1234-123456789abc";
const pairs = [["macos", "x64"], ["macos", "arm64"], ["windows", "x64"], ["linux", "x64"], ["linux", "arm64"]];
function makeTarget(platform: string, arch: string, owner: string, artifactKind: string, bundleKind: string, targetId: string) {
  const name = artifactKind === "tree" || artifactKind === "guardian" ? `ocx-update-1.2.3-latest-${targetId}${artifactKind === "tree" ? ".tar.gz" : ""}` : artifactKind === "standalone" ? `ocx-1.2.3-bun-${platform === "macos" ? "darwin" : platform}-${arch}.${platform === "windows" ? "zip" : "tar.gz"}` : `OpenCodex-1.2.3-${platform === "macos" ? "macos.app.tar.gz" : platform === "windows" ? "windows-x64.msi" : bundleKind === "deb" ? "linux-amd64.deb" : "linux-x86_64.AppImage"}`;
  return { id: targetId, platform, arch, owner, artifactKind, bundleKind, assetName: name, artifact: { ...digest, signatureBox: box, signerFingerprint: fingerprint }, tree: ["tree", "standalone"].includes(artifactKind) ? { ...digest } : null, capabilities: { ...digest } };
}
function targets() {
  const out = [];
  for (const [p, a] of pairs) {
    if (p === "macos") out.push(makeTarget(p, a, "desktop", "tauri", "app-tar-gz", `${p}-${a}-desktop-tauri`));
    if (p === "windows") out.push(makeTarget(p, a, "desktop", "tauri", "msi", `${p}-${a}-desktop-tauri`));
    if (p === "linux" && a === "x64") for (const b of ["appimage", "deb"]) out.push(makeTarget(p, a, "desktop", "tauri", b, `${p}-${a}-desktop-${b}`));
    out.push(makeTarget(p, a, "standalone", "standalone", p === "windows" ? "zip" : "tar-gz", `${p}-${a}-standalone`));
    for (const owner of ["npm", "pnpm", "bun"]) out.push(makeTarget(p, a, owner, "tree", "tar-gz", `${p}-${a}-${owner}`));
    if (!(p === "linux" && a === "arm64")) out.push(makeTarget(p, a, "desktop", "guardian", "binary", `${p}-${a}-desktop-guardian`));
    out.push(makeTarget(p, a, "standalone", "guardian", "binary", `${p}-${a}-standalone-guardian`));
  }
  return out;
}
function fixtures(): Record<Schema, any> {
  return {
    "ocx.update.root/1": {schema: "ocx.update.root/1", revision: 1, expiresAt: "2000-02-29T12:00:00Z", rootKeys: [key], rootThreshold: 1, releaseKeys: [{...key, channels: ["latest"], roles: ["release", "tree", "desktop-artifact", "standalone-artifact", "guardian-artifact"]}], releaseThreshold: 1, channels: ["latest"]},
    "ocx.update.signatures/1": {schema: "ocx.update.signatures/1", signatures: [{keyFingerprint: fingerprint, signatureBox: box}]},
    "ocx.update.root-transition-signatures/1": {schema: "ocx.update.root-transition-signatures/1", signatures: [{keyFingerprint: fingerprint, signatureBox: box}]},
    "ocx.update.release/1": {schema: "ocx.update.release/1", version: "1.2.3", channel: "latest", sequence: 1, sourceCommit: "b".repeat(40), rolloutNotBefore: "2028-02-29T00:00:00Z", receipt: {...digest}, releaseNotes: [{title: "title", body: "body"}], targets: targets()},
    "ocx.update.verification/1": {schema: "ocx.update.verification/1", sourceCommit: "b".repeat(40), version: "1.2.3", channel: "latest", workflowRunId: 1, workflowAttempt: 1, versionSources: ["package.json", "desktop/src-tauri/tauri.conf.json", "desktop/src-tauri/Cargo.toml", "desktop/src-tauri/Cargo.lock"].map(path => ({path, sha256: h})), assets: [{name: "a", ...digest}, {name: "b", ...digest}], universalProofs: [{assetName: "a", artifactSha256: h, architectures: ["arm64", "x64"], inspectionSha256: h}], architectureProofs: [{targetId: "linux-x64-npm", assetName: "b", artifactSha256: h, arch: "x64", inspectionSha256: h}]},
    "ocx.update.tree/1": {schema: "ocx.update.tree/1", version: "1.2.3", target: "linux-x64-npm", entries: [{path: "bin", type: "directory", mode: 493}, {path: "bin/a", type: "file", mode: 420, size: 0, sha256: h}, {path: "bin/link", type: "symlink", target: "../bin/a"}]},
    "ocx.link-capabilities/1": {schema: "ocx.link-capabilities/1", version: "1.2.3", channel: "latest", target: "linux-x64-npm", artifactSha256: h, homeProvides: [{id: "proto", version: 1}], childRequires: [], updateActions: [], installerAdapters: [], recoveryProtocols: [], fleetJournalReaders: [], compatibilityEpoch: 1, compatibilityVectorSha256: h},
    "ocx.update.policy/1": {schema: "ocx.update.policy/1", revision: 0, channel: "latest", check: "manual", download: "manual", install: "manual"},
    "ocx.update.prepared/1": {schema: "ocx.update.prepared/1", operationId: op, candidateDigest: h, stageIdentity: token, stageDigest: h, installationId: "install-1", ownerKind: "desktop", policyRevision: 0},
    "ocx.update.activation/1": {schema: "ocx.update.activation/1", action: "reserve", operationId: op, generation: 1, runtimeInstance: "runtime-1", pid: 1, port: 1, installationId: "install-1", ownerKind: "service", candidateDigest: h, stageDigest: h, policyRevision: 0, deadlineMs: 0},
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const parse = (value: any) => parseUpdateDocument(bytes(value), value.schema as Schema);
const reject = (value: any) => expect(() => parse(value)).toThrow();

describe("closed unverified update contracts", () => {
  test("all schemas parse including the complete 34-target table and expired root", () => {
    const all = fixtures();
    expect(all["ocx.update.release/1"].targets).toHaveLength(34);
    for (const value of Object.values(all)) {
      expect(parse(value).schema).toBe(value.schema);
      reject({...value, unexpected: true});
      const { schema: _schema, ...missing } = value;
      expect(() => parseUpdateDocument(bytes(missing), value.schema)).toThrow();
    }
    expect(parseSignatureEnvelope(bytes(all["ocx.update.signatures/1"])).signatures).toHaveLength(1);
  });
  test("expected schema determines the immutable raw byte cap", () => {
    const caps: Record<Schema, number> = {"ocx.update.root/1":65536, "ocx.update.signatures/1":65536, "ocx.update.root-transition-signatures/1":262144, "ocx.update.release/1":1048576, "ocx.update.verification/1":1048576, "ocx.update.tree/1":16777216, "ocx.link-capabilities/1":1048576, "ocx.update.policy/1":4096, "ocx.update.prepared/1":8192, "ocx.update.activation/1":8192};
    for (const [schema, value] of Object.entries(fixtures()) as [Schema, any][]) {
      const raw = bytes(value); const exact = Buffer.concat([raw, Buffer.alloc(caps[schema] - raw.length, 32)]);
      expect(parseUpdateDocument(exact, schema).schema).toBe(schema);
      expect(() => Reflect.apply(parseUpdateDocument, null, [Buffer.concat([exact, Buffer.from(" ")]), schema, 999999999])).toThrow();
    }
    expect(() => parseUpdateDocument(bytes(fixtures()["ocx.update.policy/1"]), "ocx.update.tree/1")).toThrow();
    expect(() => Reflect.apply(parseUpdateDocument, null, [Buffer.from("{}"), "__proto__"])).toThrow();
    const release = fixtures()["ocx.update.release/1"];
    const policyBytes = bytes(fixtures()["ocx.update.policy/1"]);
    const oversizedPolicy = Buffer.concat([policyBytes, Buffer.alloc(4097 - policyBytes.length, 32)]);
    Object.defineProperty(oversizedPolicy, "byteLength", { value: 0 });
    expect(() => parseUpdateDocument(oversizedPolicy, "ocx.update.policy/1")).toThrow();
    release.releaseNotes = [{title: "é", body: "é"}];
    const raw = bytes(release);
    const exact = Buffer.concat([raw, Buffer.alloc(1048576 - raw.length, 32)]);
    expect(parseUpdateDocument(exact, release.schema).schema).toBe(release.schema);
    expect(() => parseUpdateDocument(Buffer.concat([exact, Buffer.from(" ")]), release.schema)).toThrow();
    release.releaseNotes = [{title: "é".repeat(8192), body: "x".repeat(16384)}]; expect(parse(release)).toBeDefined();
    release.releaseNotes[0].title += "x"; reject(release);
  });
  test("invalid JSON, UTF-8, decoded duplicate names, numbers and unknown fields refuse", () => {
    const p = fixtures()["ocx.update.policy/1"]; const raw = JSON.stringify(p);
    for (const broken of [raw.replace('"revision":0', '"revision":0,"revis\\u0069on":1'), raw.replace('"revision":0', '"revision":-0'), raw.replace('"revision":0', '"revision":9007199254740992'), raw.replace('"revision":0', '"revision":1.0'), raw.replace('"latest"', '"\\ud800"'), `${raw}x`, `\ufeff${raw}`]) expect(() => parseUpdateDocument(Buffer.from(broken), p.schema)).toThrow();
    expect(() => parseUpdateDocument(Buffer.from([0xc0, 0x80]), p.schema)).toThrow();
    reject({...p, extra: true}); reject({...p, revision: "0"}); reject({...p, channel: "unknown"});
    const release = fixtures()["ocx.update.release/1"];
    reject({...release, sourceCommit: `${release.sourceCommit}\n`});
    const prepared = fixtures()["ocx.update.prepared/1"];
    reject({...prepared, operationId: `${prepared.operationId}\n`});
    reject({...prepared, installationId: `${prepared.installationId}\n`});
    reject({...prepared, candidateDigest: `${prepared.candidateDigest}\n`});
  });
  test("root validates key identities, delegations, threshold and calendar", () => {
    const r = fixtures()["ocx.update.root/1"];
    for (const date of ["2027-02-29T00:00:00Z", "2028-01-01T00:00:60Z", "2028-01-01T00:00:00+00:00"]) reject({...r, expiresAt: date});
    reject({...r, rootThreshold: 2}); reject({...r, releaseThreshold: 2}); reject({...r, rootKeys: [key, key]});
    reject({...r, rootKeys: [{...key, keyId: h}]}); reject({...r, channels: ["latest", "latest"]});
    reject({...r, releaseKeys: [{...r.releaseKeys[0], roles: ["tree"]}]});
  });
  test("signature envelope rejects noncanonical encodings and duplicate fingerprints", () => {
    const e = fixtures()["ocx.update.signatures/1"];
    const entries = Array.from({ length: 33 }, (_, i) => ({ keyFingerprint: i.toString(16).padStart(64, "0"), signatureBox: box }));
    const transition = { schema: "ocx.update.root-transition-signatures/1", signatures: entries.slice(0, 32) };
    expect(parse(transition).signatures).toHaveLength(32);
    expect(parseRootTransitionEnvelope(bytes(transition)).signatures).toHaveLength(32);
    reject({ ...transition, signatures: entries });
    reject({ ...e, signatures: entries.slice(0, 17) });
    expect(() => parseSignatureEnvelope(bytes(transition))).toThrow();
    expect(() => parseUpdateDocument(bytes(e), "ocx.update.root-transition-signatures/1")).toThrow();
    expect(() => parseRootTransitionEnvelope(bytes(e))).toThrow();
    reject({...e, signatures: [e.signatures[0], e.signatures[0]]});
    reject({...e, signatures: [{...e.signatures[0], signatureBox: `${box}\n`}]});
    reject({...e, signatures: [{...e.signatures[0], signatureBox: Buffer.from("bad").toString("base64")}]});
  });
  test("release target tuple, names, numeric and size boundaries", () => {
    const r = fixtures()["ocx.update.release/1"];
    reject({...r, targets: [...r.targets, r.targets[0]]}); reject({...r, targets: Array(65).fill(r.targets[0])});
    reject({...r, targets: [{...r.targets[0], assetName: "wrong"}]}); reject({...r, targets: [{...r.targets[0], bundleKind: "zip"}]});
    reject({...r, targets: [{...r.targets[0], tree: {...digest}}]}); reject({...r, sequence: 0});
    for (const v of ["v1.2.3", "01.2.3", "18446744073709551616.0.0", "1.2.3-01"]) reject({...r, version: v});
    const build = {...r, version: "1.2.3+build", targets: [{...r.targets[0], assetName: "OpenCodex-1.2.3+build-macos.app.tar.gz"}]}; expect(parse(build)).toBeDefined();
    const one = {...r, targets: [r.targets[0]], version: "18446744073709551615.0.0"};
    one.targets = [{...one.targets[0], assetName: "OpenCodex-18446744073709551615.0.0-macos.app.tar.gz"}]; expect(parse(one)).toBeDefined();
  });
  test("receipt shapes, version authority and ordered assets", () => {
    const r = fixtures()["ocx.update.verification/1"];
    reject({...r, versionSources: [r.versionSources[0], r.versionSources[0], ...r.versionSources.slice(2)]});
    reject({...r, assets: [...r.assets].reverse()}); reject({...r, assets: [r.assets[0], r.assets[0]]});
    reject({...r, universalProofs: [{...r.universalProofs[0], architectures: ["x64", "arm64"]}]});
    reject({...r, architectureProofs: [{...r.architectureProofs[0], arch: "other"}]});
    for (const field of ["assets", "universalProofs", "architectureProofs"]) {
      const nameKey = field === "assets" ? "name" : "assetName";
      const entry = r[field][0];
      expect(parse({...r, [field]: [{...entry, [nameKey]: "a".repeat(255)}]})).toBeDefined();
      reject({...r, [field]: [{...entry, [nameKey]: "a".repeat(256)}]});
      reject({...r, [field]: [{...entry, [nameKey]: "a/b"}]});
    }
    reject({...r, architectureProofs: [{...r.architectureProofs[0], targetId: "a".repeat(129)}]});
  });
  test("tree inventory is physical, requires real directory parents and accepts relative links", () => {
    const t = fixtures()["ocx.update.tree/1"];
    for (const bad of ["../a", "/a", "C:a", "a\\b", "a//b", "a/./b"]) reject({...t, entries: [{path: bad, type: "directory", mode: 0}]});
    reject({...t, entries: [t.entries[1]]}); reject({...t, entries: [t.entries[0], t.entries[0]]});
    reject({...t, entries: [{path: "bin", type: "symlink", target: ".."}, t.entries[1]]});
    reject({...t, entries: [{path: "x", type: "symlink", target: "/escape"}]});
    reject({...t, entries: [{...t.entries[0], mode: 512}]});
    expect(parse({...t, entries: [{path: "Å", type: "directory", mode: 0}, {path: "a", type: "symlink", target: "../outside"}]})).toBeDefined();
  });
  test("capabilities and all activation actions enforce exact discriminants", () => {
    const c = fixtures()["ocx.link-capabilities/1"];
    reject({...c, homeProvides: [c.homeProvides[0], c.homeProvides[0]]}); reject({...c, compatibilityEpoch: 0});
    const p = fixtures()["ocx.update.prepared/1"]; reject({...p, stageIdentity: "x".repeat(43)}); reject({...p, ownerKind: "npm"});
    const a = fixtures()["ocx.update.activation/1"];
    for (const action of ["reserve", "inspect"]) { expect(parse({...a, action})).toBeDefined(); reject({...a, action, permit: token}); }
    for (const action of ["commit", "cancel"]) { reject({...a, action}); expect(parse({...a, action, permit: token})).toBeDefined(); }
    reject({...a, generation: 0}); reject({...a, pid: 2147483648}); reject({...a, port: 65536}); reject({...a, candidateDigest: ""});
  });
  test("large legal inventory and capability arrays remain bounded", () => {
    const t = fixtures()["ocx.update.tree/1"]; t.entries = Array.from({length: 4096}, (_, i) => ({path: `file-${i}`, type: "file", mode: 0, size: 0, sha256: h})); expect(parse(t)).toBeDefined();
    t.entries.push({path: "extra", type: "directory", mode: 0}); reject(t);
    const c = fixtures()["ocx.link-capabilities/1"];
    for (const field of ["homeProvides", "childRequires", "updateActions", "installerAdapters", "recoveryProtocols", "fleetJournalReaders"]) c[field] = Array.from({length: 4096}, (_, i) => ({id: `p${i}`, version: 1}));
    expect(parse(c)).toBeDefined(); c.homeProvides.push({id: "overflow", version: 1}); reject(c);
    const r = fixtures()["ocx.update.verification/1"];
    r.assets = Array.from({length: 4096}, (_, i) => ({name: `asset-${String(i).padStart(4, "0")}`, sha256: h, size: 1}));
    expect(parse(r)).toBeDefined(); r.assets.push({name: "overflow", sha256: h, size: 1}); reject(r);
  });
});
