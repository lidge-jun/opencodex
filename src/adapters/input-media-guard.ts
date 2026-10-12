import type { ProviderAdapter } from "./base";
import { untranslatedInputMediaMessage, untranslatedResponsesInputMedia } from "../responses/input-media";
import { unrepresentableDeclaration } from "./declaration-carrier";
import type { AdapterWire } from "./registry";
import type { OcxParsedRequest } from "../types";

/**
 * Refuse unrepresentable input at the final translated-adapter boundary. The registry
 * applies this after wire resolution; Responses passthrough (including Azure) opts
 * out because it uses the original body rather than the lossy normalized content.
 *
 * Two of the three checks are wire-scoped, and that is the point. A constraint the normalized
 * request CAN carry — a caller restriction on a tool, an attached document's bytes — still has
 * to reach a wire that can express it. Leaving that to each adapter means an adapter that never
 * learned about the carrier rebuilds without it and answers normally, so the allowlist in
 * `declaration-carrier.ts` is default-deny and this is the one place every registered adapter
 * passes through.
 */
export function withInputMediaGuard<T extends ProviderAdapter>(adapter: T, wire: AdapterWire): T {
  const refusal = (parsed: OcxParsedRequest): string | undefined => {
    const kind = untranslatedResponsesInputMedia(parsed._rawBody);
    return kind ? untranslatedInputMediaMessage(kind) : unrepresentableDeclaration(parsed, wire);
  };
  const build = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (parsed, incoming) => {
    const message = refusal(parsed);
    if (message) throw new Error(message);
    return build(parsed, incoming);
  };

  const runTurn = adapter.runTurn?.bind(adapter);
  if (runTurn) {
    adapter.runTurn = async (parsed, incoming, emit) => {
      const message = refusal(parsed);
      if (message) {
        emit({
          type: "error",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
          message,
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
