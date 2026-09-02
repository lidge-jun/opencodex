import { MAX_REMOTE_CATALOG_BYTES } from "../server/catalog-download";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { clearableDeadline } from "../lib/abort";

/**
 * A pairing grant may cross loopback or authenticated HTTPS, and nothing else.
 *
 * Mirrors the hub-side rule in src/server/gui-session.ts. Checking here too is not
 * redundant: it keeps the client from spending a single-use code on a request the hub is
 * certain to refuse.
 */
function isPairingTransportPermitted(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
import {
  checkRemoteProtocolCompatibility,
  parseRemoteReadyMetadata,
  type RemoteReadyMetadata,
} from "../remote/protocol";

const READY_BODY_LIMIT = 64 * 1024;
const MANAGEMENT_BODY_LIMIT = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export type OneTimeConnectCredential =
  | { kind: "admin"; value: Uint8Array }
  | { kind: "pairing-grant"; value: Uint8Array };

export interface ConnectGuiSession {
  token: string;
  csrfToken: string;
  browserOrigin: string;
  serverOrigin: string;
}

export interface IssuedClientKey {
  id: string;
  key: string;
  createdAt: string;
  name: string;
}

export interface StartedClientKeyRotation extends IssuedClientKey {
  rotationId: string;
  expiresAt: string;
}

export class HubClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HubClientError";
  }
}

function credentialString(value: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value).trim();
  if (!decoded || /[\r\n\0]/.test(decoded) || value.byteLength > 4096) {
    throw new HubClientError("credential_invalid", "Connect credential is invalid");
  }
  return decoded;
}

function safeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), 120_000)
    : DEFAULT_TIMEOUT_MS;
}

async function fetchBounded(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  timeoutScope: "request" | "headers" = "request",
): Promise<Response> {
  const timeout = safeTimeout(timeoutMs);
  const headerDeadline = timeoutScope === "headers" ? clearableDeadline(timeout) : null;
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: headerDeadline?.signal ?? AbortSignal.timeout(timeout),
    });
    headerDeadline?.clear();
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new HubClientError("redirect_refused", "Hub request redirect was refused", response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof HubClientError) throw error;
    throw new HubClientError("unreachable", "Hub request did not complete", undefined, { cause: error });
  } finally {
    headerDeadline?.clear();
  }
}

async function boundedText(
  response: Response,
  maxBytes: number,
  options: { inactivityTimeoutMs?: number } = {},
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HubClientError("body_too_large", "Hub response exceeded the allowed size", response.status);
  }
  const result = await readBoundedResponseBytes(response, {
    maxBytes,
    ...(options.inactivityTimeoutMs === undefined ? {} : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
  });
  if (result.oversized) {
    throw new HubClientError("body_too_large", "Hub response exceeded the allowed size", response.status);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
  } catch (error) {
    throw new HubClientError("body_invalid", "Hub response was not valid UTF-8", response.status, { cause: error });
  }
}

function jsonCompatibleContentType(response: Response): boolean {
  const value = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value === "application/json" || value?.endsWith("+json") === true;
}

function validateRemoteCatalog(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HubClientError("catalog_schema_invalid", "Hub catalog response was invalid");
  }
  const models = (value as Record<string, unknown>).models;
  if (!Array.isArray(models) || models.length > 2_000) {
    throw new HubClientError("catalog_schema_invalid", "Hub catalog model list was invalid");
  }
  const slugs = new Set<string>();
  for (const row of models) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new HubClientError("catalog_schema_invalid", "Hub catalog model row was invalid");
    }
    const slug = (row as Record<string, unknown>).slug;
    if (typeof slug !== "string" || !slug.trim() || /[\x00-\x1f\x7f]/.test(slug) || slugs.has(slug)) {
      throw new HubClientError("catalog_schema_invalid", "Hub catalog model slug was invalid");
    }
    slugs.add(slug);
  }
}

function parseJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new HubClientError(code, "Hub returned malformed JSON", undefined, { cause: error });
  }
}

export function normalizeHubOrigin(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new HubClientError("url_invalid", "Hub URL must be an absolute HTTP(S) URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname !== "/" && parsed.pathname !== "/v1" && parsed.pathname !== "/v1/")
  ) {
    throw new HubClientError(
      "url_invalid",
      "Hub URL must be an HTTP(S) origin without credentials, query, fragment, or non-/v1 path",
    );
  }
  return parsed.origin;
}

export async function fetchHubReady(
  serverUrl: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ status: "ready" | "pending" | "failed"; metadata: RemoteReadyMetadata }> {
  const origin = normalizeHubOrigin(serverUrl);
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/readyz`, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, options.timeoutMs);
  const body = parseJson(await boundedText(response, READY_BODY_LIMIT), "ready_invalid");
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HubClientError("ready_invalid", "Hub readiness response was invalid", response.status);
  }
  const raw = body as Record<string, unknown>;
  const status = raw.status;
  if (status !== "ready" && status !== "pending" && status !== "failed") {
    throw new HubClientError("ready_invalid", "Hub readiness status was invalid", response.status);
  }
  const metadata = parseRemoteReadyMetadata(raw);
  const compatibility = checkRemoteProtocolCompatibility(raw);
  if (!metadata || !compatibility.ok) {
    throw new HubClientError(
      compatibility.ok ? "ready_invalid" : compatibility.reason,
      compatibility.ok ? "Hub readiness metadata was invalid" : compatibility.message,
      response.status,
    );
  }
  if ((status === "ready" && response.status !== 200) || (status !== "ready" && response.status !== 503)) {
    throw new HubClientError("ready_invalid", "Hub readiness HTTP status did not match its state", response.status);
  }
  return { status, metadata };
}

function htmlMeta(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<meta\\s+name=["']${escaped}["']\\s+content=["']([^"']*)["']`, "i").exec(html);
  return match?.[1]
    ?.replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&") ?? null;
}

export async function exchangeConnectPairingGrant(
  managementUrl: string,
  browserOrigin: string,
  grant: Uint8Array,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ConnectGuiSession> {
  const origin = normalizeHubOrigin(managementUrl);
  const browser = normalizeHubOrigin(browserOrigin);
  // No opt-in. An earlier revision let `--allow-insecure-http` carry a grant over plaintext
  // when the hub also opted in, on the theory that requiring both sides made it deliberate.
  // Deliberateness is not the control that matters: the grant is readable by anything on the
  // path and the session it mints is reusable. The hub refuses this exchange outright now, so
  // sending it would only burn a single-use code against a certain rejection.
  if (!isPairingTransportPermitted(origin)) {
    throw new HubClientError("insecure_http_refused", "Pairing requires loopback or HTTPS; plaintext HTTP cannot carry a grant");
  }
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/opencodex-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: browser, Accept: "text/html" },
    body: JSON.stringify({ grant: credentialString(grant) }),
  }, options.timeoutMs);
  if (!response.ok) throw new HubClientError("pairing_refused", "Hub pairing grant was refused", response.status);
  const html = await boundedText(response, MANAGEMENT_BODY_LIMIT);
  const session: ConnectGuiSession = {
    token: htmlMeta(html, "opencodex-session-token") ?? "",
    csrfToken: htmlMeta(html, "opencodex-session-csrf") ?? "",
    browserOrigin: htmlMeta(html, "opencodex-session-origin") ?? "",
    serverOrigin: htmlMeta(html, "opencodex-session-server-origin") ?? "",
  };
  if (!session.token || !session.csrfToken || session.browserOrigin !== browser || session.serverOrigin !== origin) {
    throw new HubClientError("pairing_invalid", "Hub pairing session response was invalid", response.status);
  }
  return session;
}

function parseIssuedClientKey(value: unknown): IssuedClientKey | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" || !raw.id || raw.id.length > 256
    || typeof raw.name !== "string" || !raw.name || raw.name.length > 80
    || typeof raw.key !== "string" || !/^ocx_data_[0-9a-f]{40}$/.test(raw.key)
    || typeof raw.createdAt !== "string" || Number.isNaN(Date.parse(raw.createdAt))
  ) return null;
  return { id: raw.id, name: raw.name, key: raw.key, createdAt: raw.createdAt };
}

export async function issueClientKey(
  managementUrl: string,
  credential:
    | { kind: "admin"; value: Uint8Array }
    | { kind: "gui-session"; value: ConnectGuiSession },
  name: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<IssuedClientKey> {
  const origin = normalizeHubOrigin(managementUrl);
  if (!name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new HubClientError("key_name_invalid", "Client key name is invalid");
  }
  if (credential.kind === "admin" && new URL(origin).protocol !== "https:") {
    throw new HubClientError("admin_http_refused", "Admin credentials may be sent only over HTTPS");
  }
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  if (credential.kind === "admin") {
    headers.set("x-opencodex-api-key", credentialString(credential.value));
  } else {
    headers.set("x-opencodex-api-key", credential.value.token);
    headers.set("Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-GUI-Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-CSRF-Token", credential.value.csrfToken);
  }
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/api/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: name.trim() }),
  }, options.timeoutMs);
  if (!response.ok) {
    throw new HubClientError(`key_issue_http_${response.status}`, `Hub refused client key issuance (${response.status})`, response.status);
  }
  const issued = parseIssuedClientKey(parseJson(
    await boundedText(response, MANAGEMENT_BODY_LIMIT),
    "key_issue_invalid",
  ));
  if (!issued) throw new HubClientError("key_issue_invalid", "Hub returned an invalid client key response", response.status);
  return issued;
}

export async function revokeClientKey(
  managementUrl: string,
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  id: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const origin = normalizeHubOrigin(managementUrl);
  if (!id || id.length > 256) throw new HubClientError("key_id_invalid", "Client key id is invalid");
  if (credential.kind === "admin" && new URL(origin).protocol !== "https:") {
    throw new HubClientError("admin_http_refused", "Admin credentials may be sent only over HTTPS");
  }
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  if (credential.kind === "admin") headers.set("x-opencodex-api-key", credentialString(credential.value));
  else {
    headers.set("x-opencodex-api-key", credential.value.token);
    headers.set("Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-GUI-Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-CSRF-Token", credential.value.csrfToken);
  }
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/api/keys`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ id }),
  }, options.timeoutMs);
  if (!response.ok) throw new HubClientError("key_revoke_failed", `Hub refused key revocation (${response.status})`, response.status);
}

function rotationManagementHeaders(
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
): Headers {
  const headers = new Headers({ "Content-Type": "application/json", Accept: "application/json" });
  if (credential.kind === "admin") headers.set("x-opencodex-api-key", credentialString(credential.value));
  else {
    headers.set("x-opencodex-api-key", credential.value.token);
    headers.set("Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-GUI-Origin", credential.value.browserOrigin);
    headers.set("X-OpenCodex-CSRF-Token", credential.value.csrfToken);
  }
  return headers;
}

function assertRotationAuthorityOrigin(origin: string, credential: { kind: "admin" } | { kind: "gui-session" }): void {
  if (credential.kind === "admin" && new URL(origin).protocol !== "https:") {
    throw new HubClientError("admin_http_refused", "Admin credentials may be sent only over HTTPS");
  }
}

export async function startClientKeyRotation(
  managementUrl: string,
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  id: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<StartedClientKeyRotation> {
  const origin = normalizeHubOrigin(managementUrl);
  assertRotationAuthorityOrigin(origin, credential);
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/api/keys/rotate`, {
    method: "POST",
    headers: rotationManagementHeaders(credential),
    body: JSON.stringify({ id }),
  }, options.timeoutMs);
  if (!response.ok) throw new HubClientError("key_rotation_start_failed", `Hub refused key rotation (${response.status})`, response.status);
  const value = parseJson(await boundedText(response, MANAGEMENT_BODY_LIMIT), "key_rotation_invalid");
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const issued = parseIssuedClientKey(value);
  if (!raw || !issued || typeof raw.rotationId !== "string" || !raw.rotationId
    || typeof raw.expiresAt !== "string" || Number.isNaN(Date.parse(raw.expiresAt))) {
    throw new HubClientError("key_rotation_invalid", "Hub returned an invalid key rotation response", response.status);
  }
  return { ...issued, rotationId: raw.rotationId, expiresAt: raw.expiresAt };
}

export async function commitClientKeyRotation(
  managementUrl: string,
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  id: string,
  rotationId: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const origin = normalizeHubOrigin(managementUrl);
  assertRotationAuthorityOrigin(origin, credential);
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/api/keys/rotate/commit`, {
    method: "POST",
    headers: rotationManagementHeaders(credential),
    body: JSON.stringify({ id, rotationId }),
  }, options.timeoutMs);
  if (!response.ok) throw new HubClientError("key_rotation_commit_failed", `Hub refused rotation commit (${response.status})`, response.status);
}

export async function abortClientKeyRotation(
  managementUrl: string,
  credential: { kind: "admin"; value: Uint8Array } | { kind: "gui-session"; value: ConnectGuiSession },
  id: string,
  rotationId: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<void> {
  const origin = normalizeHubOrigin(managementUrl);
  assertRotationAuthorityOrigin(origin, credential);
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/api/keys/rotate`, {
    method: "DELETE",
    headers: rotationManagementHeaders(credential),
    body: JSON.stringify({ id, rotationId }),
  }, options.timeoutMs);
  if (!response.ok) throw new HubClientError("key_rotation_abort_failed", `Hub refused rotation abort (${response.status})`, response.status);
}

export async function downloadClientCatalog(
  serverUrl: string,
  admissionToken: string,
  options: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ kind: "fresh"; body: string; keyId?: string }> {
  const origin = normalizeHubOrigin(serverUrl);
  const headers = new Headers({ Accept: "application/json", "x-opencodex-api-key": admissionToken });
  // Unconditional by contract: /v1/catalog emits no validator (Phase 1, D2) because its
  // body varies by key identity, so there is nothing to revalidate against and a 304 could
  // only come from a hub that is misconfigured or being impersonated.
  const response = await fetchBounded(options.fetchImpl ?? fetch, `${origin}/v1/catalog`, {
    method: "GET",
    headers,
  }, options.timeoutMs, "headers");
  if (response.status === 304) {
    throw new HubClientError("catalog_unexpected_304", "Hub answered 304 to an unconditional catalog request", 304);
  }
  if (!response.ok) {
    const code = response.status === 401 ? "catalog_unauthorized" : `catalog_http_${response.status}`;
    throw new HubClientError(code, `Hub catalog request failed (${response.status})`, response.status);
  }
  if (!jsonCompatibleContentType(response)) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new HubClientError("catalog_content_type_invalid", "Hub catalog response was not JSON", response.status);
  }
  let body: string;
  try {
    body = await boundedText(response, options.maxBytes ?? MAX_REMOTE_CATALOG_BYTES, {
      inactivityTimeoutMs: safeTimeout(options.timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new HubClientError("unreachable", "Hub catalog download stalled", undefined, { cause: error });
    }
    throw error;
  }
  const parsed = parseJson(body, "catalog_invalid");
  validateRemoteCatalog(parsed);
  const keyId = response.headers.get("x-opencodex-key-id")?.trim() || undefined;
  return { kind: "fresh", body, ...(keyId ? { keyId } : {}) };
}

export async function probeClientKeyId(
  serverUrl: string,
  admissionToken: string,
  expectedKeyId: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  try {
    const catalog = await downloadClientCatalog(serverUrl, admissionToken, options);
    return catalog.kind === "fresh" && catalog.keyId === expectedKeyId;
  } catch (error) {
    if (error instanceof HubClientError && error.status === 401) return false;
    throw error;
  }
}
