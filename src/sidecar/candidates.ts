/**
 * The unified picker-visibility candidate set both sidecars consume (#2188).
 *
 * Rule 1 (picker): a model may be OFFERED as a sidecar backend only if the
 * management picker would show it — the same `listManagementModelRows` rows
 * the GUI Models tab renders, minus disabled rows. Rule 1's only exception is
 * the auth slots: a logged-in side keeps its fixed slot model (Luna/Haiku)
 * even when the picker hides it, because the slot is the login's entitlement.
 *
 * Vision additionally applies rule 2 (− provably text-only); web-search
 * applies its own rule 2 (∩ probed backend with an executor) in
 * src/web-search/backends.ts. Both start from THIS set so the two sidecars
 * cannot diverge on what "visible" means.
 */
import type { OcxConfig } from "../types";
import { listManagementModelRows } from "../server/management/model-rows";
import { modelAcceptsImageInput, type VisionCandidateModel } from "../vision/eligibility";
import { sidecarAuthSlots, type SidecarAuthState } from "./auth";

export interface SidecarCandidate {
  provider: string;
  id: string;
  native?: boolean;
  inputModalities?: string[];
  /** True when this row is an auth-slot entitlement rather than a picker row. */
  authSlot?: boolean;
}

/**
 * (picker-visible rows) ∪ (auth slots). De-duplicated by provider+id with the
 * auth-slot flag winning, so a slot model that is ALSO picker-visible still
 * reads as slot-backed. A catalog outage degrades to slots only — the settings
 * routes must not 500 and must keep the logged-in floor populated.
 */
export async function pickerVisibleSidecarCandidates(
  config: OcxConfig,
  auth: SidecarAuthState,
): Promise<SidecarCandidate[]> {
  let rows: Awaited<ReturnType<typeof listManagementModelRows>> = [];
  try { rows = await listManagementModelRows(config, { entitlementWaitMs: 0 }); } catch { rows = []; }
  const byKey = new Map<string, SidecarCandidate>();
  for (const row of rows) {
    if (row.disabled === true) continue;
    byKey.set(`${row.provider}/${row.id}`, {
      provider: row.provider,
      id: row.id,
      ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
      ...(row.native ? { native: true } : {}),
    });
  }
  for (const slot of sidecarAuthSlots(auth)) {
    byKey.set(`${slot.provider}/${slot.id}`, {
      provider: slot.provider,
      id: slot.id,
      // Slot models are known image-capable; their only exclusion path is the
      // provider's explicit consumer list (same stance as baselineCandidate).
      inputModalities: ["text", "image"],
      authSlot: true,
    });
  }
  return [...byKey.values()];
}

/**
 * Rule 2 for vision: drop rows PROVABLY text-only. Unknown stays eligible —
 * the picker filter (rule 1) already bounded the set, so permissive-unknown
 * no longer expands to the whole catalog.
 */
export function visionSidecarCandidates(
  config: Pick<OcxConfig, "providers">,
  all: readonly SidecarCandidate[],
): SidecarCandidate[] {
  return all.filter(candidate => modelAcceptsImageInput(config, toVisionCandidate(candidate)) !== false);
}

function toVisionCandidate(candidate: SidecarCandidate): VisionCandidateModel {
  return {
    provider: candidate.provider,
    id: candidate.id,
    ...(candidate.inputModalities ? { inputModalities: candidate.inputModalities } : {}),
    ...(candidate.native ? { native: true } : {}),
  };
}
