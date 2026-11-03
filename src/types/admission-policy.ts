import type { AdmissionModelScope } from "../server/admission-model-scope";
import type { OcxFallbackConfig } from "./fallback";

/** Credential-free, immutable decision inputs captured for an internal child. */
export interface CapturedAdmissionPolicy {
  readonly modelScope: AdmissionModelScope;
  readonly allowMeteredComboTargets: boolean;
  readonly meteredRequiresComboOptIn: boolean;
  readonly fallbackPolicies: readonly {
    readonly config: { readonly fallback?: OcxFallbackConfig };
    readonly deviceIds: readonly string[];
  }[];
}
