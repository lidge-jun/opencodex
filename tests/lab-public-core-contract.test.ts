import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labPublicPublisherKeyPath } from "../src/lab/paths";
import { buildPublicEvidenceBundle } from "../src/lab/public/bundle";
import { validatePublicEvidenceAuthorities } from "../src/lab/public/community-authority";
import { publicEvidenceId } from "../src/lab/public/ids";
import { validatePublicEvidencePrivacy } from "../src/lab/public/privacy";
import { PUBLIC_ROUTE_REGISTRY_V1 } from "../src/lab/public/registry";
import { signPublicEvidenceBundle, verifyPublicEvidenceBundle } from "../src/lab/public/signature";
import { parseStrictPublicJson } from "../src/lab/public/strict-json";
import { publicUtcDay } from "../src/lab/public/time";
import {
  PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION,
  type PublicEvidenceBundleUnsignedV1,
} from "../src/lab/public/types";
import { validatePublicRouteRegistryManifest } from "../src/lab/public/validate";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const FIXED_PRIVATE_KEY = [
  `-----BEGIN PRIVATE ${"KEY"}-----`,
  ["MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYH", "CAkKCwwNDg8QERITFBUWFxgZGhscHR4f"].join(""),
  `-----END PRIVATE ${"KEY"}-----`,
  "",
].join("\n");
const FIXED_PUBLIC_KEY = "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";
const REVIEWED_AUTHORITY_SOURCE_COMMIT = "75a21417657ba5a3033198be0d8ae949de723d11";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function installFixedPublisherKey(config: string): void {
  const path = labPublicPublisherKeyPath(config);
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, FIXED_PRIVATE_KEY, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function fixedRecord(scenarioId = "responses-core.protocol.request-shape") {
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
    scenarioId,
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: "2026-08-12",
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
  };
  return { recordId: publicEvidenceId("record", withoutRecordId), ...withoutRecordId };
}

describe("CL-10 public evidence core contract", () => {
  test("freezes the RFC 8785/domain-separated bundle and Ed25519 vector", () => {
    const config = configDir("ocx-cl10-core-wire-");
    installFixedPublisherKey(config);
    const bundle = signPublicEvidenceBundle({
      records: [fixedRecord()],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      configDir: config,
    });

    expect(bundle.publisher.publicKey).toBe(FIXED_PUBLIC_KEY);
    expect(bundle.publisher.keyId).toBe("4d5a347afcc7a1ac8d2dd4e573f0fbca2d2e90dd472c35df5c72bf2d2afca08f");
    expect(bundle.records[0]!.recordId).toBe("5bec20821bbf01f831e74ba469e7f18481c1209fdef209c76f482105de3e406d");
    expect(bundle.bundleId).toBe("a7598b68a4cf884dc381b1d88111e74bfad5e74ceae2be8de55b88bac3250401");
    expect(bundle.bundleDigest).toBe("aeef2f3e64a131588f6a34aaea1172c352a0c803f838690c2d6ee652ca74fb87");
    expect(bundle.signature.signature).toBe("UAiI7Mz4/yIU5XjSuNZFSuyFPoAvGCy+x9cpTCwYKnFDq20AP6ipV3zowD3S4KP2iYfkXyHTMsMH3CEnz6lCBw==");
    expect(verifyPublicEvidenceBundle(bundle)).toEqual({ status: "cryptographically_valid" });
  });

  test("pins canonical multi-record ordering into the bundle digest", () => {
    const first = fixedRecord();
    const second = fixedRecord("responses-core.protocol.response-shape");
    const publisher = {
      algorithm: "ed25519" as const,
      publicKey: FIXED_PUBLIC_KEY,
      keyId: publicEvidenceId("publisher_key", { algorithm: "ed25519", publicKey: FIXED_PUBLIC_KEY }),
    };

    const bundle = buildPublicEvidenceBundle({
      records: [first, second],
      artifacts: [],
      createdDayUtc: "2026-08-12",
      publisher,
    });

    expect(bundle.records.map((record) => record.recordId)).toEqual([
      "2a2a2e8406e6ccac915b21e96558a7b89e49e52effe474bd2c861ad2f7459437",
      "5bec20821bbf01f831e74ba469e7f18481c1209fdef209c76f482105de3e406d",
    ]);
    expect(bundle.bundleDigest).toBe("63fef67418ec196b480bba3865fba287cc92aa94a760e2e3648b0759c0be046e");
  });

  test("retains protocol V1 authority as an explicit historical snapshot", () => {
    const current = fixedRecord();
    expect(() => validatePublicEvidenceAuthorities([current])).not.toThrow();

    const { recordId: _recordId, ...body } = current;
    const unsupportedBody = {
      ...body,
      suiteVersion: "9.9.9",
      scenarioVersion: "9.9.9",
    };
    const unsupported = {
      recordId: publicEvidenceId("record", unsupportedBody),
      ...unsupportedBody,
    };
    expect(() => validatePublicEvidenceAuthorities([unsupported])).toThrow(/not retained/i);
  });

  test("rejects non-canonical publisher Base64", () => {
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

  test("strict JSON rejects duplicate decoded keys and bound violations before materialization", () => {
    expect(() => parseStrictPublicJson(Buffer.from('{"a":1,"\\u0061":2}', "utf8")))
      .toThrow(/duplicate json object key/i);
    expect(() => parseStrictPublicJson(Buffer.from(`${"[".repeat(9)}0${"]".repeat(9)}`, "utf8")))
      .toThrow(/nesting depth exceeds 8/i);
    expect(() => parseStrictPublicJson(Buffer.from(`[${Array.from({ length: 513 }, () => "0").join(",")}]`, "utf8")))
      .toThrow(/array exceeds 512/i);
    const wide = `{${Array.from({ length: 65 }, (_, index) => `"k${index}":0`).join(",")}}`;
    expect(() => parseStrictPublicJson(Buffer.from(wide, "utf8"))).toThrow(/object exceeds 64/i);
    expect(() => parseStrictPublicJson(Buffer.alloc((2 * 1024 * 1024) + 1, 0x20)))
      .toThrow(/exceeds 2097152 bytes/i);
  });

  test("public UTC day rejects expanded-year timestamps", () => {
    expect(() => publicUtcDay(Date.UTC(10_000, 0, 1))).toThrow(/completion timestamp/i);
  });

  test("local signing rejects artifact bytes before creating publisher state", () => {
    const config = configDir("ocx-cl10-core-artifact-");
    const contentBase64 = Buffer.from("credential-canary-1234567890", "utf8").toString("base64");
    const artifact = {
      artifactClass: "verifier_summary",
      mediaType: "text/plain",
      byteCount: Buffer.from(contentBase64, "base64").byteLength,
      contentBase64,
    };
    const artifactId = publicEvidenceId("artifact", artifact);
    expect(() => signPublicEvidenceBundle({
      records: [],
      artifacts: [{ artifactId, ...artifact }],
      createdDayUtc: "2026-08-12",
      configDir: config,
    })).toThrow(/public_export/i);
    expect(existsSync(labPublicPublisherKeyPath(config))).toBe(false);
  });

  test("privacy rejects embedded unbracketed IPv6 in artifact text", () => {
    const bytes = Buffer.from("artifact 2001:db8::1 content", "utf8");
    const bundle = {
      createdDayUtc: "2026-08-13",
      records: [],
      artifacts: [{
        artifactId: "0".repeat(64),
        artifactClass: "verifier_summary",
        mediaType: "text/plain",
        byteCount: bytes.byteLength,
        contentBase64: bytes.toString("base64"),
      }],
    } as unknown as PublicEvidenceBundleUnsignedV1;
    expect(() => validatePublicEvidencePrivacy(bundle)).toThrow(/IP address|privacy/i);
  });

  test("pins the reviewed public route registry authority", () => {
    const manifest = validatePublicRouteRegistryManifest(PUBLIC_ROUTE_REGISTRY_V1);
    expect(manifest.schemaVersion).toBe(PUBLIC_ROUTE_REGISTRY_SCHEMA_VERSION);
    expect(manifest.registryVersion).toBe("2026-08-13.v2");
    expect(manifest.sourceCommit).toBe(REVIEWED_AUTHORITY_SOURCE_COMMIT);
    expect(manifest.entries).toEqual([{
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      adapterFamilies: ["openai-responses"],
    }]);

    expect(Object.isFrozen(PUBLIC_ROUTE_REGISTRY_V1)).toBe(true);
    expect(Object.isFrozen(PUBLIC_ROUTE_REGISTRY_V1.entries)).toBe(true);
    for (const entry of PUBLIC_ROUTE_REGISTRY_V1.entries) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.adapterFamilies)).toBe(true);
    }
  });
});
