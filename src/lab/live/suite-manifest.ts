import { scenarioManifestDigest, suiteManifestDigest } from "../digest";
import type { CaseAuthority, CaseRecord, VerificationRole } from "../conformance/types";
import { expandLiveScenario } from "./manifest";

export interface LiveSuiteScenarioRefV1 { id: string; version: string; role: VerificationRole; manifestDigest: string }
export interface LiveSuiteManifestV1 {
  schemaVersion: 1; id: string; version: string; evidenceLayer: string; capability: string;
  assertionDslVersion: string; evidenceSchemaVersion: string; freshness: { maxAgeMs: number | null };
  contradictionRule: string; scenarios: LiveSuiteScenarioRefV1[]; verificationRule: string;
}

function casesForSuiteManifest(suiteId: string, authority: CaseAuthority): { own: CaseRecord[]; referenced: CaseRecord[] } {
  const own = authority.cases.filter((row) => row.suite === suiteId);
  if (own.length === 0) throw new Error(`unknown live suite ${suiteId}`);
  if (suiteId !== "codex-core") return { own, referenced: own };
  const prerequisite = authority.cases.find((row) => row.id === "responses-core.live.basic-turn");
  if (!prerequisite) throw new Error("harness_failure: codex live prerequisite missing");
  return { own, referenced: [...own, prerequisite] };
}

export function expandLiveSuiteManifest(suiteId: string, authority: CaseAuthority): LiveSuiteManifestV1 {
  const { own, referenced } = casesForSuiteManifest(suiteId, authority);
  const defaults = authority.manifestDefaults;
  const scenarios = referenced.map((caseRecord) => ({
    id: caseRecord.id, version: String(defaults.version), role: caseRecord.verificationRole ?? defaults.verificationRole,
    manifestDigest: scenarioManifestDigest(expandLiveScenario(caseRecord, authority)),
  })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    schemaVersion: 1, id: suiteId, version: String(defaults.suiteVersion), evidenceLayer: defaults.evidenceLayer,
    capability: own[0]!.capability, assertionDslVersion: authority.assertionDslVersion, evidenceSchemaVersion: authority.evidenceSchemaVersion,
    freshness: defaults.freshness ?? { maxAgeMs: null }, contradictionRule: "newest-required-observation-v1", scenarios,
    verificationRule: "all-applicable-required-pass-v1",
  };
}

export function liveSuiteManifestObjectForCase(caseRecord: CaseRecord, authority: CaseAuthority): Record<string, unknown> {
  return expandLiveSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>;
}
export function liveSuiteManifestDigestForCase(caseRecord: CaseRecord, authority: CaseAuthority): string {
  return suiteManifestDigest(expandLiveSuiteManifest(caseRecord.suite, authority) as unknown as Record<string, unknown>);
}
