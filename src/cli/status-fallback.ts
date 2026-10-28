/**
 * `ocx status --json` `fallback` (OCX-11). The live proxy's `GET /api/fallback` when it answers
 * (on a Remote Link Child that read is the Home's, over the link); otherwise the policy from this
 * machine's config with no events, marked `source: "local"`. Never fails the status report.
 */
import type { OcxConfig } from "../types";
import { buildFallbackState, type FallbackStateView } from "../routing/fallback-state";
import { runtimeRequest, type RuntimeApiDeps } from "./runtime-api";

export type StatusFallback = (FallbackStateView | ReturnType<typeof buildFallbackState>) & { source: "live" | "home" | "local" };

const STATUS_FALLBACK_TIMEOUT_MS = 2_000;

export async function collectStatusFallback(
  config: Pick<OcxConfig, "fallback">,
  options: { live: boolean; linkChild: boolean; deps?: RuntimeApiDeps },
): Promise<StatusFallback> {
  if (options.live) {
    try {
      const state = await runtimeRequest<FallbackStateView>("/api/fallback", {
        signal: AbortSignal.timeout(STATUS_FALLBACK_TIMEOUT_MS),
      }, options.deps ?? {});
      if (state && typeof state === "object" && state.schema === "ocx.fallback/1") {
        return { ...state, source: options.linkChild ? "home" : "live" };
      }
    } catch { /* an older or unreachable proxy: report the local policy instead */ }
  }
  return { ...buildFallbackState(options.linkChild ? {} : config), source: "local" };
}
