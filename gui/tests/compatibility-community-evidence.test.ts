import { expect, test } from "bun:test";
import {
  parseCommunityEvidenceContext,
  type CommunityEvidenceContextDto,
} from "../src/pages/compatibility-matrix-api";
import { labSupplement, type LabLocale } from "../src/i18n/lab-translations";

const LOCALES: LabLocale[] = ["en", "de", "ja", "ko", "ru", "tr", "zh", "zh-TW"];

function validContext(): CommunityEvidenceContextDto {
  return {
    trustClass: "community_untrusted_v1",
    locallyVerified: false,
    evidence: [
      {
        trustClass: "community_untrusted_v1",
        status: "cryptographically_valid",
        bundleId: "a".repeat(64),
        publisherKeyId: "b".repeat(64),
        activeRecordCount: 3,
        revokedRecordCount: 1,
      },
    ],
  };
}

test("Compatibility Matrix parses only quarantined community evidence context", () => {
  expect(parseCommunityEvidenceContext(validContext())).toEqual(validContext());
  expect(parseCommunityEvidenceContext({ ...validContext(), locallyVerified: true })).toBeNull();
  expect(parseCommunityEvidenceContext({ ...validContext(), trustClass: "local" })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, activeRecordCount: -1 }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, status: "locally_verified" }],
  })).toBeNull();
});

test("Compatibility Matrix community copy is localized and explicitly non-authoritative", () => {
  for (const locale of LOCALES) {
    expect(labSupplement(locale, "community.title")).toBeTruthy();
    expect(labSupplement(locale, "community.notLocalVerdict")).toBeTruthy();
    expect(labSupplement(locale, "community.bundles")).toBeTruthy();
    expect(labSupplement(locale, "community.activeRecords")).toBeTruthy();
    expect(labSupplement(locale, "community.revokedRecords")).toBeTruthy();
  }
  expect(labSupplement("en", "community.notLocalVerdict")).toMatch(/untrusted|not included|local verdict/i);
});

test("Compatibility Matrix renders community evidence as separate context, never a combined score", async () => {
  const source = await Bun.file(new URL("../src/pages/CompatibilityMatrix.tsx", import.meta.url)).text();
  expect(source).toContain('data-testid="lab-community-evidence"');
  expect(source).toContain('labSupplement(locale, "community.notLocalVerdict")');
  expect(source).not.toMatch(/combined.?score/i);
  expect(source).not.toMatch(/community.*verdict\s*=|verdict\s*=.*community/i);
});
