import type { ProviderAdapter } from "./base";
import { untranslatedInputMediaMessage, untranslatedResponsesInputMedia } from "../responses/input-media";

/**
 * Refuse unrepresentable input at the final translated-adapter boundary. The registry
 * applies this after wire resolution; Responses passthrough (including Azure) opts
 * out because it uses the original body rather than the lossy normalized content.
 */
export function withInputMediaGuard<T extends ProviderAdapter>(adapter: T): T {
  const build = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (parsed, incoming) => {
    const kind = untranslatedResponsesInputMedia(parsed._rawBody);
    if (kind) throw new Error(untranslatedInputMediaMessage(kind));
    return build(parsed, incoming);
  };

  const runTurn = adapter.runTurn?.bind(adapter);
  if (runTurn) {
    adapter.runTurn = async (parsed, incoming, emit) => {
      const kind = untranslatedResponsesInputMedia(parsed._rawBody);
      if (kind) {
        emit({
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
          message: untranslatedInputMediaMessage(kind),
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
    adapter.localTerminal = parsed => untranslatedResponsesInputMedia(parsed._rawBody)
      ? undefined
      : localTerminal(parsed);
  }
  return adapter;
}
