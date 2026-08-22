import { expect, test } from "bun:test";
import {
  fetchLabPageData,
  fetchVerdictDetail,
  parseCommunityEvidenceContext,
  type CommunityEvidenceContextDto,
} from "../src/pages/compatibility-matrix-api";
import type { VerdictDto } from "../src/pages/compatibility-matrix-shared";
import {
  LAB_CATALOG_OVERRIDES,
  labSupplement,
  type LabLocale,
} from "../src/i18n/lab-translations";

const LOCALES = Object.keys(LAB_CATALOG_OVERRIDES) as LabLocale[];

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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Compatibility Matrix parses only bounded quarantined community evidence context", () => {
  expect(parseCommunityEvidenceContext(validContext())).toEqual(validContext());
  expect(parseCommunityEvidenceContext({ ...validContext(), locallyVerified: true })).toBeNull();
  expect(parseCommunityEvidenceContext({ ...validContext(), trustClass: "local" })).toBeNull();
  expect(parseCommunityEvidenceContext({ ...validContext(), unexpected: true })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, unexpected: true }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, bundleId: "A".repeat(64) }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, publisherKeyId: "z".repeat(64) }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, activeRecordCount: -1 }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, activeRecordCount: 1.5 }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: [{ ...validContext().evidence[0]!, status: "locally_verified" }],
  })).toBeNull();
  expect(parseCommunityEvidenceContext({
    ...validContext(),
    evidence: Array.from({ length: 4097 }, () => validContext().evidence[0]!),
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

test("community evidence is fetched once as page-global context, never as verdict detail", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  const context = validContext();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/api/lab/status")) {
      return json({
        projectionAvailable: true,
        subjectCount: 0,
        verdictCount: 0,
        observationCount: 0,
        eventCount: 0,
      });
    }
    if (url.includes("/api/lab/verdicts?")) return json({ verdicts: [], hasMore: false });
    if (url.includes("/api/lab/subjects?")) return json({ subjects: [], hasMore: false });
    if (url.endsWith("/api/lab/public/community")) return json(context);
    if (url.endsWith("/api/lab/subjects/subject-alpha")) {
      return json({ subject: { subjectKind: "protocol", subjectSchemaVersion: 1, inboundProtocol: "openai-chat" } });
    }
    if (url.includes("/api/lab/observations?")) return json({ observations: [], hasMore: false });
    throw new Error(`unexpected optional detail request: ${url}`);
  }) as typeof fetch;

  try {
    const signal = new AbortController().signal;
    const page = await fetchLabPageData("http://127.0.0.1:4096", {}, signal);
    expect(page.community).toEqual(context);
    expect(requested.filter(url => url.endsWith("/api/lab/public/community"))).toHaveLength(1);

    const verdict: VerdictDto = {
      projectionKey: "v1",
      subjectId: "subject-alpha",
      evidenceLayer: "protocol_conformance",
      suiteId: "responses-core",
      suiteVersion: "1",
      suiteManifestDigest: "digest-a",
      projectionSpecVersion: "cl-02.v1",
      verdict: "VERIFIED",
      asOf: 1_700_000_000_000,
      scenarioManifestDigests: [],
      claimSourceDigest: null,
      contributingEventIds: [],
      contradictingEventIds: [],
      notes: [],
    };
    const detail = await fetchVerdictDetail("http://127.0.0.1:4096", verdict, signal);
    expect(detail).not.toHaveProperty("community");
    expect(requested.filter(url => url.endsWith("/api/lab/public/community"))).toHaveLength(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
