import { CodexInstallationIdUnavailableError, codexInstallationIdForAccount } from "./installation-id";

/** Native request metadata shared by the HTTP adapter and WS preparation. */
export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const CODEX_RESPONSES_LITE_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
export const CODEX_INSTALLATION_ID_HEADER = "x-codex-installation-id";
export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export const CODEX_ATTESTATION_HEADER = "x-oai-attestation";

// Caller credentials are forwarded only to the canonical Codex destination, never by capability.
export const FORWARD_HEADERS = [
  "authorization", "chatgpt-account-id", "openai-beta", "originator", "session_id", "session-id",
  "thread-id", "x-client-request-id", "x-codex-beta-features", "x-codex-installation-id",
  "x-codex-parent-thread-id", "x-codex-turn-metadata", "x-codex-turn-state", "x-codex-window-id",
  "x-oai-attestation", "x-openai-subagent", "x-responsesapi-include-timing-metrics", "version", CODEX_RESPONSES_LITE_HEADER,
];

const MAX_ROUTING_MODEL_BYTES = 256;
const MAX_ROUTING_TIER_BYTES = 64;
const MAX_TURN_METADATA_BYTES = 32 * 1024;
// Each escaped code unit (U+007F+) becomes 6 ASCII bytes: at most 3x the UTF-8 size of
// non-ASCII text (DEL alone grows 6x), so 96 KiB holds any DEL-free canonical value.
const MAX_ESCAPED_TURN_METADATA_BYTES = 3 * MAX_TURN_METADATA_BYTES;

/** Compatibility export: caller values never contribute to the selected account identity. */
export function deriveCodexAccountInstallationId(chatgptAccountId: string, _callerInstallationId: string): string {
  return codexInstallationIdForAccount(chatgptAccountId);
}

/**
 * Rewrites the `installation_id` inside Codex turn metadata while preserving all other fields.
 *
 * Structure contract: JSON with a nonblank string installation_id is returned as printable ASCII — every code unit outside
 * U+0020–U+007E is escaped (JSON.stringify already escapes U+0000–U+001F, with short forms
 * such as `\\n`; U+007F and above become `\\uXXXX` here). Both consumers of rewritten turn metadata (the
 * `x-codex-turn-metadata` HTTP header and the embedded `client_metadata` value)
 * receive this ASCII-safe form, so header setters never see literal Unicode.
 *
 * The 32 KiB bound applies to the canonical (unescaped UTF-8) rewritten JSON, and the escaped
 * result is capped at 96 KiB. Feeding an accepted result back in is therefore a no-op: it
 * parses to the same canonical JSON, so repeated isolation passes cannot refuse it.
 * Invalid JSON, non-objects, and objects without a nonblank string installation_id pass
 * through unchanged up to 32 KiB; their original bytes are not guaranteed header-safe.
 */
export function rewriteTurnMetadataInstallationId(rawMetadata: string, chatgptAccountId: string): string {
  if (!chatgptAccountId.trim()) throw new CodexInstallationIdUnavailableError();
  // A size bound must refuse the Pool send, never bypass identity projection.
  const rawBytes = Buffer.byteLength(rawMetadata, "utf8");
  if (rawBytes > MAX_ESCAPED_TURN_METADATA_BYTES) throw new CodexInstallationIdUnavailableError();
  // Values returned unchanged keep the raw bound; only rewritten JSON is measured canonically.
  const passThrough = () => {
    if (rawBytes > MAX_TURN_METADATA_BYTES) throw new CodexInstallationIdUnavailableError();
    return rawMetadata;
  };
  let parsed: unknown;
  try { parsed = JSON.parse(rawMetadata); } catch { return passThrough(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return passThrough();
  const record = parsed as Record<string, unknown>;
  if (typeof record.installation_id !== "string" || !record.installation_id.trim()) return passThrough();
  const nextId = deriveCodexAccountInstallationId(chatgptAccountId, record.installation_id);
  const canonical = JSON.stringify({ ...record, installation_id: nextId });
  if (Buffer.byteLength(canonical, "utf8") > MAX_TURN_METADATA_BYTES) throw new CodexInstallationIdUnavailableError();
  // Turn metadata is also sent as an HTTP header; DEL and non-ASCII are invalid field-value bytes.
  const escaped = canonical
    .replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  if (escaped.length > MAX_ESCAPED_TURN_METADATA_BYTES) throw new CodexInstallationIdUnavailableError();
  return escaped;
}

export function isolateCodexPoolAccountHeaders(headers: Headers, chatgptAccountId: string): void {
  if (!chatgptAccountId.trim()) throw new CodexInstallationIdUnavailableError();
  headers.delete(CODEX_ATTESTATION_HEADER);
  const installId = headers.get(CODEX_INSTALLATION_ID_HEADER);
  if (installId !== null) {
    headers.set(CODEX_INSTALLATION_ID_HEADER, deriveCodexAccountInstallationId(chatgptAccountId, installId));
  }
  const turnMeta = headers.get(CODEX_TURN_METADATA_HEADER);
  if (turnMeta) {
    headers.set(CODEX_TURN_METADATA_HEADER, rewriteTurnMetadataInstallationId(turnMeta, chatgptAccountId));
  }
}

export function isolateCodexPoolClientMetadata(body: unknown, chatgptAccountId: string | undefined): unknown {
  if (chatgptAccountId === undefined) return body;
  if (!chatgptAccountId.trim()) throw new CodexInstallationIdUnavailableError();
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const cm = record.client_metadata;
  if (!cm || typeof cm !== "object" || Array.isArray(cm)) return body;
  const meta = cm as Record<string, unknown>;
  let nextMeta: Record<string, unknown> | undefined;
  const rawInstallId = meta[CODEX_INSTALLATION_ID_HEADER];
  if (Object.hasOwn(meta, CODEX_INSTALLATION_ID_HEADER)) {
    const nextId = codexInstallationIdForAccount(chatgptAccountId);
    if (nextId !== rawInstallId) nextMeta = { ...meta, [CODEX_INSTALLATION_ID_HEADER]: nextId };
  }
  const rawTurnMeta = (nextMeta ?? meta)[CODEX_TURN_METADATA_HEADER];
  if (typeof rawTurnMeta === "string" && rawTurnMeta.trim()) {
    const rewritten = rewriteTurnMetadataInstallationId(rawTurnMeta, chatgptAccountId);
    if (rewritten !== rawTurnMeta) nextMeta = { ...(nextMeta ?? meta), [CODEX_TURN_METADATA_HEADER]: rewritten };
  }
  return nextMeta ? { ...record, client_metadata: nextMeta } : body;
}

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

/** Selected identity is authoritative after provider-header merges, including deletions. */
export function mergeCodexSelectedHeaders(configured: HeadersInit | undefined, selected: Headers): Headers {
  const headers = new Headers(configured);
  for (const name of [CODEX_INSTALLATION_ID_HEADER, CODEX_TURN_METADATA_HEADER, CODEX_ATTESTATION_HEADER]) headers.delete(name);
  for (const name of FORWARD_HEADERS) {
    const value = selected.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}
