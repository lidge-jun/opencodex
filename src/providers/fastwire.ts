import type {
  AttemptTierOutcome,
  FastWire,
  OcxProviderConfig,
  TierDecision,
  TierObservationContext,
} from "../types";
import { MODEL_ADAPTER_OVERRIDE_ALLOWED } from "../types";
import { sanitizeLogMetadataString } from "../lib/redact";
import type { InboundWire, ModelWireDefault, ProviderAuthKind } from "./registry";

const SERVICE_TIER_ADAPTERS = new Set(["openai-chat", "openai-responses"]);
const FAST_WIRE_ADAPTERS: Readonly<Record<FastWire["kind"], ReadonlySet<string>>> = {
  "service-tier": SERVICE_TIER_ADAPTERS,
  // A1 deliberately has no adapter implementation for Anthropic speed.
  "anthropic-speed": new Set(),
};

const DEFAULT_SERVICE_TIER_FAST_WIRE: FastWire = Object.freeze({
  kind: "service-tier" as const,
  canonicalToWire: Object.freeze({ priority: "priority" }),
  foreignCallerTiers: "verbatim" as const,
});

export type FastPolicyAuthTransport =
  | "oauth_bearer"
  | "forwarded_authorization"
  | "none"
  | "x_api_key"
  | "authorization_bearer";

export interface FastPolicyAuthority {
  readonly providerAdapter: string;
  readonly providerAuthMode?: ProviderAuthKind;
  readonly fastWireDeclaration: FastWire | null | undefined;
  readonly fastTierDescription?: string;
  readonly modelWireOverrideAllowed: boolean;
  readonly authTransport: FastPolicyAuthTransport;
  readonly capability: {
    readonly provider?: boolean;
    readonly models: Readonly<Record<string, boolean>>;
    readonly chatServiceTier?: boolean;
  };
  readonly modelAdapters: Readonly<Record<string, string>>;
  readonly hardPins: Readonly<Record<string, string>>;
  readonly registryWireDefaults: Readonly<Record<string, ModelWireDefault>>;
}

export interface ResolvedFastPolicy {
  readonly capability: boolean | undefined;
  readonly eligibility:
    | "eligible"
    | "capability-unsupported"
    | "unclassified"
    | "wire-unavailable"
    | "pin-unavailable";
  readonly adapter: string;
  readonly fastWire: FastWire | null;
  readonly fastTierDescription?: string;
  readonly forwardCallerTier: boolean;
}

/** Adapter-owned response observer paired with the exact body that adapter serialized. */
export interface AdapterTierMetadata {
  readonly outcome: AttemptTierOutcome;
  observeResponseServiceTier(value: unknown): void;
  markResponseUnparseable(): void;
}

/** Detach a FastWire declaration from config or registry ownership. */
export function cloneFastWire(
  value: FastWire | null | undefined,
  options: { freeze?: boolean } = {},
): FastWire | null | undefined {
  if (value === null || value === undefined) return value;
  const canonicalToWire = { ...value.canonicalToWire };
  const betas = value.betas ? [...value.betas] : undefined;
  if (options.freeze) {
    Object.freeze(canonicalToWire);
    if (betas) Object.freeze(betas);
  }
  const clone: FastWire = {
    ...value,
    canonicalToWire,
    ...(betas ? { betas } : {}),
  };
  return options.freeze ? Object.freeze(clone) : clone;
}

function exactModelValue<T>(record: Readonly<Record<string, T>>, modelId: string): T | undefined {
  if (Object.prototype.hasOwnProperty.call(record, modelId)) return record[modelId];
  const folded = modelId.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === folded) return value;
  }
  return undefined;
}

export function resolveProviderAuthTransport(
  adapter: string,
  mode: NonNullable<OcxProviderConfig["authMode"]>,
  apiKeyTransport?: OcxProviderConfig["apiKeyTransport"],
): FastPolicyAuthTransport {
  if (mode === "oauth") return "oauth_bearer";
  if (mode === "forward") return "forwarded_authorization";
  if (mode === "local") return "none";
  if (adapter === "anthropic" && apiKeyTransport !== "bearer") return "x_api_key";
  return "authorization_bearer";
}

/** Adapter-derived declaration. This runs only after the final model wire is known. */
export function defaultFastWireForAdapter(adapter: string): FastWire | null {
  return SERVICE_TIER_ADAPTERS.has(adapter) ? DEFAULT_SERVICE_TIER_FAST_WIRE : null;
}

function registryDefaultForModel(
  defaults: Readonly<Record<string, ModelWireDefault>>,
  modelId: string,
  inbound: InboundWire,
  authMode: ProviderAuthKind | undefined,
): { adapter: string; forwardCallerServiceTier?: boolean } | undefined {
  const normalizedModelId = modelId.trim().toLowerCase();
  if (!Object.hasOwn(defaults, normalizedModelId)) return undefined;
  const declared = defaults[normalizedModelId];
  if (declared === undefined) return undefined;
  if (typeof declared !== "string") {
    if (!declared.inbound.includes(inbound)) return undefined;
    if (declared.authModes && (authMode === undefined || !declared.authModes.includes(authMode))) {
      return undefined;
    }
  }
  const wire = typeof declared === "string" ? declared : declared.wire;
  if (!MODEL_ADAPTER_OVERRIDE_ALLOWED.has(wire)) return undefined;
  return {
    adapter: wire,
    ...(typeof declared !== "string" && declared.forwardCallerServiceTier !== undefined
      ? { forwardCallerServiceTier: declared.forwardCallerServiceTier }
      : {}),
  };
}

function resolvePolicyAdapter(
  authority: FastPolicyAuthority,
  modelId: string,
  inbound: InboundWire,
): { adapter: string; hardPinned: boolean; forwardCallerServiceTier?: boolean } {
  // Hard pins and configured overrides deliberately use the same exact-key semantics as
  // resolveWireProtocolOverride(). Registry route policy normalizes ids at its boundary.
  const hardPin = Object.hasOwn(authority.hardPins, modelId)
    ? authority.hardPins[modelId]
    : undefined;
  if (typeof hardPin === "string") return { adapter: hardPin, hardPinned: true };
  if (authority.modelWireOverrideAllowed) {
    const registryDefault = MODEL_ADAPTER_OVERRIDE_ALLOWED.has(authority.providerAdapter)
      ? registryDefaultForModel(
          authority.registryWireDefaults,
          modelId,
          inbound,
          authority.providerAuthMode,
        )
      : undefined;
    const configured = Object.hasOwn(authority.modelAdapters, modelId)
      ? authority.modelAdapters[modelId]
      : undefined;
    if (typeof configured === "string" && MODEL_ADAPTER_OVERRIDE_ALLOWED.has(configured)) {
      return {
        adapter: configured,
        hardPinned: false,
        ...(registryDefault?.forwardCallerServiceTier === false
          ? { forwardCallerServiceTier: false }
          : {}),
      };
    }
    if (registryDefault !== undefined) {
      return {
        adapter: registryDefault.adapter,
        hardPinned: false,
        ...(registryDefault.forwardCallerServiceTier !== undefined
          ? { forwardCallerServiceTier: registryDefault.forwardCallerServiceTier }
          : {}),
      };
    }
  }
  return { adapter: authority.providerAdapter, hardPinned: false };
}

export function resolveFastPolicy(
  authority: FastPolicyAuthority,
  modelId: string,
  inbound: InboundWire = "responses",
): ResolvedFastPolicy {
  const { adapter, hardPinned, forwardCallerServiceTier } = resolvePolicyAdapter(
    authority,
    modelId,
    inbound,
  );
  const exactCapability = exactModelValue(authority.capability.models, modelId);
  const capability = authority.capability.provider === false
    ? false
    : exactCapability ?? authority.capability.provider;
  const fastWire = authority.fastWireDeclaration === undefined
    ? defaultFastWireForAdapter(adapter)
    : authority.fastWireDeclaration;
  const wireAvailable = fastWire !== null && FAST_WIRE_ADAPTERS[fastWire.kind].has(adapter);
  // Explicit null disables Fast injection, but the defensive true+null branch still preserves
  // a caller tier on an existing OpenAI service-tier wire.
  const callerWireAvailable = wireAvailable
    || (fastWire === null && SERVICE_TIER_ADAPTERS.has(adapter));
  // On classified routes this permission applies only to a caller's foreign tier: proxy-owned
  // canonical Fast has already passed capability validation. On unclassified routes every caller
  // tier still needs the final wire's forwarding permission.
  const forwardCallerTier = capability !== false
    && callerWireAvailable
    && forwardCallerServiceTier !== false
    && (adapter !== "openai-chat" || authority.capability.chatServiceTier === true);

  let eligibility: ResolvedFastPolicy["eligibility"];
  if (capability === false) eligibility = "capability-unsupported";
  else if (!wireAvailable) {
    eligibility = hardPinned && authority.fastWireDeclaration !== null
      ? "pin-unavailable"
      : "wire-unavailable";
  }
  else if (capability === undefined) eligibility = "unclassified";
  else eligibility = "eligible";

  return {
    capability,
    eligibility,
    adapter,
    fastWire,
    ...(authority.fastTierDescription !== undefined
      ? { fastTierDescription: authority.fastTierDescription }
      : {}),
    forwardCallerTier,
  };
}

export function canonicalFastTierMarker(callerTier: string | undefined): "priority" | undefined {
  const folded = callerTier?.trim().toLowerCase();
  return folded === "priority" || folded === "fast" ? "priority" : undefined;
}

/** Capture Fast demand before the final A1 serialization action rewrites the parsed tier view. */
export function tierObservationContext(
  policy: ResolvedFastPolicy,
  fastMode: boolean | undefined,
  callerTier: string | undefined,
  responseTierAuthoritative?: boolean,
): TierObservationContext {
  return {
    capability: policy.capability,
    eligibility: policy.eligibility,
    fastWire: policy.fastWire,
    demandDecision: fastMode === true ? "force-fast" : fastMode === false ? "force-default" : "inherit",
    ...(callerTier !== undefined ? { callerTier } : {}),
    ...(responseTierAuthoritative !== undefined ? { responseTierAuthoritative } : {}),
  };
}

function canonicalFromWire(
  fastWire: FastWire | null,
  wireValue: string,
): string | undefined {
  if (!fastWire) return undefined;
  for (const [canonical, mapped] of Object.entries(fastWire.canonicalToWire)) {
    if (mapped === wireValue) return canonical;
  }
  return undefined;
}

function downgradeReasonForUnavailable(
  context: TierObservationContext,
): AttemptTierOutcome["fastDowngradeReason"] {
  if (context.capability === false || context.eligibility === "capability-unsupported") {
    return "route-unsupported";
  }
  return "wire-unavailable";
}

/**
 * Build the mutable observation record only after an adapter has completed serialization.
 * `wireKind`/`wireValue` describe the field the adapter actually emitted, never a route guess.
 */
export function createAdapterTierMetadata(
  context: TierObservationContext | undefined,
  decision: TierDecision | undefined,
  wireKind: FastWire["kind"] | null,
  wireValue: string | null,
): AdapterTierMetadata | undefined {
  if (!context || !decision) return undefined;

  const callerCanonicalFast = canonicalFastTierMarker(context.callerTier) === "priority";
  const callerTierDropped = context.callerTier !== undefined
    && !callerCanonicalFast
    && wireValue === null;
  const callerFastSuppressedByConfig = context.capability !== undefined
    && context.demandDecision === "force-default"
    && callerCanonicalFast;
  const loggedWireValue = wireValue === null ? null : sanitizeLogMetadataString(wireValue);
  const outcome: AttemptTierOutcome = {
    wireKind,
    ...(wireValue === null
      ? { wireValue: null }
      : loggedWireValue ? { wireValue: loggedWireValue } : {}),
    fastOutcome: "unknown",
    confirmation: "unknown",
    ...(callerTierDropped ? { callerTierDropped: true } : {}),
    ...(callerFastSuppressedByConfig ? { callerFastSuppressedByConfig: true } : {}),
  };

  // A0/A1 deliberately make fastMode inert for unclassified routes. Preserve that uncertainty:
  // do not infer demand, suppression, or a canonical tier from a verbatim caller passthrough.
  if (context.capability === undefined || context.eligibility === "unclassified") {
    delete outcome.callerFastSuppressedByConfig;
    return {
      outcome,
      observeResponseServiceTier(value: unknown) {
        const sanitized = sanitizeLogMetadataString(value);
        if (sanitized) outcome.responseServiceTier = sanitized;
      },
      markResponseUnparseable() {},
    };
  }

  const effectiveFastRequested = context.capability === true
    && context.fastWire !== null
    && (context.demandDecision === "force-fast"
      || (context.demandDecision === "inherit" && callerCanonicalFast));
  // Known-unsupported routes still need a downgrade when the caller/config expressed Fast intent,
  // but they are deliberately outside the effective-demand calculation above.
  const fastIntent = context.demandDecision === "force-fast"
    || (context.demandDecision === "inherit" && callerCanonicalFast);

  if (!fastIntent) {
    outcome.fastOutcome = "not-requested";
  } else if (!effectiveFastRequested || context.eligibility !== "eligible" || wireValue === null) {
    outcome.fastOutcome = "downgraded";
    outcome.fastDowngradeReason = downgradeReasonForUnavailable(context);
    outcome.confirmation = "downgraded";
  } else if (canonicalFromWire(context.fastWire, wireValue) === "priority") {
    outcome.canonical = "priority";
    outcome.fastOutcome = "applied";
    outcome.confirmation = "assumed";
  }

  const responseCanConfirmFast = effectiveFastRequested
    && context.eligibility === "eligible"
    && wireValue !== null
    // A destination whose echo is not authoritative can neither confirm nor deny Fast. The
    // ChatGPT-internal Codex backend echoes "default" on priority-scheduled turns, so believing
    // it reported every Fast request as `response-declined` (#2558).
    && context.responseTierAuthoritative !== false;
  return {
    outcome,
    observeResponseServiceTier(value: unknown) {
      if (typeof value !== "string" || !value.trim()) {
        if (value !== undefined && responseCanConfirmFast) {
          delete outcome.canonical;
          delete outcome.fastDowngradeReason;
          outcome.fastOutcome = "unknown";
          outcome.confirmation = "unknown";
        }
        return;
      }
      const sanitized = sanitizeLogMetadataString(value);
      if (sanitized) outcome.responseServiceTier = sanitized;
      if (!responseCanConfirmFast) return;
      if (canonicalFromWire(context.fastWire, value) === "priority") {
        outcome.canonical = "priority";
        delete outcome.fastDowngradeReason;
        outcome.fastOutcome = "applied";
        outcome.confirmation = "confirmed";
      } else {
        delete outcome.canonical;
        outcome.fastOutcome = "downgraded";
        outcome.fastDowngradeReason = "response-declined";
        outcome.confirmation = "downgraded";
      }
    },
    markResponseUnparseable() {
      if (!responseCanConfirmFast) return;
      delete outcome.canonical;
      delete outcome.fastDowngradeReason;
      delete outcome.responseServiceTier;
      outcome.fastOutcome = "unknown";
      outcome.confirmation = "unknown";
    },
  };
}

/** Pure tier state machine. B1 normalizes canonical Fast on classified inherit routes. */
export function decideTier(
  policy: ResolvedFastPolicy,
  fastMode: boolean | undefined,
  callerTier: string | undefined,
): TierDecision {
  if (policy.capability === false) return { kind: "drop" };
  if (policy.capability === undefined) {
    return policy.forwardCallerTier ? { kind: "forward-caller" } : { kind: "drop" };
  }
  if (policy.fastWire === null) {
    return policy.forwardCallerTier ? { kind: "forward-caller" } : { kind: "drop" };
  }
  if (policy.eligibility !== "eligible") return { kind: "drop" };
  if (fastMode === true) {
    const value = policy.fastWire.canonicalToWire.priority;
    return typeof value === "string" && value.length > 0
      ? { kind: "set", value }
      : { kind: "drop" };
  }
  if (fastMode === false) return { kind: "drop" };
  const callerCanonicalFast = canonicalFastTierMarker(callerTier);
  if (callerCanonicalFast !== undefined) {
    const value = policy.fastWire.canonicalToWire[callerCanonicalFast];
    return typeof value === "string" && value.length > 0
      ? { kind: "set", value }
      : { kind: "drop" };
  }
  if (callerTier !== undefined && !policy.forwardCallerTier) return { kind: "drop" };
  if (
    callerTier !== undefined
    && policy.fastWire.foreignCallerTiers === "drop"
  ) {
    return { kind: "drop" };
  }
  return { kind: "forward-caller" };
}

export function tierValueAfterDecision(
  decision: TierDecision,
  callerTier: string | undefined,
): string | undefined {
  if (decision.kind === "set") return decision.value;
  if (decision.kind === "drop") return undefined;
  return callerTier;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasFastWireCapabilityConflict(source: {
  readonly fastWire?: unknown;
  readonly supportsServiceTier?: unknown;
  readonly modelSupportsServiceTier?: unknown;
}): boolean {
  if (source.fastWire !== null) return false;
  if (source.supportsServiceTier === false) return false;
  if (source.supportsServiceTier === true) return true;
  return isPlainRecord(source.modelSupportsServiceTier)
    && Object.values(source.modelSupportsServiceTier).some(value => value === true);
}

/** Runtime registry validation; config uses the equivalent Zod shape at its boundary. */
export function fastWireDeclarationError(source: {
  readonly fastWire?: unknown;
  readonly supportsServiceTier?: unknown;
  readonly modelSupportsServiceTier?: unknown;
}): string | null {
  const value = source.fastWire;
  if (value === undefined) return null;
  if (hasFastWireCapabilityConflict(source)) {
    return "fastWire=null conflicts with supportsServiceTier=true";
  }
  if (value === null) return null;
  if (!isPlainRecord(value)) return "fastWire must be an object, null, or absent";
  if (value.kind !== "service-tier" && value.kind !== "anthropic-speed") {
    return "fastWire.kind must be service-tier or anthropic-speed";
  }
  if (value.foreignCallerTiers !== "verbatim" && value.foreignCallerTiers !== "drop") {
    return "fastWire.foreignCallerTiers must be verbatim or drop";
  }
  if (!isPlainRecord(value.canonicalToWire)) return "fastWire.canonicalToWire must be an object";
  if (!Object.prototype.hasOwnProperty.call(value.canonicalToWire, "priority")) {
    return "fastWire.canonicalToWire must include priority";
  }
  const wireValues: string[] = [];
  for (const [canonicalTier, wireValue] of Object.entries(value.canonicalToWire)) {
    if (canonicalTier.trim().length === 0) {
      return "fastWire.canonicalToWire keys must be nonblank strings";
    }
    if (typeof wireValue !== "string" || wireValue.trim().length === 0 || wireValue.trim().length > 64) {
      return "fastWire.canonicalToWire values must be nonblank strings of at most 64 characters";
    }
    wireValues.push(wireValue.trim());
  }
  if (new Set(wireValues).size !== wireValues.length) {
    return "fastWire.canonicalToWire values must be unique";
  }
  if (value.betas !== undefined) {
    if (!Array.isArray(value.betas) || value.betas.length > 16) {
      return "fastWire.betas must be an array of at most 16 values";
    }
    const betas: string[] = [];
    for (const beta of value.betas) {
      if (typeof beta !== "string" || beta.trim().length === 0) {
        return "fastWire.betas values must be nonblank strings";
      }
      betas.push(beta.trim());
    }
    if (new Set(betas).size !== betas.length) return "fastWire.betas values must be unique";
  }
  return null;
}
