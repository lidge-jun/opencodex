import { inspectResponseLogSsePayload, usageFromResponsesPayload, type RequestLogContext } from "../request-log";
import type { OcxUsage } from "../../types";
import { MAX_NATIVE_STEERING_RESPONSES } from "./native-steering";

/** Count every terminal once. Control frames may echo user input: never sample them. */
export function createNativeSteeringLogObserver(logCtx: RequestLogContext, onFirstOutput?: () => void): (payload: string) => void {
  let outputSeen = false;
  const usages = new Map<string, OcxUsage>();
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
      inspectResponseLogSsePayload(logCtx, payload);
    }
    const terminal = ["response.completed", "response.failed", "response.incomplete"].includes(event.type ?? "");
    if (terminal && typeof event.response?.id === "string") {
      const usage = usageFromResponsesPayload(event.response.usage);
      if (usage && (usages.has(event.response.id) || usages.size < MAX_NATIVE_STEERING_RESPONSES)) {
        // Retain numeric counters only, never arbitrary rawUsage metadata.
        const counters: OcxUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
        for (const key of ["totalTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] as const) {
          if (typeof usage[key] === "number") counters[key] = usage[key];
        }
        usages.set(event.response.id, counters);
      }
    }
    if (!usages.size) return;
    const total: OcxUsage = { inputTokens: 0, outputTokens: 0 };
    for (const usage of usages.values()) {
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] as const) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
      }
    }
    logCtx.usage = total;
    if (logCtx.activeAttempt) logCtx.activeAttempt.usage = total;
  };
}
