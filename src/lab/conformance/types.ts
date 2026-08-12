/** CL-01 deterministic protocol conformance harness types (CL-00 contract). */

export const SYNTHETIC_MARKER = "ocx-lab-synthetic-v1";

export type EvidenceLayer = "protocol_conformance" | "live_route_compatibility" | "task_effectiveness";

export type VerificationRole = "required" | "supplemental" | "negative_control";

export type FailureClassification =
  | "harness_failure"
  | "timeout"
  | "inactivity_timeout"
  | "budget_exhausted"
  | "sandbox_violation"
  | "malformed_producer_outcome"
  | "layer_subject_mismatch"
  | "protocol_failure"
  | "capability_failure"
  | "behavioral_failure"
  | "authentication_blocked"
  | "quota_blocked"
  | "region_blocked"
  | "network_failure"
  | "provider_transient"
  | "inconclusive";

export const FAILURE_CLASSIFICATIONS = [
  "harness_failure",
  "timeout",
  "inactivity_timeout",
  "budget_exhausted",
  "sandbox_violation",
  "malformed_producer_outcome",
  "layer_subject_mismatch",
  "protocol_failure",
  "capability_failure",
  "behavioral_failure",
  "authentication_blocked",
  "quota_blocked",
  "region_blocked",
  "network_failure",
  "provider_transient",
  "inconclusive",
] as const satisfies readonly FailureClassification[];

export interface FixtureRecord {
  id: string;
  role: "client_request" | "upstream_response" | "adapter_vector" | "synthetic_tool";
  mediaType: string;
  bytesUtf8: string;
  digest: string;
}

export interface AssertionSpec {
  id: string;
  operator: string;
  selector: string;
  expected: unknown;
  required: boolean;
}

export interface ExpectedFailureSpec {
  controlKind: "conformance_negative_control" | "capability_absence_control";
  expectedClass: FailureClassification;
  expectedCode: string;
  assertionIds: string[];
  onMatch: "pass" | "unsupported";
  onMismatch: "fail" | "inconclusive";
}

export interface CaseRecord {
  id: string;
  suite: string;
  capability: string;
  verificationRole?: VerificationRole;
  requirements: {
    inboundProtocols: string[];
    upstreamProtocols: string[];
    surfaces: string[];
    requiredClaims: string[];
    requiredHarnessFeatures: string[];
    platforms: string[];
    routePreconditions: string[];
  };
  fixture: FixtureRecord;
  initiatingRequest?: FixtureRecord;
  assertions: AssertionSpec[];
  expectedFailure?: ExpectedFailureSpec;
}

export interface FailureRule {
  id: string;
  match: string[];
  classification: FailureClassification;
  secondaryCode?: string;
  verdictEffect: "none" | "degraded" | "unsupported";
  retry: "never" | "bounded" | "after_precondition_change";
  expected: boolean;
}

export interface CaseAuthority {
  schemaVersion: number;
  sourceCommit: string;
  assertionDslVersion: string;
  evidenceSchemaVersion: string;
  failureRuleSets: Record<string, FailureRule[]>;
  expectedFailureRuleTemplate: Pick<FailureRule, "id" | "match" | "retry" | "expected">;
  manifestDefaults: {
    version: string;
    suiteVersion: string;
    evidenceLayer: EvidenceLayer;
    verificationRole: VerificationRole;
    executionMode: string;
    freshness: { maxAgeMs: number | null };
    executionLimits: Record<string, number>;
    artifactPolicy: Record<string, unknown>;
    failureRuleSet: string;
  };
  cases: CaseRecord[];
}

export interface NormalizedEvent {
  event: string;
  data: unknown;
  ordinal: number;
}

export interface ToolCallProjection {
  id: string;
  name: string;
  arguments: unknown;
  kind: "function" | "custom";
  ordinal: number;
}

export interface McpCallProjection {
  namespace: string;
  name: string;
}

export interface NormalizedObservation {
  client: {
    request: { status: number; headers: Record<string, string>; json: unknown; rawBytes: number };
    response: {
      status: number;
      headers: Record<string, string>;
      json: unknown;
      events: NormalizedEvent[];
      toolCalls: ToolCallProjection[];
      mcpCalls: McpCallProjection[];
      terminal: string | null;
      normalizedText: string;
    };
  };
  upstream: {
    requests: Array<{ status: number; headers: Record<string, string>; json: unknown; rawBytes: number }>;
    responses: unknown[];
  };
  process: { exitCode: number | null };
  verifiers: Record<string, unknown>;
}

export interface AssertionResult {
  id: string;
  operator: string;
  required: boolean;
  passed: boolean;
  observedSummary: string;
  reason?: string;
}

export interface ProtocolExecutionContextV1 {
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
}

export interface ScenarioRunResult {
  scenarioId: string;
  suite: string;
  startedAt: number;
  completedAt: number;
  passed: boolean;
  classification: FailureClassification;
  secondaryCode?: string;
  assertionResults: AssertionResult[];
  expectedFailureMatched?: boolean;
  diagnostics: string[];
  executionContext: ProtocolExecutionContextV1;
}

/** All eight live-route compatibility suites frozen by CL-03 Live V1. */
export const CL03_LIVE_SUITES = [
  "responses-core",
  "chat-core",
  "anthropic-core",
  "tools-core",
  "codex-core",
  "vision-core",
  "reasoning-core",
  "mcp-core",
] as const;

/** All eight protocol-conformance suites frozen by CL-00 Protocol V1. */
export const CL01_SUITES = [
  "responses-core",
  "chat-core",
  "anthropic-core",
  "tools-core",
  "codex-core",
  "vision-core",
  "reasoning-core",
  "mcp-core",
] as const;
