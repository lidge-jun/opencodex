import { createHmac } from "node:crypto";

/** Native request metadata shared by the HTTP adapter and WS preparation. */
export const CODEX_RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const CODEX_RESPONSES_LITE_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
export const CODEX_ROUTING_HINT_HEADER = "x-codex-routing-hint";
export const CODEX_INSTALLATION_ID_HEADER = "x-codex-installation-id";
export const CODEX_TURN_METADATA_HEADER = "x-codex-turn-metadata";
export const CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export const CODEX_ATTESTATION_HEADER = "x-oai-attestation";

const MAX_ROUTING_MODEL_BYTES = 256;
const MAX_ROUTING_TIER_BYTES = 64;
const INSTALL_BODY_KEY = "opencodex-codex-pool-install-body-v1";
const INSTALL_TAG_KEY = "opencodex-codex-pool-install-tag-v1";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TURN_METADATA_BYTES = 32 * 1024;

function accountTagForUuidPrefix(account: string, prefix20Hex: string): string {
  return createHmac("sha256", INSTALL_TAG_KEY).update(`${account}\0${prefix20Hex.toLowerCase()}`).digest("hex").slice(0, 12);
}

/**
 * Deterministic, idempotent RFC 4122 v4 UUID isolated per (chatgptAccountId, callerInstallationId).
 * Calling it twice with the same chatgptAccountId returns the identical UUID without double-hashing.
 */
export function deriveCodexAccountInstallationId(chatgptAccountId: string, callerInstallationId: string): string {
  const account = chatgptAccountId.trim();
  const raw = callerInstallationId.trim();
  if (!account || !raw) return callerInstallationId;
  if (UUID_V4_RE.test(raw)) {
    const hex = raw.replace(/-/g, "").toLowerCase();
    if (hex.slice(20, 32) === accountTagForUuidPrefix(account, hex.slice(0, 20))) {
      return raw.toLowerCase();
    }
  }
  const h = createHmac("sha256", INSTALL_BODY_KEY).update(`${account}\0${raw}`).digest("hex");
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const prefix20 = `${h.slice(0, 8)}${h.slice(8, 12)}4${h.slice(13, 16)}${variant}${h.slice(17, 20)}`;
  const node12 = accountTagForUuidPrefix(account, prefix20);
  return `${prefix20.slice(0, 8)}-${prefix20.slice(8, 12)}-${prefix20.slice(12, 16)}-${prefix20.slice(16, 20)}-${node12}`;
}

export function rewriteTurnMetadataInstallationId(rawMetadata: string, chatgptAccountId: string): string {
  if (!chatgptAccountId.trim() || Buffer.byteLength(rawMetadata, "utf8") > MAX_TURN_METADATA_BYTES) return rawMetadata;
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
  if (!chatgptAccountId.trim()) return;
  const installId = headers.get(CODEX_INSTALLATION_ID_HEADER);
  if (installId && installId.trim()) {
    headers.set(CODEX_INSTALLATION_ID_HEADER, deriveCodexAccountInstallationId(chatgptAccountId, installId));
  }
  const turnMeta = headers.get(CODEX_TURN_METADATA_HEADER);
  if (turnMeta) {
    headers.set(CODEX_TURN_METADATA_HEADER, rewriteTurnMetadataInstallationId(turnMeta, chatgptAccountId));
  }
}

export function isolateCodexPoolClientMetadata(body: unknown, chatgptAccountId: string | undefined): unknown {
  if (!chatgptAccountId?.trim() || !body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const cm = record.client_metadata;
  if (!cm || typeof cm !== "object" || Array.isArray(cm)) return body;
  const meta = cm as Record<string, unknown>;
  let nextMeta: Record<string, unknown> | undefined;
  const rawInstallId = meta[CODEX_INSTALLATION_ID_HEADER];
  if (typeof rawInstallId === "string" && rawInstallId.trim()) {
    const nextId = deriveCodexAccountInstallationId(chatgptAccountId, rawInstallId);
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
