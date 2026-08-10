import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDigest } from "./digest";
import { MCP_ACTION_TOKENS } from "./mcp-stub";
import type {
  CaseAuthority,
  CaseRecord,
  FailureClassification,
  FailureRule,
} from "./types";
import { CL01_SUITES, SYNTHETIC_MARKER } from "./types";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// Provenance is the normative CL-00 authority name, not the runtime copy's basename.
const AUTHORITY_FILE = "022_protocol_v1_cases.json";

export function loadCaseAuthority(): CaseAuthority {
  const path = join(MODULE_DIR, "fixtures", "protocol-v1-cases.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as CaseAuthority;
  validateAuthority(raw);
  return raw;
}

export function discoverScenarios(
  authority: CaseAuthority,
  suites: readonly string[] = CL01_SUITES,
): CaseRecord[] {
  return authority.cases.filter((c) => suites.includes(c.suite));
}

export function expandScenario(caseRecord: CaseRecord, authority: CaseAuthority): Record<string, unknown> {
  const defaults = authority.manifestDefaults;
  const fixtures = caseRecord.initiatingRequest
    ? [fixtureRef(caseRecord.initiatingRequest, authority), fixtureRef(caseRecord.fixture, authority)]
    : [fixtureRef(caseRecord.fixture, authority)];
  return {
    schemaVersion: authority.schemaVersion,
    id: caseRecord.id,
    version: defaults.version,
    suite: {
      id: caseRecord.suite,
      version: defaults.suiteVersion,
      evidenceLayer: defaults.evidenceLayer,
    },
    evidenceLayer: defaults.evidenceLayer,
    capability: caseRecord.capability,
    verificationRole: caseRecord.verificationRole ?? defaults.verificationRole,
    requirements: caseRecord.requirements,
    fixtures,
    executionLimits: defaults.executionLimits,
    assertions: caseRecord.assertions,
    ...(caseRecord.expectedFailure ? { expectedFailure: caseRecord.expectedFailure } : {}),
    failureRules: expandFailureRules(caseRecord, authority),
    artifactPolicy: defaults.artifactPolicy,
    freshness: defaults.freshness,
  };
}

function fixtureRef(fixture: CaseRecord["fixture"], authority: CaseAuthority): Record<string, unknown> {
  const bytes = new TextEncoder().encode(fixture.bytesUtf8);
  return {
    id: fixture.id,
    role: fixture.role,
    mediaType: fixture.mediaType,
    digest: fixture.digest,
    byteLength: bytes.byteLength,
    syntheticMarker: SYNTHETIC_MARKER,
    provenance: {
      kind: "lab_authored",
      authority: AUTHORITY_FILE,
      sourceCommit: authority.sourceCommit,
    },
  };
}

function expandFailureRules(caseRecord: CaseRecord, authority: CaseAuthority): FailureRule[] {
  const setName = authority.manifestDefaults.failureRuleSet;
  const ruleSet = authority.failureRuleSets[setName];
  if (!Array.isArray(ruleSet)) {
    throw new Error(`harness_failure: contract_integrity unknown failureRuleSet ${setName}`);
  }
  const base = [...ruleSet];
  if (!caseRecord.expectedFailure) return base;
  const template = authority.expectedFailureRuleTemplate;
  const controlRule: FailureRule = {
    id: template.id,
    match: [...template.match],
    classification: caseRecord.expectedFailure.expectedClass as FailureClassification,
    secondaryCode: caseRecord.expectedFailure.expectedCode,
    verdictEffect: caseRecord.expectedFailure.onMatch === "unsupported" ? "unsupported" : "none",
    retry: template.retry,
    expected: template.expected,
  };
  const idx = base.findIndex((r) => r.id === "required-assertion");
  if (idx >= 0) base.splice(idx, 0, controlRule);
  else base.push(controlRule);
  return base;
}

export function validateFixtureDigests(caseRecord: CaseRecord): string[] {
  const errors: string[] = [];
  const check = (fixture: CaseRecord["fixture"], label: string) => {
    const bytes = new TextEncoder().encode(fixture.bytesUtf8);
    const digest = fixtureDigest(bytes);
    if (digest !== fixture.digest) {
      errors.push(`${label} digest mismatch: expected ${fixture.digest}, got ${digest}`);
    }
  };
  check(caseRecord.fixture, caseRecord.fixture.id);
  if (caseRecord.initiatingRequest) check(caseRecord.initiatingRequest, caseRecord.initiatingRequest.id);
  return errors;
}

export function validateExpandedFixtureRef(
  ref: Record<string, unknown>,
  authority: CaseAuthority,
  fixtureBytes: string,
): string[] {
  const errors: string[] = [];
  const bytes = new TextEncoder().encode(fixtureBytes);
  if (ref.syntheticMarker !== SYNTHETIC_MARKER) {
    errors.push(`invalid syntheticMarker: ${String(ref.syntheticMarker)}`);
  }
  const provenance = ref.provenance as Record<string, unknown> | undefined;
  if (!provenance || provenance.kind !== "lab_authored") {
    errors.push("invalid provenance kind");
  } else if (provenance.authority !== AUTHORITY_FILE) {
    errors.push(`invalid provenance authority: ${String(provenance.authority)}`);
  } else if (provenance.sourceCommit !== authority.sourceCommit) {
    errors.push(`invalid provenance sourceCommit: ${String(provenance.sourceCommit)}`);
  }
  if (ref.digest !== fixtureDigest(bytes)) {
    errors.push("fixture digest mismatch in expanded ref");
  }
  if (ref.byteLength !== bytes.byteLength) {
    errors.push("fixture byteLength mismatch in expanded ref");
  }
  return errors;
}

function validateMcpHarnessFeatures(caseRecord: CaseRecord): string[] {
  if (caseRecord.suite !== "mcp-core") return [];
  const tokens = caseRecord.requirements.requiredHarnessFeatures.filter(
    (f) => MCP_ACTION_TOKENS.includes(f as typeof MCP_ACTION_TOKENS[number]),
  );
  if (tokens.length !== 1) {
    return [`${caseRecord.id}: invalid_manifest MCP action token count ${tokens.length}`];
  }
  if (caseRecord.fixture.role !== "synthetic_tool") {
    return [`${caseRecord.id}: MCP cases require synthetic_tool fixture role`];
  }
  return [];
}

function validateAuthority(authority: CaseAuthority): void {
  if (authority.schemaVersion !== 1) throw new Error("unsupported schemaVersion");
  if (!authority.sourceCommit || typeof authority.sourceCommit !== "string") {
    throw new Error("missing sourceCommit");
  }
  if (!Array.isArray(authority.cases) || authority.cases.length === 0) throw new Error("no cases");
  for (const caseRecord of authority.cases) {
    const errors = [
      ...validateFixtureDigests(caseRecord),
      ...validateMcpHarnessFeatures(caseRecord),
    ];
    const expanded = expandScenario(caseRecord, authority);
    const fixtures = expanded.fixtures as Array<Record<string, unknown>>;
    for (let i = 0; i < fixtures.length; i++) {
      const fixtureSource = i === 0 && caseRecord.initiatingRequest
        ? caseRecord.initiatingRequest.bytesUtf8
        : caseRecord.fixture.bytesUtf8;
      errors.push(...validateExpandedFixtureRef(fixtures[i], authority, fixtureSource));
    }
    if (errors.length > 0) throw new Error(errors.join("; "));
    if (caseRecord.fixture.role === "upstream_response" && !caseRecord.initiatingRequest) {
      throw new Error(`${caseRecord.id}: upstream_response without initiatingRequest`);
    }
  }
}
