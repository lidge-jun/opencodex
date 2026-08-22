import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDigest } from "../digest";
import type { CaseAuthority, CaseRecord, FailureClassification, FailureRule } from "../conformance/types";
import { CL03_LIVE_SUITES, SYNTHETIC_MARKER } from "../conformance/types";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const AUTHORITY_FILE = "024_live_v1_cases.json";
const RUNTIME_AUTHORITY = join(MODULE_DIR, "..", "conformance", "fixtures", "live-v1-cases.json");
const REPO_AUTHORITY = join(MODULE_DIR, "..", "..", "..", "devlog", "_fin", "260807_compatibility_lab", AUTHORITY_FILE);

function readAuthority(path: string): CaseAuthority { return JSON.parse(readFileSync(path, "utf8")) as CaseAuthority; }

/** During source-tree execution, fail closed unless the runtime copy is byte-identical to normative 024. */
export function assertLiveAuthorityMirror(): void {
  if (!existsSync(REPO_AUTHORITY)) return;
  const runtimeBytes = readFileSync(RUNTIME_AUTHORITY);
  const normativeBytes = readFileSync(REPO_AUTHORITY);
  if (!runtimeBytes.equals(normativeBytes)) throw new Error("harness_failure: live authority runtime copy drift");
}

export function loadLiveCaseAuthority(): CaseAuthority {
  assertLiveAuthorityMirror();
  const raw = readAuthority(RUNTIME_AUTHORITY);
  validateLiveAuthority(raw);
  return raw;
}

export function discoverLiveScenarios(authority: CaseAuthority, suites: readonly string[] = CL03_LIVE_SUITES): CaseRecord[] {
  return authority.cases.filter((row) => suites.includes(row.suite));
}

export function expandLiveScenario(caseRecord: CaseRecord, authority: CaseAuthority): Record<string, unknown> {
  const defaults = authority.manifestDefaults;
  const fixtures = caseRecord.initiatingRequest ? [fixtureRef(caseRecord.initiatingRequest, authority), fixtureRef(caseRecord.fixture, authority)] : [fixtureRef(caseRecord.fixture, authority)];
  return {
    schemaVersion: authority.schemaVersion, id: caseRecord.id, version: defaults.version,
    suite: { id: caseRecord.suite, version: defaults.suiteVersion, evidenceLayer: defaults.evidenceLayer },
    evidenceLayer: defaults.evidenceLayer, capability: caseRecord.capability,
    verificationRole: caseRecord.verificationRole ?? defaults.verificationRole, requirements: caseRecord.requirements,
    fixtures, executionLimits: defaults.executionLimits, executionMode: defaults.executionMode, assertions: caseRecord.assertions,
    ...(caseRecord.expectedFailure ? { expectedFailure: caseRecord.expectedFailure } : {}),
    failureRules: expandLiveFailureRules(caseRecord, authority), artifactPolicy: defaults.artifactPolicy, freshness: defaults.freshness,
  };
}

function fixtureRef(fixture: CaseRecord["fixture"], authority: CaseAuthority): Record<string, unknown> {
  const bytes = new TextEncoder().encode(fixture.bytesUtf8);
  return { id: fixture.id, role: fixture.role, mediaType: fixture.mediaType, digest: fixture.digest, byteLength: bytes.byteLength,
    syntheticMarker: SYNTHETIC_MARKER, provenance: { kind: "lab_authored", authority: AUTHORITY_FILE, sourceCommit: authority.sourceCommit } };
}

function expandLiveFailureRules(caseRecord: CaseRecord, authority: CaseAuthority): FailureRule[] {
  const setName = authority.manifestDefaults.failureRuleSet;
  const ruleSet = authority.failureRuleSets[setName];
  if (!Array.isArray(ruleSet)) throw new Error(`harness_failure: contract_integrity unknown failureRuleSet ${setName}`);
  const base = [...ruleSet];
  if (!caseRecord.expectedFailure) return base;
  const template = authority.expectedFailureRuleTemplate;
  const controlRule: FailureRule = { id: template.id, match: [...template.match], classification: caseRecord.expectedFailure.expectedClass as FailureClassification,
    secondaryCode: caseRecord.expectedFailure.expectedCode, verdictEffect: caseRecord.expectedFailure.onMatch === "unsupported" ? "unsupported" : "none",
    retry: template.retry, expected: template.expected };
  const idx = base.findIndex((row) => row.id === "required-assertion");
  if (idx >= 0) base.splice(idx, 0, controlRule); else base.push(controlRule);
  return base;
}

function validateLiveAuthority(authority: CaseAuthority): void {
  if (authority.schemaVersion !== 1 || authority.manifestDefaults.evidenceLayer !== "live_route_compatibility") throw new Error("invalid live authority");
  if (!authority.sourceCommit || !Array.isArray(authority.cases) || authority.cases.length !== 10) throw new Error("invalid live authority case set");
  const ids = new Set<string>();
  for (const caseRecord of authority.cases) {
    if (ids.has(caseRecord.id)) throw new Error(`duplicate live scenario ${caseRecord.id}`);
    ids.add(caseRecord.id);
    if (!caseRecord.id.split(".").includes("live")) throw new Error(`non-live scenario in CL-03 authority: ${caseRecord.id}`);
    const bytes = new TextEncoder().encode(caseRecord.fixture.bytesUtf8);
    if (fixtureDigest(bytes) !== caseRecord.fixture.digest) throw new Error(`${caseRecord.id}: fixture digest mismatch`);
    if (caseRecord.initiatingRequest) {
      const initBytes = new TextEncoder().encode(caseRecord.initiatingRequest.bytesUtf8);
      if (fixtureDigest(initBytes) !== caseRecord.initiatingRequest.digest) throw new Error(`${caseRecord.id}: initiatingRequest digest mismatch`);
    }
    expandLiveScenario(caseRecord, authority);
  }
}
