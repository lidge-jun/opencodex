import type { OcxProviderConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { NativeSteeringReplayObserver } from "./native-steering-replay";

import { isInjectionRequest } from "./native-injection-protocol";

/** Shared transport ownership, not a shared steer/inject protocol state machine. */
export interface NativeResponseControl {
  readonly kind?: "steering" | "injection";
  relayActive: boolean;
  normalizeContinuation?: (frame: Record<string, unknown>) => Record<string, unknown>;
  replayFactory?: () => NativeSteeringReplayObserver;
  readonly attached: boolean;
  readonly ended: boolean;
  attach(send: (frame: Record<string, unknown>) => void, fail: (error: Error) => void): () => void;
  observe(frame: Record<string, unknown>): boolean;
  steer(frame: Record<string, unknown>): void;
  inject?(frame: Record<string, unknown>): void;
  continue(frame: Record<string, unknown>): boolean;
}

export const OPENAI_API_RESPONSES_URL = "https://api.openai.com/v1/responses";

const nativeControlResponses = new WeakSet<Response>();
/** Mark the exact response for multi-response delivery without serializing a wire field. */
export function markNativeControlResponse(response: Response): Response { nativeControlResponses.add(response); return response; }
/** Recognize a marked native response by identity, not by caller-controlled content. */
export function isNativeControlResponse(response: Response): boolean { return nativeControlResponses.has(response); }

/** Preserve canonical ChatGPT eligibility; public API controls require an explicit provider WebSocket opt-in. */
export function nativeResponseControlEligible(provider: OcxProviderConfig, control?: NativeResponseControl): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  return (control?.kind === "injection" || control?.kind === "steering") && provider.adapter === "openai-responses"
    && provider.upstreamWebsocket === true && provider.authMode !== "forward"
    && provider.baseUrl?.replace(/\/+$/, "") === "https://api.openai.com/v1";
}

/** Select by execution mode, never model name; a multi-agent request cannot acquire steering. */
export function nativeResponseControlMode(frame: Record<string, unknown>, flags: {
  codexNativeInjection?: boolean; codexNativeSteering?: boolean;
}): "injection" | "steering" | undefined {
  if (isInjectionRequest(frame)) return flags.codexNativeInjection === true ? "injection" : undefined;
  return nativeSteeringUnavailableReason(frame, flags.codexNativeSteering) === undefined ? "steering" : undefined;
}

/** Explain documented execution-mode exclusions without claiming model entitlement. */
export function nativeSteeringUnavailableReason(frame: Record<string, unknown>, enabled?: boolean): string | undefined {
  if (enabled !== true) return "Native steering is disabled; enable codexNativeSteering and WebSockets for a supported route.";
  if (isInjectionRequest(frame)) return "Multi-agent execution does not support single-agent response.steer; use a later client request.";
  if (frame.conversation != null) return "Conversation-bound responses do not support native steering.";
  if (Array.isArray(frame.context_management) && frame.context_management.some(item =>
    item && typeof item === "object" && (item as Record<string, unknown>).type === "compaction")) {
    return "Automatic API compaction and native steering cannot share an active response.";
  }
  return undefined;
}
