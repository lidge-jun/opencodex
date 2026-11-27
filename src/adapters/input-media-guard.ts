import type { ProviderAdapter } from "./base";
import { untranslatedInputMediaMessage, untranslatedResponsesInputMedia } from "../responses/input-media";
import { unrepresentableDeclaration } from "./declaration-carrier";
import { unrepresentableVideo } from "./video-input-carrier";
import type { AdapterWire } from "./registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";

/**
 * Refuse unrepresentable input at the final translated-adapter boundary. The registry
 * applies this after wire resolution; Responses passthrough (including Azure) opts
 * out because it uses the original body rather than the lossy normalized content.
 *
 * Two of the three checks are wire-scoped, and that is the point. A constraint the normalized
 * request CAN carry — a caller restriction on a tool, an attached document's bytes, or inline
 * audio in the translated Chat content model — still has
 * to reach a wire that can express it. Leaving that to each adapter means an adapter that never
 * learned about the carrier rebuilds without it and answers normally, so the allowlist in
 * `declaration-carrier.ts` is default-deny and this is the one place every registered adapter
 * passes through.
 *
 * Video is checked on the normalized request because its carrier is model-specific on the
 * translated Chat wire: `provider` supplies the routed model's declared input modalities.
 */
/**
 * A builder-path video refusal. The dispatcher maps it to the 400 `unsupported_input_modality`
 * that `runTurn` already emits, which also lets a combo hop to a member that can read the clip.
 */
export class UnsupportedInputModalityError extends Error {
  override readonly name = "UnsupportedInputModalityError";
}

export function withInputMediaGuard<T extends ProviderAdapter>(adapter: T, wire: AdapterWire, provider?: OcxProviderConfig): T {
  const refusal = (parsed: OcxParsedRequest): { message: string; video: boolean } | undefined => {
    // Chat Completions has a native input_audio user-content part. The adapter promotes
    // tool-result audio into a follow-up user message, so these blocks no longer lose bytes.
    const kind = untranslatedResponsesInputMedia(parsed._rawBody, { allowAudio: wire === "openai-chat" });
    if (kind) return { message: untranslatedInputMediaMessage(kind), video: kind === "video" };
    const declaration = unrepresentableDeclaration(parsed, wire);
    if (declaration) return { message: declaration, video: false };
    const video = unrepresentableVideo(parsed, wire, provider);
    return video ? { message: video, video: true } : undefined;
  };
  const build = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (parsed, incoming) => {
    const refused = refusal(parsed);
    // Audio, file and declaration refusals keep their established generic builder 400.
    if (refused) throw refused.video ? new UnsupportedInputModalityError(refused.message) : new Error(refused.message);
    return build(parsed, incoming);
  };

  const runTurn = adapter.runTurn?.bind(adapter);
  if (runTurn) {
    adapter.runTurn = async (parsed, incoming, emit) => {
      const refused = refusal(parsed);
      if (refused) {
        emit({
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
          message: refused.message,
        });
        return;
      }
      await runTurn(parsed, incoming, emit);
    };
  }

  const localTerminal = adapter.localTerminal?.bind(adapter);
  if (localTerminal) {
    // This hook is outside the builder's error catch. Decline its success shortcut;
    // the ordinary buildRequest path then returns the established client-safe 400.
    adapter.localTerminal = parsed => refusal(parsed) ? undefined : localTerminal(parsed);
  }
  return adapter;
}
