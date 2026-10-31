import type { AdmissionModelScope } from "./admission-model-scope";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import { internalCallCapability, isInternalCallCapability } from "../lib/local-internal-call-capability";
import { immutableAdmissionPolicy } from "./capture-admission-policy";

export const ADVISOR_ADMISSION_POLICY_HEADER = "x-opencodex-advisor-admission-policy";
/** Routed helpers inherit policy without acquiring the Advisor recursion-suppression flag. */
export const SIDECAR_ADMISSION_POLICY_HEADER = "x-opencodex-sidecar-admission-policy";
export const SIDECAR_INTERNAL_CAPABILITY_HEADER = "x-opencodex-sidecar-internal";
const policies = new Map<string, { capability: string; policy: CapturedAdmissionPolicy }>();

/** A consult owns its registry entry until completion, failure or cancellation. */
export function registerAdvisorAdmissionPolicy(policy: CapturedAdmissionPolicy, signal?: AbortSignal) {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const release = () => {
    policies.delete(token);
    signal?.removeEventListener("abort", release);
  };
  if (!signal?.aborted) {
    policies.set(token, { capability: internalCallCapability(), policy: immutableAdmissionPolicy(policy) });
    signal?.addEventListener("abort", release, { once: true });
  }
  return { token, release };
}

export function readAdvisorAdmissionPolicy(token: string | null, capability: string | null): CapturedAdmissionPolicy | undefined {
  if (!token || !isInternalCallCapability(capability)) return undefined;
  const entry = policies.get(token);
  return entry?.capability === capability ? entry.policy : undefined;
}

/** Scope metadata accepted only alongside the process-owned Advisor capability. */
export const ADVISOR_ADMISSION_SCOPE_HEADER = "x-opencodex-advisor-admission-scope";

/**
 * The wire bound both ends share: the decoder refuses a longer value, so the encoder must
 * refuse first rather than emit a header the peer is guaranteed to reject mid-request.
 */
export const MAX_ADVISOR_ADMISSION_SCOPE_VALUE_LENGTH = 16_384;

/** A scope whose encoded form exceeds the shared wire bound. */
export class AdvisorAdmissionScopeEncodedBoundExceeded extends Error {
  constructor() {
    super("advisor admission scope exceeds encoded bound");
    this.name = "AdvisorAdmissionScopeEncodedBoundExceeded";
  }
}

export function encodeAdvisorAdmissionScope(scope: AdmissionModelScope): string {
  const value = Buffer.from(JSON.stringify({ providers: scope.providers, models: scope.models }), "utf8").toString("base64url");
  // Never truncate or drop the scope silently: losing it would let the consult run wider
  // than the caller is allowed. The caller turns this into a controlled pre-fetch failure.
  if (value.length > MAX_ADVISOR_ADMISSION_SCOPE_VALUE_LENGTH) {
    throw new AdvisorAdmissionScopeEncodedBoundExceeded();
  }
  return value;
}

export function decodeAdvisorAdmissionScope(value: string | null): AdmissionModelScope | undefined {
  if (!value || value.length > MAX_ADVISOR_ADMISSION_SCOPE_VALUE_LENGTH) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const { providers, models } = parsed as { providers?: unknown; models?: unknown };
    if (!Array.isArray(providers) || !Array.isArray(models)
      || providers.some(item => typeof item !== "string")
      || models.some(item => typeof item !== "string")) return undefined;
    return { providers, models };
  } catch {
    return undefined;
  }
}
