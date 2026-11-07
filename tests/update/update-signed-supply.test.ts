import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { bootstrapEmbeddedRoot, selectVerifiedTarget, verifyReleaseRecord } from "../../src/update/signed-supply.mjs";
import { deriveCandidateId } from "../../src/update/update-candidate-id.mjs";

describe("embedded update trust root", () => {
  const root = readFileSync(repoPath("src/update/trust-root.json"));
  const expiry = Date.parse("2028-11-07T00:00:00Z");

  test("accepts only the compiled root before expiry and returns an opaque handle", () => {
    const trusted = bootstrapEmbeddedRoot(root, expiry - 1);
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.keys(trusted)).toEqual([]);
    expect(() => bootstrapEmbeddedRoot(root, expiry)).toThrow();
    expect(() => bootstrapEmbeddedRoot(root, expiry + 1)).toThrow();
  });

  test("rejects changed root bytes, invalid clocks and oversized input", () => {
    const altered = Buffer.from(root);
    altered[altered.length - 2] ^= 1;
    expect(() => bootstrapEmbeddedRoot(altered, expiry - 1)).toThrow();
    expect(() => bootstrapEmbeddedRoot(Buffer.alloc(65537), expiry - 1)).toThrow();
    for (const time of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bootstrapEmbeddedRoot(root, time)).toThrow();
    }
  });
});

describe("verified release and candidate handles", () => {
  test("uses an isolated compiled fixture anchor and rejects forged or cross-module handles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-update-fixture-"));
    try {
      const modules = ["signed-supply.mjs", "update-bytes.mjs", "update-contracts.mjs", "update-bounded-json.mjs", "update-candidate-id.mjs", "update-signed-version.mjs", "update-signature-threshold.mjs", "minisign.mjs"];
      for (const name of modules) {
        const source = repoPath("src/update", name);
        copyFileSync(source, join(dir, name));
        expect(readFileSync(join(dir, name))).toEqual(readFileSync(source));
      }
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
      const id = Buffer.alloc(8, 7);
      const fingerprint = createHash("sha256").update(raw).digest("hex");
      const publicBox = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, raw]).toString("base64")}\n`).toString("base64");
      const key = { keyId: fingerprint, algorithm: "minisign-ed25519-blake2b512/1", publicKey: publicBox };
      const root = Buffer.from(JSON.stringify({ schema: "ocx.update.root/1", revision: 1, expiresAt: "2030-01-01T00:00:00Z", rootKeys: [key], rootThreshold: 1, releaseKeys: [{ ...key, channels: ["latest"], roles: ["release", "desktop-artifact"] }], releaseThreshold: 1, channels: ["latest"] }));
      const anchor = createHash("sha256").update(root).digest("hex");
      writeFileSync(join(dir, "update-trust-anchor.mjs"), `export const EMBEDDED_ROOT_SHA256 = "${anchor}";\n`);
      const fixture = await import(pathToFileURL(join(dir, "signed-supply.mjs")).href);
      const signBox = (bytes: Buffer) => {
        const signature = sign(null, createHash("blake2b512").update(bytes).digest(), privateKey);
        const comment = "timestamp:1\tversion:1.2.3";
        const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
        const packet = Buffer.concat([Buffer.from("ED"), id, signature]).toString("base64");
        return Buffer.from(`untrusted comment: fixture\n${packet}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`).toString("base64");
      };
      const artifact = Buffer.from("fixture artifact");
      const digest = createHash("sha256").update(artifact).digest("hex");
      const release = Buffer.from(JSON.stringify({ schema: "ocx.update.release/1", version: "1.2.3", channel: "latest", sequence: 1, sourceCommit: "a".repeat(40), rolloutNotBefore: "2026-01-01T00:00:00Z", receipt: { sha256: "b".repeat(64), size: 1 }, releaseNotes: [], targets: [{ id: "macos-x64-desktop-tauri", platform: "macos", arch: "x64", owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz", assetName: "OpenCodex-1.2.3-macos.app.tar.gz", artifact: { sha256: digest, size: artifact.length, signatureBox: signBox(artifact), signerFingerprint: fingerprint }, tree: null, capabilities: { sha256: "c".repeat(64), size: 1 } }] }));
      const envelope = Buffer.from(JSON.stringify({ schema: "ocx.update.signatures/1", signatures: [{ keyFingerprint: fingerprint, signatureBox: signBox(release) }] }));
      const now = Date.parse("2027-01-01T00:00:00Z");
      const rootHandle = fixture.bootstrapEmbeddedRoot(root, now);
      const verified = fixture.verifyReleaseRecord(release, envelope, rootHandle, "latest", now);
      class TrappedBytes extends Uint8Array {
        get byteLength(): number { throw new Error("caller getter"); }
        get byteOffset(): number { throw new Error("caller getter"); }
        get buffer(): ArrayBuffer { throw new Error("caller getter"); }
        get length(): number { throw new Error("caller getter"); }
        [Symbol.iterator](): IterableIterator<number> { throw new Error("caller iterator"); }
      }
      expect(() => fixture.verifyReleaseRecord(new TrappedBytes(release), new TrappedBytes(envelope), rootHandle, "latest", now)).not.toThrow();
      const selection = { platform: "macos", arch: "x64", owner: "desktop", artifactKind: "tauri", bundleKind: "app-tar-gz" };
      const candidate = fixture.selectVerifiedTarget(verified, selection);
      expect(candidate.candidateId).toBe(deriveCandidateId(createHash("sha256").update(release).digest("hex"), "macos-x64-desktop-tauri"));
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(() => fixture.verifyReleaseRecord(release, envelope, {}, "latest", now)).toThrow();
      expect(() => fixture.verifyReleaseRecord(Buffer.from("changed"), envelope, rootHandle, "latest", now)).toThrow();
      expect(() => fixture.verifyReleaseRecord(release, envelope, rootHandle, "preview", now)).toThrow();
      expect(() => fixture.verifyReleaseRecord(release, envelope, rootHandle, "latest", Date.parse("2030-01-01T00:00:00Z"))).toThrow();
      expect(() => fixture.selectVerifiedTarget(verified, { ...selection, arch: "arm64" })).toThrow();
      expect(() => fixture.selectVerifiedTarget(verified, { ...selection, url: "https://example.invalid" })).toThrow();
      expect(() => bootstrapEmbeddedRoot(root, now)).toThrow();
      expect(() => verifyReleaseRecord(release, envelope, rootHandle, "latest", now)).toThrow();
      expect(() => selectVerifiedTarget(verified, selection)).toThrow();
      root.fill(0);
      expect(() => fixture.verifyReleaseRecord(release, envelope, rootHandle, "latest", now)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
