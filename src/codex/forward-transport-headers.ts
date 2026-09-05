/** Native request metadata shared by the HTTP adapter and WS preparation. */
export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const CODEX_RESPONSES_LITE_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";

const MAX_ROUTING_MODEL_BYTES = 256;
const MAX_ROUTING_TIER_BYTES = 64;

function isRoutingHintComponent(value: unknown, maxBytes: number): value is string {
  // Printable non-whitespace ASCII makes code-unit length equal to byte length.
  return typeof value === "string" && value.length > 0 && value.length <= maxBytes
    && /^[\x21-\x7e]+$/.test(value) && !/[;=]/.test(value);
}

/** The final wire body is authoritative; an invalid component never revives a stale hint. */
export function applyCodexRoutingHint(headers: Headers, body: unknown): void {
  headers.delete(CODEX_ROUTING_HINT_HEADER);
  if (typeof body !== "object" || body === null || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;
  if (!isRoutingHintComponent(record.model, MAX_ROUTING_MODEL_BYTES)) return;
  const tier = record.service_tier;
  if (tier !== undefined && !isRoutingHintComponent(tier, MAX_ROUTING_TIER_BYTES)) return;
  headers.set(CODEX_ROUTING_HINT_HEADER,
    `model=${record.model}${tier === undefined ? "" : `;tier=${tier}`}`);
}
