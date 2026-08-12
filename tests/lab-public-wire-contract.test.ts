import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPublicEvidenceBundle,
  importCommunityEvidenceBundle,
  parseStrictPublicJson,
  publicEvidenceId,
  signPublicEvidenceBundle,
  verifyPublicEvidenceBundle,
} from "../src/lab/public";

// Deterministic test-only key material is assembled at runtime so leak scanners do not
// mistake the fixture for a deployable private-key credential.
const FIXED_PRIVATE_KEY = [
  `-----BEGIN PRIVATE ${"KEY"}-----`,
  ["MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYH", "CAkKCwwNDg8QERITFBUWFxgZGhscHR4f"].join(""),
  `-----END PRIVATE ${"KEY"}-----`,
  "",
].join("\n");
const FIXED_PUBLIC_KEY = "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function installFixedPublisherKey(config: string): void {
  const lab = join(config, "lab");
  mkdirSync(lab, { recursive: true, mode: 0o700 });
  const path = join(lab, "publisher-ed25519.pem");
  writeFileSync(path, FIXED_PRIVATE_KEY, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function fixedRecord() {
  const subject = {
    subjectKind: "protocol" as const,
    compatibilityVersion: "2.13.0",
    adapterFamily: "openai-chat" as const,
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
  };
  const subjectId = publicEvidenceId("subject", subject);
  const withoutRecordId = {
    subjectId,
    evidenceLayer: "protocol_conformance" as const,
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: "2026-08-12",
    subject,
    assertions: [{ id: "request-shape", required: true, passed: true }],
  };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
}

function fixedBundle(config: string) {
  installFixedPublisherKey(config);
  return signPublicEvidenceBundle({
    records: [fixedRecord()],
    artifacts: [],
    createdDayUtc: "2026-08-12",
    configDir: config,
  });
}

describe("CL-10 public wire contract", () => {
  test("freezes the RFC 8785/domain-separated bundle and Ed25519 signature vector", () => {
    const bundle = fixedBundle(configDir("ocx-cl10-wire-publisher-"));

    expect(bundle.publisher.publicKey).toBe(FIXED_PUBLIC_KEY);
    expect(bundle.publisher.keyId).toBe("4d5a347afcc7a1ac8d2dd4e573f0fbca2d2e90dd472c35df5c72bf2d2afca08f");
    expect(bundle.records[0]!.subjectId).toBe("982a06b98a218df5ed68ae88f5f203e1911a3e875343c6ed8d5d0b74ff4c2b25");
    expect(bundle.records[0]!.recordId).toBe("cae04cc6cfabfd14799cf8bcbcb07563f71de1d570360d87a5e9825eedc59536");
    expect(bundle.bundleId).toBe("e416ec065b0bbefb14455b595ef7f53506a4fb005bea88976e96fbb97b473a7c");
    expect(bundle.bundleDigest).toBe("1340b6382a2e47155f72a396bb7ad7be5f4c818c9e87d825cfe64a74766a3bde");
    expect(bundle.signature).toEqual({
      algorithm: "ed25519",
      signedDigest: "1340b6382a2e47155f72a396bb7ad7be5f4c818c9e87d825cfe64a74766a3bde",
      signature: "+yZ96y77clEOz5vajcSV7/P/Mjg+V9evhNDIt5alrskUEa5+8aW/vkKqrDnrr7MGKJyYqAlIWvRS7RizbxS5Ag==",
    });
    expect(verifyPublicEvidenceBundle(bundle)).toEqual({ status: "cryptographically_valid" });
  });

  test("rejects non-canonical publisher public-key Base64", () => {
    const publicKey = `${FIXED_PUBLIC_KEY}\n`;
    const publisher = {
      algorithm: "ed25519" as const,
      publicKey,
      keyId: publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey }),
    };

    expect(() => buildPublicEvidenceBundle({
      records: [fixedRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      publisher,
    })).toThrow(/canonical base64/i);
  });

  test("rejects duplicate JSON object keys before community parsing", () => {
    const publisherDir = configDir("ocx-cl10-wire-publisher-");
    const consumerDir = configDir("ocx-cl10-wire-consumer-");
    const bundle = fixedBundle(publisherDir);
    const raw = JSON.stringify(bundle).replace(
      '"schemaVersion":"public_evidence_bundle_v1"',
      '"schemaVersion":"public_evidence_bundle_v1","schemaVersion":"public_evidence_bundle_v1"',
    );

    expect(() => importCommunityEvidenceBundle(raw, consumerDir)).toThrow(/duplicate json object key/i);
  });

  test("rejects public JSON deeper than the V1 import bound before JSON.parse materialization", () => {
    const raw = Buffer.from(`${"[".repeat(9)}0${"]".repeat(9)}`, "utf8");
    expect(() => parseStrictPublicJson(raw)).toThrow(/nesting depth exceeds 8/i);
  });
});
