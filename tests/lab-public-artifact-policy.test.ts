import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labPublicPublisherKeyPath } from "../src/lab";
import { publicEvidenceId, signPublicEvidenceBundle } from "../src/lab/public";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("CL-10 local signing rejects artifact bytes without reviewed public_export authority", () => {
  const configDir = mkdtempSync(join(tmpdir(), "ocx-cl10-artifact-policy-"));
  roots.push(configDir);
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
    configDir,
  })).toThrow(/public_export/i);

  expect(existsSync(labPublicPublisherKeyPath(configDir))).toBe(false);
});
