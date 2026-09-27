/**
 * Wire shapes for protocol plans (predicted) and protocol traces (observed).
 *
 * LEAF MODULE (see `contract.ts`). Both the management API and the dashboard validate with
 * the functions here, so a record from an older or newer server is rejected rather than
 * half-rendered. Every field is drawn from a fixed vocabulary or is a bounded identifier the
 * server already exposes (provider and model names); nothing is conversation-derived.
 */
import {
  isDeliveryMode,
  isFidelity,
  isProtocol,
  isProtocolHop,
  isProtocolReasonCode,
  isUpstreamWire,
  type DeliveryMode,
  type Fidelity,
  type Protocol,
  type ProtocolHop,
  type ProtocolReasonCode,
  type UpstreamWire,
} from "./contract";
import { isProtocolFeature, type FeatureDisposition, type ProtocolFeature } from "./features";

export const PROTOCOL_PLAN_SCHEMA_VERSION = 1 as const;
export const PROTOCOL_TRACE_SCHEMA_VERSION = 1 as const;

/** Upper bounds shared by producers and validators. */
export const PROTOCOL_DTO_LIMITS = {
  pathHops: 6,
  reasonCodes: 8,
  featureEffects: 24,
  candidates: 16,
  attempts: 16,
  identifierLength: 200,
} as const;

export interface ProtocolFeatureEffectV1 {
  feature: ProtocolFeature;
  disposition: FeatureDisposition;
}

/** One candidate route a plan considered. A direct route has exactly one. */
export interface ProtocolPlanCandidateV1 {
  provider: string;
  model: string;
  adapter: string;
  upstream: UpstreamWire;
  mode: DeliveryMode;
  requestPath: ProtocolHop[];
  responsePath: ProtocolHop[];
  fidelity: Fidelity;
  reasonCodes: ProtocolReasonCode[];
  featureEffects: ProtocolFeatureEffectV1[];
  /** Present features with no declared disposition on this candidate's path. */
  unknownFeatures: ProtocolFeature[];
  /** False when this candidate would be refused under the active unrepresentable policy. */
  eligible: boolean;
}

export interface ProtocolPlanV1 {
  schemaVersion: typeof PROTOCOL_PLAN_SCHEMA_VERSION;
  basis: "preview" | "dispatch";
  contractVersion: string;
  /** Opaque digest of the config inputs the plan read; changes when a relevant setting changes. */
  policyRevision: string;
  inbound: Protocol;
  requestedModel: string;
  routeKind: "direct" | "combo" | "policy" | "unknown";
  /** Mode of the first eligible candidate, or `blocked` when none is eligible. */
  mode: DeliveryMode;
  reasonCodes: ProtocolReasonCode[];
  candidates: ProtocolPlanCandidateV1[];
  /** Features every eligible candidate preserves (passthrough or translated). */
  guaranteedFeatures: ProtocolFeature[];
  /** Features preserved by some, but not all, eligible candidates. */
  partialFeatures: ProtocolFeature[];
}

/** What one physical attempt actually did. */
export interface ProtocolAttemptTraceV1 {
  ordinal: number;
  upstream: UpstreamWire;
  mode: Exclude<DeliveryMode, "blocked">;
  requestPath: ProtocolHop[];
  /** Omitted when it is the reverse of `requestPath`. */
  responsePath?: ProtocolHop[];
}

/** What one request actually did, recorded at the send boundary and persisted with the log row. */
export interface ProtocolTraceV1 {
  v: typeof PROTOCOL_TRACE_SCHEMA_VERSION;
  inbound: Protocol;
  /** Final attempt's mode, or `blocked` when refused before any send. */
  mode: DeliveryMode;
  upstream?: UpstreamWire;
  requestPath: ProtocolHop[];
  responsePath: ProtocolHop[];
  reasonCodes: ProtocolReasonCode[];
  featureEffects?: ProtocolFeatureEffectV1[];
  attempts?: ProtocolAttemptTraceV1[];
  /** Set only by shadow-plan comparison (`protocols.rollout.shadowPlan`) when the dispatch plan disagreed. */
  planMismatch?: true;
  contractVersion: string;
}

/** Who decided the wire a provider (or one of its models) receives. */
export const PROTOCOL_ADAPTER_SOURCES = ["hard-pin", "operator", "registry", "provider-default"] as const;
export type ProtocolAdapterSource = (typeof PROTOCOL_ADAPTER_SOURCES)[number];

/** Upper bound on the per-model overrides one provider summary lists. */
export const PROTOCOL_PROVIDER_OVERRIDE_LIMIT = 64;

/** One model whose upstream wire differs from, or was decided apart from, the provider's. */
export interface ProtocolProviderModelOverrideV1 {
  model: string;
  adapter: string;
  source: ProtocolAdapterSource;
}

/**
 * The `provider` block of `GET /api/protocols?provider=<name>`: the upstream wire a provider
 * receives and who decided it. Static config only; no credential, base URL or header.
 */
export interface ProtocolProviderSummaryV1 {
  name: string;
  adapter: string;
  adapterSource: ProtocolAdapterSource;
  /** Resolved auth mode (`key`, `oauth`, `forward`, `local`), or null when none resolves. */
  authMode: string | null;
  upstream: UpstreamWire;
  modelOverrides: ProtocolProviderModelOverrideV1[];
  /** Set when more overrides exist than `PROTOCOL_PROVIDER_OVERRIDE_LIMIT` allows to list. */
  modelOverridesTruncated?: true;
}

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const DISPOSITIONS = new Set<string>(["passthrough", "translated", "degraded", "unsupported"]);

function boundedArray<T>(value: unknown, max: number, item: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.length <= max && value.every(item);
}
function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= PROTOCOL_DTO_LIMITS.identifierLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}
function isFeatureEffect(value: unknown): value is ProtocolFeatureEffectV1 {
  return isRec(value) && isProtocolFeature(value.feature) && typeof value.disposition === "string"
    && DISPOSITIONS.has(value.disposition);
}
function isPath(value: unknown): value is ProtocolHop[] {
  return boundedArray(value, PROTOCOL_DTO_LIMITS.pathHops, isProtocolHop) && value.length > 0;
}
function isReasonCodes(value: unknown): value is ProtocolReasonCode[] {
  return boundedArray(value, PROTOCOL_DTO_LIMITS.reasonCodes, isProtocolReasonCode);
}
function isFeatureList(value: unknown): value is ProtocolFeature[] {
  return boundedArray(value, PROTOCOL_DTO_LIMITS.featureEffects, isProtocolFeature);
}

export function isProtocolPlanCandidateV1(value: unknown): value is ProtocolPlanCandidateV1 {
  return isRec(value)
    && isIdentifier(value.provider)
    && isIdentifier(value.model)
    && isIdentifier(value.adapter)
    && isUpstreamWire(value.upstream)
    && isDeliveryMode(value.mode)
    && (value.mode === "blocked" ? Array.isArray(value.requestPath) : isPath(value.requestPath))
    && (value.mode === "blocked" ? Array.isArray(value.responsePath) : isPath(value.responsePath))
    && isFidelity(value.fidelity)
    && isReasonCodes(value.reasonCodes)
    && boundedArray(value.featureEffects, PROTOCOL_DTO_LIMITS.featureEffects, isFeatureEffect)
    && isFeatureList(value.unknownFeatures)
    && typeof value.eligible === "boolean";
}

export function isProtocolPlanV1(value: unknown): value is ProtocolPlanV1 {
  return isRec(value)
    && value.schemaVersion === PROTOCOL_PLAN_SCHEMA_VERSION
    && (value.basis === "preview" || value.basis === "dispatch")
    && typeof value.contractVersion === "string"
    && typeof value.policyRevision === "string"
    && isProtocol(value.inbound)
    && isIdentifier(value.requestedModel)
    && (value.routeKind === "direct" || value.routeKind === "combo" || value.routeKind === "policy" || value.routeKind === "unknown")
    && isDeliveryMode(value.mode)
    && isReasonCodes(value.reasonCodes)
    && boundedArray(value.candidates, PROTOCOL_DTO_LIMITS.candidates, isProtocolPlanCandidateV1)
    && isFeatureList(value.guaranteedFeatures)
    && isFeatureList(value.partialFeatures);
}

function isAttemptTrace(value: unknown): value is ProtocolAttemptTraceV1 {
  return isRec(value)
    && typeof value.ordinal === "number" && Number.isInteger(value.ordinal) && value.ordinal > 0
    && isUpstreamWire(value.upstream)
    && isDeliveryMode(value.mode) && value.mode !== "blocked"
    && isPath(value.requestPath)
    && (value.responsePath === undefined || isPath(value.responsePath));
}

export function isProtocolTraceV1(value: unknown): value is ProtocolTraceV1 {
  if (!isRec(value) || value.v !== PROTOCOL_TRACE_SCHEMA_VERSION) return false;
  if (!isProtocol(value.inbound) || !isDeliveryMode(value.mode)) return false;
  if (value.upstream !== undefined && !isUpstreamWire(value.upstream)) return false;
  const pathsOk = value.mode === "blocked"
    ? Array.isArray(value.requestPath) && value.requestPath.length === 0
      && Array.isArray(value.responsePath) && value.responsePath.length === 0
    : isPath(value.requestPath) && isPath(value.responsePath);
  if (!pathsOk || !isReasonCodes(value.reasonCodes) || typeof value.contractVersion !== "string") return false;
  if (value.featureEffects !== undefined
    && !boundedArray(value.featureEffects, PROTOCOL_DTO_LIMITS.featureEffects, isFeatureEffect)) return false;
  if (value.attempts !== undefined && !boundedArray(value.attempts, PROTOCOL_DTO_LIMITS.attempts, isAttemptTrace)) return false;
  if (value.planMismatch !== undefined && value.planMismatch !== true) return false;
  return true;
}

/**
 * Parse a persisted or received trace into a detached copy, or `undefined` when it is not a
 * valid v1 trace. Old rows without a trace stay `undefined`; callers render "no path data"
 * instead of guessing.
 */
export function parseProtocolTraceV1(value: unknown): ProtocolTraceV1 | undefined {
  if (!isProtocolTraceV1(value)) return undefined;
  return {
    v: PROTOCOL_TRACE_SCHEMA_VERSION,
    inbound: value.inbound,
    mode: value.mode,
    ...(value.upstream !== undefined ? { upstream: value.upstream } : {}),
    requestPath: [...value.requestPath],
    responsePath: [...value.responsePath],
    reasonCodes: [...value.reasonCodes],
    ...(value.featureEffects ? { featureEffects: value.featureEffects.map(effect => ({ ...effect })) } : {}),
    ...(value.attempts ? {
      attempts: value.attempts.map(attempt => ({
        ...attempt,
        requestPath: [...attempt.requestPath],
        ...(attempt.responsePath ? { responsePath: [...attempt.responsePath] } : {}),
      })),
    } : {}),
    ...(value.planMismatch ? { planMismatch: true as const } : {}),
    contractVersion: value.contractVersion,
  };
}

const ADAPTER_SOURCES = new Set<string>(PROTOCOL_ADAPTER_SOURCES);
function isAdapterSource(value: unknown): value is ProtocolAdapterSource {
  return typeof value === "string" && ADAPTER_SOURCES.has(value);
}

function isModelOverride(value: unknown): value is ProtocolProviderModelOverrideV1 {
  return isRec(value) && isIdentifier(value.model) && isIdentifier(value.adapter) && isAdapterSource(value.source);
}

export function isProtocolProviderSummaryV1(value: unknown): value is ProtocolProviderSummaryV1 {
  return isRec(value)
    && isIdentifier(value.name)
    && isIdentifier(value.adapter)
    && isAdapterSource(value.adapterSource)
    && (value.authMode === null || isIdentifier(value.authMode))
    && isUpstreamWire(value.upstream)
    && boundedArray(value.modelOverrides, PROTOCOL_PROVIDER_OVERRIDE_LIMIT, isModelOverride)
    && (value.modelOverridesTruncated === undefined || value.modelOverridesTruncated === true);
}
