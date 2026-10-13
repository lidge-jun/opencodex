import type { RawEntry } from "./parsing";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT61_SOL_MODEL } from "./native-models";

/**
 * The Ultrafast speed choice OpenAI documents for GPT-6 Astra and GPT-6.1 Sol
 * (https://developers.openai.com/api/docs/guides/ultrafast-mode and
 * https://learn.chatgpt.com/docs/agent-configuration/speed, checked 2026-10-13).
 *
 * The upstream bundled catalog lists only `priority` for both models; ChatGPT's live model
 * list adds Ultrafast for eligible plans. Codex stops consulting that live list once
 * `model_catalog_json` points at our generated catalog, so without this row the speed picker
 * never offers Ultrafast. The `ultraFastTier` switch is the operator's statement that their
 * plan is eligible; the description still says the tier requires one.
 */
export const NATIVE_ULTRAFAST_SERVICE_TIER: Readonly<{ id: string; name: string; description: string }> = Object.freeze({
  id: "ultrafast",
  name: "Ultrafast",
  description: "Lower latency, increased usage; requires an eligible plan",
});

export const NATIVE_ULTRAFAST_MODELS: ReadonlySet<string> = new Set([NATIVE_GPT6_ASTRA_MODEL, NATIVE_GPT61_SOL_MODEL]);

function isUltraFastId(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "ultrafast";
}

function isUltraFastDescriptor(value: unknown): boolean {
  return value !== null && typeof value === "object" && "id" in value && isUltraFastId((value as { id: unknown }).id);
}

/** The exact descriptor this module writes; anything else carrying the id is operator-owned. */
function isGeneratedDescriptor(value: unknown): boolean {
  if (!isUltraFastDescriptor(value)) return false;
  const tier = value as Record<string, unknown>;
  return Object.keys(tier).length === 3
    && tier.id === NATIVE_ULTRAFAST_SERVICE_TIER.id
    && tier.name === NATIVE_ULTRAFAST_SERVICE_TIER.name
    && tier.description === NATIVE_ULTRAFAST_SERVICE_TIER.description;
}

/** Bare native rows and trusted account-bound clones of the two Ultrafast models. */
export function nativeUltraFastSlug(entry: RawEntry): string | undefined {
  const slug = trustedAccountBoundNativeCatalogSlug(entry)
    ?? (typeof entry.slug === "string" && !entry.slug.includes("/") ? entry.slug : undefined);
  return slug !== undefined && NATIVE_ULTRAFAST_MODELS.has(slug) ? slug : undefined;
}

/**
 * Add (enabled) or withdraw (disabled) the documented Ultrafast choice on an eligible native row.
 *
 * Enabling appends the descriptor to `service_tiers` and "ultrafast" to the deprecated
 * `additional_speed_tiers` mirror, after the existing Fast tier and only when absent, so a
 * repeated sync is a no-op and an operator-written Ultrafast entry wins. Disabling removes only
 * the exact generated descriptor; the mirror string and an ultrafast default go with it only
 * when no other Ultrafast descriptor remains on the row. The catalog default tier is untouched.
 */
export function applyNativeUltraFastTier(entry: RawEntry, enabled: boolean): void {
  if (nativeUltraFastSlug(entry) === undefined) return;
  const tiers = Array.isArray(entry.service_tiers) ? entry.service_tiers : undefined;
  const speeds = Array.isArray(entry.additional_speed_tiers) ? entry.additional_speed_tiers : undefined;
  if (enabled) {
    if (!tiers?.some(isUltraFastDescriptor)) {
      entry.service_tiers = [...(tiers ?? []), { ...NATIVE_ULTRAFAST_SERVICE_TIER }];
    }
    if (!speeds?.some(isUltraFastId)) {
      entry.additional_speed_tiers = [...(speeds ?? []), NATIVE_ULTRAFAST_SERVICE_TIER.id];
    }
    return;
  }
  if (!tiers?.some(isGeneratedDescriptor)) return;
  const keptTiers = tiers.filter(tier => !isGeneratedDescriptor(tier));
  if (keptTiers.length > 0) entry.service_tiers = keptTiers;
  else delete entry.service_tiers;
  if (keptTiers.some(isUltraFastDescriptor)) return;
  if (speeds) {
    const keptSpeeds = speeds.filter(speed => !isUltraFastId(speed));
    if (keptSpeeds.length > 0) entry.additional_speed_tiers = keptSpeeds;
    else delete entry.additional_speed_tiers;
  }
  for (const field of ["service_tier", "default_service_tier"] as const) {
    if (isUltraFastId(entry[field])) delete entry[field];
  }
}
