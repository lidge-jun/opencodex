import { expect, test } from "bun:test";
import {
  validatePublicEvidencePrivacy,
  type PublicEvidenceBundleUnsignedV1,
} from "../src/lab/public";

test("public artifact privacy rejects embedded unbracketed IPv6 literals", () => {
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
