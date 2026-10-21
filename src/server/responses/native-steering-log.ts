import { inspectResponseLogSsePayloadParsed, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import type { OcxUsage } from "../../types";
import { aggregateCacheTelemetry } from "../../usage/cache-telemetry";
import { MAX_NATIVE_STEERING_RESPONSES } from "./native-steering";

/** Count every terminal once. Control frames may echo user input: never sample them. */
export function createNativeSteeringLogObserver(logCtx: RequestLogContext, onFirstOutput?: () => void): (payload: string) => void {
  let outputSeen = false;
  const usages = new Map<string, OcxUsage | undefined>();
  return payload => {
    let event: { type?: string; delta?: unknown; response?: { id?: string; usage?: unknown; incomplete_details?: { reason?: string } } };
    try { event = JSON.parse(payload); } catch { return; }
    if (event.type?.startsWith("response.steer.") || event.type?.startsWith("response.inject.")) return;
    if (!outputSeen && event.type?.endsWith(".delta") && typeof event.delta === "string" && event.delta.length) {
      outputSeen = true; onFirstOutput?.();
    }
    // A steered parent is not a failed logical turn. Keep its usage, but never
    // label an eventual successful successor as an upstream failure.
    if (!(event.type === "response.incomplete" && event.response?.incomplete_details?.reason === "steered")) {
      // Native-control delivery bypasses the client rewrite/bridge chain; usage is raw.
      inspectResponseLogSsePayloadParsed(logCtx, payload, event, "upstream");
    }
    const terminal = ["response.completed", "response.failed", "response.incomplete"].includes(event.type ?? "");
    if (terminal && typeof event.response?.id === "string") {
      const usage = usageFromResponsesPayload(event.response.usage, "upstream");
      if (usages.has(event.response.id) || usages.size < MAX_NATIVE_STEERING_RESPONSES) {
        // Retain counters and closed evidence only, never arbitrary rawUsage metadata.
        const counters: OcxUsage | undefined = usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheTelemetry: usage.cacheTelemetry } : undefined;
        for (const key of ["totalTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheCreation1hInputTokens", "reasoningOutputTokens"] as const) {
          if (counters && typeof usage?.[key] === "number") counters[key] = usage[key];
        }
        usages.set(event.response.id, counters);
      }
    }
    if (!usages.size) return;
    const measured = [...usages.values()].filter((usage): usage is OcxUsage => usage !== undefined);
    if (!measured.length) {
      delete logCtx.usage;
      if (logCtx.activeAttempt) delete logCtx.activeAttempt.usage;
      return;
    }
    const total: OcxUsage = { inputTokens: 0, outputTokens: 0 };
    for (const usage of measured) {
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "cacheCreation1hInputTokens", "reasoningOutputTokens"] as const) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
      }
    }
    total.cacheTelemetry = usages.size === 1 ? measured[0]!.cacheTelemetry : aggregateCacheTelemetry([...usages.values()]);
    logCtx.usage = total;
    if (logCtx.activeAttempt) logCtx.activeAttempt.usage = total;
  };
}
