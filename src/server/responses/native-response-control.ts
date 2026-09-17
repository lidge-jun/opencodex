import type { OcxProviderConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import type { NativeSteeringReplayObserver } from "./native-steering-replay";

/** Shared transport ownership, not a shared steer/inject protocol state machine. */
export interface NativeResponseControl {
  readonly kind?: "steering" | "injection";
  relayActive: boolean;
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

/** Preserve canonical ChatGPT eligibility; public API injection is separately opted in. */
export function nativeResponseControlEligible(provider: OcxProviderConfig, control?: NativeResponseControl): boolean {
  if (isCanonicalOpenAiForwardProvider(provider)) return true;
  return control?.kind === "injection" && provider.adapter === "openai-responses"
    && provider.upstreamWebsocket === true && provider.authMode !== "forward"
    && provider.baseUrl?.replace(/\/+$/, "") === "https://api.openai.com/v1";
}
