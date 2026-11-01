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

/** Compatibility export: caller values never contribute to the selected account identity. */
export function deriveCodexAccountInstallationId(chatgptAccountId: string, _callerInstallationId: string): string {
  return codexInstallationIdForAccount(chatgptAccountId);
}

export function rewriteTurnMetadataInstallationId(rawMetadata: string, chatgptAccountId: string): string {
  if (!chatgptAccountId.trim()) return rawMetadata;
  // A size bound must refuse the Pool send, never bypass identity projection.
  if (Buffer.byteLength(rawMetadata, "utf8") > MAX_TURN_METADATA_BYTES) throw new CodexInstallationIdUnavailableError();
  let parsed: unknown;
  try { parsed = JSON.parse(rawMetadata); } catch { return rawMetadata; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return rawMetadata;
  const record = parsed as Record<string, unknown>;
  if (typeof record.installation_id !== "string" || !record.installation_id.trim()) return rawMetadata;
  const nextId = deriveCodexAccountInstallationId(chatgptAccountId, record.installation_id);
  if (nextId === record.installation_id) return rawMetadata;
  return JSON.stringify({ ...record, installation_id: nextId });
}

export function isolateCodexPoolAccountHeaders(headers: Headers, chatgptAccountId: string): void {
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
  if (chatgptAccountId === undefined || !body || typeof body !== "object" || Array.isArray(body)) return body;
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
