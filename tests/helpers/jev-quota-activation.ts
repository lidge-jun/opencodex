/** Explicit JEV advisory-quota activation for tests: publication is opt-in, so evidence tests activate it like a live config would. */
import { deactivateJevQuotaActivation, reconcileJevQuotaActivation } from "../../src/combos/jev-quota-activation";
import type { OcxConfig } from "../../src/types";

/** Minimal live-config shape with one JEV combo that enables quota signals. */
export const JEV_QUOTA_SIGNALS_CONFIG = {
  combos: { "jev-quota-signals": { strategy: "jev", targets: [], decisionQuotaSignals: true } },
} as unknown as OcxConfig;

/** Register the snapshot-backed sink and replay the current (sandboxed) stores, exactly as live activation does. */
export function activateJevQuotaEvidence(config: OcxConfig = JEV_QUOTA_SIGNALS_CONFIG): void {
  reconcileJevQuotaActivation(config);
}

/** Detach the sink and withdraw all advisory evidence. */
export function deactivateJevQuotaEvidence(): void {
  deactivateJevQuotaActivation();
}
