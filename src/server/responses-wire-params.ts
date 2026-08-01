import type { OcxProviderConfig } from "../types";

/**
 * Shape a translated Responses body for the wire the route actually uses.
 *
 * Shared by both translate-and-replay inbound handlers (Chat Completions and Anthropic
 * Messages). They previously carried identical copies of this block, which is how the two
 * drift apart.
 *
 * `store` is deliberately not handled here — only the Chat Completions handler has a
 * non-Responses default for it.
 */
export function stripUnsupportedResponsesSamplingParams(
  body: Record<string, unknown>,
  provider: Pick<OcxProviderConfig, "authMode">,
): void {
  // Forward mode is the only route that 400s on max_output_tokens ("Unsupported parameter",
  // verified live 2026-07-11), and the adapter's own stripUnsupportedForwardParams already
  // drops it there on the same condition. A routed Responses gateway (GitHub Copilot,
  // api.openai.com, ...) honors the field, and dropping it there silently ignores the
  // caller's max_tokens. Reachable since a registry `modelWireDefaults` entry can put a
  // chat/anthropic inbound onto the Responses wire.
  if (provider.authMode === "forward") delete body.max_output_tokens;
  // temperature/top_p/stop/user stay stripped on every Responses route: `stop` is not a
  // Responses parameter at all, reasoning models reject temperature/top_p, and the
  // passthrough adapter relays the body verbatim — `noTemperatureModels` and friends are
  // honored only by the openai-chat adapter, so there is no per-model filter here.
  delete body.temperature;
  delete body.top_p;
  delete body.stop;
  delete body.user;
}
