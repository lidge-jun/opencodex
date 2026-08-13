import type { FailureClassification, NormalizedObservation } from "../conformance/types";
import type { RouteDependencyV1, RouteSubjectV1 } from "../events/types";

export interface LabDestinationV1 {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly port: number;
  readonly basePath: string;
  readonly sniHost: string;
  readonly addresses: ReadonlyArray<{ readonly address: string; readonly family: 4 | 6 }>;
  readonly privateNetwork: boolean;
  readonly fingerprint: string;
}

export type LabBehaviorSource =
  | "request"
  | "model_override"
  | "provider_config"
  | "registry_runtime_default"
  | "generated_model_metadata"
  | "global_config"
  | "adapter_default"
  | "lab_forced";

export interface LabBehaviorValue {
  source: LabBehaviorSource;
  value: unknown;
}

/** Authoritative effective values emitted by the production route/model/adapter resolver. */
export type LabBehaviorValues = Record<string, LabBehaviorValue>;

export interface LabRouteContext {
  providerId: string;
  /** Config-owner identity only; HMACed before it enters evidence. */
  providerInstanceKey: string;
  clientModelId: string;
  upstreamModelId: string;
  effectiveAdapter: string;
  inboundProtocol: string;
  upstreamProtocol: string;
  surface: string;
  baseUrl: string;
  /** Generated compatibility hash, not package marketing version. */
  opencodexCompatibilityVersion: string;
  /** Closed, effective behavior inputs from the production resolver. */
  behaviorValues: LabBehaviorValues;
  allowPrivateNetwork?: boolean;
  labRunApproval?: boolean;
  requiredClaims?: string[];
  availableHarnessFeatures?: string[];
  dependencies?: RouteDependencyV1[];
}

export interface LiveRunConfig {
  totalTimeoutMs: number;
  connectTimeoutMs: number;
  firstByteTimeoutMs: number;
  inactivityTimeoutMs: number;
  maxRequests: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxMemoryBytes: number;
  maxChildProcesses: number;
  maxArtifacts: number;
  perArtifactBytes: number;
  aggregateArtifactBytes: number;
}

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export type TransportErrorCode =
  | "auth_blocked"
  | "quota_blocked"
  | "network_blocked"
  | "region_blocked"
  | "provider_transient"
  | "redirect_blocked"
  | "destination_mismatch"
  | "host_sni_mismatch"
  | "connect_timeout"
  | "first_byte_timeout"
  | "inactivity_timeout"
  | "total_timeout"
  | "request_limit"
  | "input_byte_limit"
  | "output_byte_limit"
  | "output_token_limit"
  | "tool_call_limit"
  | "artifact_byte_limit"
  | "memory_limit"
  | "child_process_limit"
  | "live_transport_required"
  | "untrusted_route_executor"
  | "harness_failure";

export interface LabTransportRequest {
  method: "GET" | "POST";
  path: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface LabTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type TransportRequest = LabTransportRequest;
export type TransportResponse = LabTransportResponse;

export interface LabTransport {
  request(req: LabTransportRequest): Promise<LabTransportResponse>;
}

export const LAB_CREDENTIAL_LEASE = Symbol("LabCredentialLeaseV1");

/** Opaque capability. Scope metadata and secret material are deliberately not public fields. */
export interface LabCredentialLeaseV1 {
  readonly [LAB_CREDENTIAL_LEASE]: true;
  readonly remainingRequests: number;
  consume(): void;
}

export interface LabPinnedAddress {
  address: string;
  family: 4 | 6;
}

/** Trusted provider/credential transport seam. Implementations own secret injection outside Lab. */
export type LabPinnedSender = (
  lease: LabCredentialLeaseV1,
  destination: LabDestinationV1,
  pinned: LabPinnedAddress,
  request: LabTransportRequest,
  signal: AbortSignal,
  limits: LiveRunConfig,
) => Promise<LabTransportResponse>;

export interface LabRouteExecutorInput {
  routeContext: LabRouteContext;
  destination: LabDestinationV1;
  routeSubject: RouteSubjectV1;
  scenarioId: string;
  initiatingRequest?: string;
  limits: LiveRunConfig;
  signal: AbortSignal;
  environment: Readonly<Record<string, string>>;
}

/** Trusted exact-route execution function. The wrapper capability is issued only by the host integration. */
export type LabRouteExecutor = (input: LabRouteExecutorInput) => Promise<NormalizedObservation>;

export const REQUIRED_LAB_SANDBOX_BOUNDARIES = [
  "destination_pinning",
  "credential_binding",
  "wall_clock",
  "connect_timeout",
  "first_byte_timeout",
  "inactivity_timeout",
  "request_budget",
  "input_byte_budget",
  "output_byte_budget",
  "output_token_budget",
  "tool_call_budget",
  "memory_limit",
  "child_process_limit",
  "artifact_budget",
] as const;
export type LabSandboxBoundary = typeof REQUIRED_LAB_SANDBOX_BOUNDARIES[number];

/** Opaque host-issued capability; runtime trust is established outside Lab. */
export interface TrustedLabRouteExecutor {
  execute(input: LabRouteExecutorInput): Promise<NormalizedObservation>;
  readonly enforcedBoundaries: readonly LabSandboxBoundary[];
}

export type LiveExecutionAuthority = "trusted_route" | "test_transport" | "none";

export interface LiveScenarioRunResult {
  scenarioId: string;
  suite: string;
  startedAt: number;
  completedAt: number;
  passed: boolean;
  classification: FailureClassification;
  secondaryCode?: string;
  assertionResults: import("../conformance/types").AssertionResult[];
  diagnostics: string[];
  routeSubject?: RouteSubjectV1;
  transportError?: TransportErrorCode;
  executionAuthority: LiveExecutionAuthority;
}
