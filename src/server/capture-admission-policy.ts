import type { OcxConfig } from "../types";
import type { CapturedAdmissionPolicy } from "../types/admission-policy";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveDataPlaneAdmissionSecret } from "./auth-cors";
import { admissionMayUseMeteredComboTargets, intersectAdmissionModelScopes, resolveAdmissionModelScope } from "./admission-model-scope";
import { fallbackDeviceIds } from "../routing/fallback-policy";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function immutableAdmissionPolicy(policy: CapturedAdmissionPolicy): CapturedAdmissionPolicy {
  return freeze(structuredClone(policy));
}

/** Combine already captured inputs without reading mutable caller or host configuration. */
export function intersectAdmissionPolicies(host: CapturedAdmissionPolicy, caller: CapturedAdmissionPolicy): CapturedAdmissionPolicy {
  return immutableAdmissionPolicy({
    modelScope: intersectAdmissionModelScopes(host.modelScope, caller.modelScope)!,
    allowMeteredComboTargets: host.allowMeteredComboTargets && caller.allowMeteredComboTargets,
    meteredRequiresComboOptIn: host.meteredRequiresComboOptIn || caller.meteredRequiresComboOptIn,
    fallbackPolicies: [...host.fallbackPolicies, ...caller.fallbackPolicies],
  });
}

export function captureAdmissionPolicy(
  config: Pick<OcxConfig, "apiKeys" | "hostname" | "fallback">,
  admission?: DataPlaneAdmission,
  modelScope = resolveAdmissionModelScope(config, admission),
): CapturedAdmissionPolicy {
  return immutableAdmissionPolicy({
    modelScope: modelScope ?? { providers: [], models: [] },
    allowMeteredComboTargets: admissionMayUseMeteredComboTargets(config, admission, { allowMeteredTargets: true }),
    meteredRequiresComboOptIn: !admission || admission.kind === "loopback"
      || admission.callerPolicy?.meteredRequiresComboOptIn === true,
    fallbackPolicies: [
      ...(admission?.callerPolicy?.fallbackPolicies ?? []),
      { config: { fallback: config.fallback }, deviceIds: fallbackDeviceIds(config, admission) },
    ],
  });
}

/** Attach constraints without changing the host's transport/principal identity. */
export function inheritAdmissionPolicy(
  admission: DataPlaneAdmission | undefined,
  callerPolicy: CapturedAdmissionPolicy,
): DataPlaneAdmission {
  return Object.freeze({ ...(admission ?? { kind: "loopback", source: "loopback" }), callerPolicy }) as DataPlaneAdmission;
}

/**
 * Host policy of the data-plane credential an internal self-fetch presents (#7894).
 *
 * A loopback listener admits the self-fetch before it reads any token, so the listener snapshot
 * says "loopback" and carries none of the selected key's model scope, paid-combo consent or
 * device fallback identity. Call only after the internal capability and policy registration have
 * been validated. Returns undefined when no credential is presented, and null when the data plane
 * does not recognize it, which the caller must refuse rather than treat as unrestricted.
 */
export function captureSelfFetchCredentialPolicy(
  req: Request,
  config: Pick<OcxConfig, "apiKeys" | "hostname" | "fallback">,
): CapturedAdmissionPolicy | null | undefined {
  const presented = req.headers.get("x-opencodex-api-key")?.trim();
  if (!presented) return undefined;
  const admission = resolveDataPlaneAdmissionSecret(presented, config, "dedicated");
  return admission ? captureAdmissionPolicy(config, admission) : null;
}

/**
 * Host policy of an internal self-fetch whose presented credential was validated (#7894).
 *
 * Scope and fallback limits of the listener snapshot and the key both apply. Paid-combo consent
 * is the key's own when a loopback listener admitted the hop: that snapshot holds only the
 * loopback default, which a public proxy always refuses, so a consenting key would otherwise be
 * weaker over Advisor than on a direct request. The loopback snapshot still demands the combo's
 * own opt-in, and the caller's consent is intersected afterwards.
 */
export function selfFetchHostPolicy(
  listener: CapturedAdmissionPolicy,
  presented: CapturedAdmissionPolicy,
  listenerAdmission: DataPlaneAdmission | undefined,
): CapturedAdmissionPolicy {
  const merged = intersectAdmissionPolicies(listener, presented);
  if (listenerAdmission && listenerAdmission.kind !== "loopback") return merged;
  return immutableAdmissionPolicy({ ...merged, allowMeteredComboTargets: presented.allowMeteredComboTargets });
}
