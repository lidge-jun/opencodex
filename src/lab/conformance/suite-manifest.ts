import { scenarioManifestDigest, suiteManifestDigest } from "../digest";
import type { CaseAuthority, CaseRecord, VerificationRole } from "./types";
import { expandScenario } from "./manifest";

export interface SuiteScenarioRefV1 {
  id: string;
  version: string;
  role: VerificationRole;
  manifestDigest: string;
}

export interface SuiteManifestV1 {
  schemaVersion: 1;
  id: string;
  version: string;
  evidenceLayer: string;
  capability: string;
  assertionDslVersion: string;
  evidenceSchemaVersion: string;
  freshness: { maxAgeMs: number | null };
  contradictionRule: string;
  scenarios: SuiteScenarioRefV1[];
  verificationRule: string;
}

/** Expand the canonical suite manifest for one suite ID from CL-01 authority. */
export function expandSuiteManifest(
  suiteId: string,
  authority: CaseAuthority,
): SuiteManifestV1 {
  const cases = authority.cases.filter((c) => c.suite === suiteId);
  if (cases.length === 0) {
    throw new Error(`unknown suite ${suiteId}`);
  }
  const defaults = authority.manifestDefaults;
  const capability = cases[0]!.capability;
  if (cases.some((caseRecord) => caseRecord.capability !== capability)) {
    throw new Error(`suite ${suiteId} declares mixed capabilities`);
  }
  const scenarios: SuiteScenarioRefV1[] = cases
    .map((caseRecord) => suiteScenarioRef(caseRecord, authority))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schemaVersion: 1,
    id: suiteId,
    version: String(defaults.suiteVersion),
    evidenceLayer: defaults.evidenceLayer,
    capability,
    assertionDslVersion: authority.assertionDslVersion,
    evidenceSchemaVersion: authority.evidenceSchemaVersion,
    freshness: defaults.freshness ?? { maxAgeMs: null },
    contradictionRule: "newest-required-observation-v1",
    scenarios,
    verificationRule: "all-applicable-required-pass-v1",
  };
}

function suiteScenarioRef(caseRecord: CaseRecord, authority: CaseAuthority): SuiteScenarioRefV1 {
  const expanded = expandScenario(caseRecord, authority);
  return {
    id: caseRecord.id,
    version: String(authority.manifestDefaults.version),
    role: caseRecord.verificationRole ?? authority.manifestDefaults.verificationRole,
    manifestDigest: scenarioManifestDigest(expanded),
  };
}

export function suiteManifestObjectForCase(
  caseRecord: CaseRecord,
  authority: CaseAuthority,
): Record<string, unknown> {
  return expandSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>;
}

export function suiteManifestDigestForCase(caseRecord: CaseRecord, authority: CaseAuthority): string {
  return suiteManifestDigest(expandSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>);
}
