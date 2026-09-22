import { codexCompatibleUrl } from "../codex/context-compat";
/**
 * /v1/live and /v1/realtime/calls relay (issue #371).
 *
 * Codex App / ChatGPT voice (GPT‑Live / Frameless Bidi) POSTs call-create against the injected
 * `base_url`, then opens a sideband WebSocket at `/v1/live/{callId}` (Frameless) or
 * `/v1/realtime?call_id=` (Realtime v1). Under Design B that host is this proxy.
 *
 * Inbound HTTP:
 * - `POST /v1/live` — Frameless / ChatGPT App shape against an injected `/v1` base
 * - `POST /v1/realtime/calls` — openai/codex RealtimeCallClient and the public OpenAI Realtime API
 *
 * Upstream HTTP (matches openai/codex `RealtimeCallClient`):
 * - ChatGPT `backend-api` → JSON `{ sdp, session? }` at
 *   `{base}/realtime/calls?intent=quicksilver&architecture=avas`
 * - OpenAI API-key provider → multipart at
 *   `{base}/v1/realtime/calls?intent=quicksilver&architecture=avas`
 *
 * Inbound sideband WebSocket (transparent bidirectional relay):
 * - `GET /v1/live/{callId}` — Frameless
 * - `GET /v1/realtime/calls/{callId}` — path-form join
 * - `GET /v1/realtime?call_id=` — Realtime v1/v2 join
 *
 * Inbound standalone session WebSocket (no call-create; codex-rs `thread/realtime/start`
 * with the standalone WebSocket transport — the desktop voice path since 0.147.x):
 * - `GET /v1/realtime?intent=quicksilver&model=` — Realtime v1 standalone
 * - `GET /v1/realtime?model=` — RealtimeV2 standalone (no intent)
 * - `GET /v1/live?model=` — Frameless standalone
 */
import { closeSync, fchmodSync, fstatSync, openSync, statSync, writeSync } from "node:fs";
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  codexMainProfileDrainingResponse,
  cooldownErrorResponse,
  CodexAuthContextError,
  CodexMainProfileDrainingError,
  CodexModelAvailabilityError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { cancelBodyOnAbort, signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { hardenSecretPath } from "../lib/windows-secret-acl";
import type { OcxConfig } from "../types";
import { resolveFirstUsableOpenAiSidecar, selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential, type DataPlaneAdmission } from "./auth-cors";
import { admissionScopeDenial } from "./admission-model-scope";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId } from "./responses";
import type { AdmissionLease } from "../lib/admission";
import { codexAccountSelectionForTurn } from "./lifecycle";
import { codexModelAvailabilityErrorResponse } from "./responses/codex-auth-error";

/** Voice call create can wait on SDP negotiation; bound a hung upstream. */
const LIVE_UPSTREAM_TIMEOUT_MS = 120_000;
export const LIVE_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const LIVE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const LIVE_RELAY_HEADERS = ["content-type", "location"] as const;

/** AVAS WebRTC call-create query (openai/codex `configure_realtime_call_request`). */
export const LIVE_AVAS_QUERY = "intent=quicksilver&architecture=avas";

/**
 * Sideband WebSocket API root. openai/codex joins the sideband via the API provider default
 * (`to_api_provider(AuthMode::ApiKey)` → https://api.openai.com/v1) even for ChatGPT-auth calls
 * created through backend-api; chatgpt.com/backend-api rejects sideband upgrades pre-101
 * (verified live 2026-07-24). The call-create bearer works on the API host unchanged.
 */
export const LIVE_SIDEBAND_API_ROOT = "https://api.openai.com/v1";

/**
 * Client protocol headers relayed verbatim to the upstream on call-create and sideband upgrade.
 * `openai-alpha: quicksilver=v2` carries the Frameless protocol negotiation — without it the
 * ChatGPT backend validates the type-less Frameless session as v1 quicksilver and 400s
 * (openai/codex `realtime_request_headers`, core/src/realtime_conversation.rs).
 *
 * `x-codex-turn-metadata` is on the same list upstream builds for the sideband upgrade and was
 * missing here, so every realtime turn reached the model with metadata the client had attached
 * and this proxy silently dropped. The Responses passthrough already forwards it
 * (`src/adapters/openai-responses/passthrough.ts`); the sideband goes to the same realtime
 * upstream the caller was addressing, so there is nothing to scope it away from. That is not
 * true of the images sidecar, which strips it deliberately and keeps doing so.
 *
 * Every name here is relayed only when the caller sent it. Nothing on this list is invented,
 * which is what keeps a caller that omits one byte-identical upstream. Auth headers
 * (`authorization`, `chatgpt-account-id`) stay proxy-owned and are never taken from this list.
 */
export const LIVE_CLIENT_PROTOCOL_HEADERS = [
  "openai-alpha",
  "x-session-id",
  "session-id",
  "thread-id",
  "originator",
  "x-oai-attestation",
  "x-codex-turn-metadata",
] as const;

/**
 * Env-gated sideband frame forensics (diagnostic for multibyte transcript corruption).
 *
 * When `OCX_LIVE_FRAME_LOG` is set to a file path, every relayed sideband frame appends one
 * JSONL record: direction, frame kind, byte length, and whether the payload contains U+FFFD.
 * Privacy: no frame content is written, including excerpts around replacement characters.
 * For binary frames, U+FFFD may also be introduced by UTF-8 decoding; the flag alone does not
 * identify the source of corruption. The log is created with owner-only permissions and is
 * disabled entirely when the env var is unset.
 */
export const LIVE_FRAME_LOG_ENV = "OCX_LIVE_FRAME_LOG";
/**
 * Append one JSONL record with owner-only permissions. `appendFileSync`'s `mode` only applies
 * when it creates the file, so an existing permissive log would stay readable by other local
 * users. Open for append, harden the target, and verify that the path still names
 * the opened file before writing. A failed harden or identity check writes nothing. On Windows
 * the hardened file's identity is remembered, so a replaced file is hardened again but an
 * unchanged one does not spawn icacls for every frame.
 */
/** Windows ACL hardening spawns icacls; remember the file already hardened so frames do not. */
let hardenedWindowsFrameLog: { path: string; dev: bigint; ino: bigint } | undefined;

export function appendOwnerOnly(
  path: string,
  line: string,
  harden: (fd: number, path: string) => void = hardenLogDescriptor,
  platform: NodeJS.Platform = process.platform,
): void {
  const fd = openSync(path, "a", 0o600);
  try {
    const before = fstatSync(fd, { bigint: true });
    const memo = hardenedWindowsFrameLog;
    const alreadyHardened = platform === "win32" && memo !== undefined && memo.path === path
      && before.ino !== 0n && memo.dev === before.dev && memo.ino === before.ino;
    if (!alreadyHardened) {
      hardenedWindowsFrameLog = undefined;
      harden(fd, path);
    }
    const opened = fstatSync(fd, { bigint: true });
    const named = statSync(path, { bigint: true });
    if (!opened.isFile() || !named.isFile() || opened.ino === 0n || named.ino === 0n
      || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error("Frame log path changed during hardening.");
    }
    if (platform === "win32") hardenedWindowsFrameLog = { path, dev: opened.dev, ino: opened.ino };
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function hardenLogDescriptor(fd: number, path: string): void {
  if (process.platform === "win32") {
    hardenSecretPath(path, { required: true });
    return;
  }
  fchmodSync(fd, 0o600);
}

export function logLiveSidebandFrame(dir: "c2u" | "u2c", data: unknown): void {
  const logPath = process.env[LIVE_FRAME_LOG_ENV];
  if (!logPath) return;
  try {
    let kind: "text" | "binary" = "binary";
    let bytes = 0;
    let fffd = false;
    if (typeof data === "string") {
      kind = "text";
      bytes = Buffer.byteLength(data);
      fffd = data.includes("\uFFFD");
    } else if (data instanceof ArrayBuffer) {
      bytes = data.byteLength;
      fffd = new TextDecoder().decode(new Uint8Array(data)).includes("\uFFFD");
    } else if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      bytes = data.byteLength;
      fffd = new TextDecoder().decode(view).includes("\uFFFD");
    } else {
      return;
    }
    const record = {
      ts: new Date().toISOString(),
      dir,
      kind,
      bytes,
      fffd,
    };
    appendOwnerOnly(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Frame forensics must never break the relay.
  }
}

/**
 * Sideband lifecycle stages, recorded in the same JSONL as the frame records.
 *
 * Frame forensics alone cannot separate the three realtime-voice failures reported in #4721.
 * A join that never reached this proxy, a join whose upstream handshake was refused, and a
 * relay that opened and then carried nothing all leave the same empty file, which is why the
 * original report could only say "no frame log". One record per stage makes them distinct:
 * no record at all means the client never dialed the proxy, `upstream-failed` carries the
 * status the client was handed, and `relay-attached` with no following frame record means the
 * transport is live and the silence is upstream of it.
 */
export type LiveSidebandStage = "upstream-open" | "upstream-failed" | "relay-attached" | "relay-closed";

/**
 * Append one lifecycle record. Same privacy rule as the frame records and for the same reason:
 * no URL, no call id, no header, no frame content — only the stage and, on failure, the status
 * and error code this proxy synthesized itself.
 */
export function logLiveSidebandStage(
  stage: LiveSidebandStage,
  detail?: { status?: number; code?: string },
): void {
  const logPath = process.env[LIVE_FRAME_LOG_ENV];
  if (!logPath) return;
  try {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), stage };
    if (detail?.status !== undefined) record.status = detail.status;
    if (detail?.code !== undefined) record.code = detail.code;
    appendOwnerOnly(logPath, JSON.stringify(record) + "\n");
  } catch {
    // Diagnostics must never break the relay.
  }
}

function clientProtocolHeaders(reqHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LIVE_CLIENT_PROTOCOL_HEADERS) {
    const value = reqHeaders.get(name);
    if (value != null && value !== "") out[name] = value;
  }
  return out;
}

const LIVE_CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Decode one path-segment call id. A malformed percent escape (`%ZZ`) makes
 * `decodeURIComponent` throw; that must read as "not a sideband target" (JSON 404),
 * never escape the router as a 500.
 */
function decodeLiveCallId(segment: string): string | null {
  try {
    const callId = decodeURIComponent(segment);
    return LIVE_CALL_ID_RE.test(callId) ? callId : null;
  } catch {
    return null;
  }
}

/**
 * Credential-shaped query keys never forwarded upstream on a standalone realtime
 * relay. Auth on the upstream socket is proxy-owned (headers resolved by
 * `resolveLiveRelay`); a caller that puts `access_token=`/`api_key=`/... in the
 * URL must not get it relayed to the configured upstream. Compared case-folded on
 * both the raw and percent-decoded key. Everything else — `intent`, `model`,
 * duplicates, protocol extensions — passes through verbatim, matching codex-rs
 * client behavior of constructing those fields itself.
 */
const STANDALONE_QUERY_DENYLIST = new Set([
  "access_token",
  "api_key",
  "apikey",
  "token",
  "key",
  "authorization",
  "auth",
  "signature",
  "sig",
]);

/**
 * Filter a raw query string (no leading `?`) for standalone upstream relay: drop
 * denylisted credential-shaped pairs, preserve the rest byte-for-byte (including
 * ordering, duplicates, noncanonical encodings, and bare keys).
 */
export function sanitizeStandaloneRealtimeQuery(rawQuery: string): string {
  if (!rawQuery) return "";
  const kept: string[] = [];
  for (const pair of rawQuery.split("&")) {
    const eq = pair.indexOf("=");
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    let decodedKey = rawKey;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch {
      // Leave undecodable keys as-is; the raw comparison still applies.
    }
    if (STANDALONE_QUERY_DENYLIST.has(rawKey.toLowerCase()) || STANDALONE_QUERY_DENYLIST.has(decodedKey.toLowerCase())) {
      console.warn(`[live] standalone realtime relay dropping credential-shaped query param: ${decodedKey}`);
      continue;
    }
    kept.push(pair);
  }
  return kept.join("&");
}

export type LiveSidebandTarget =
  | { style: "frameless-path"; callId: string }
  | { style: "realtime-calls-path"; callId: string }
  | { style: "realtime-query"; callId: string }
  | { style: "realtime-standalone"; query: string }
  | { style: "frameless-standalone"; query: string };

export type LiveRelayTarget = {
  headers: Record<string, string>;
  providerBaseUrl: string;
  usesBackendShape: boolean;
  keyed: boolean;
  recordOutcome?: (status: number | "timeout" | "connect_error") => void;
};

function isChatGptBackendBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("/backend-api");
}

function withAvasQuery(url: string): string {
  if (/[?&]intent=/.test(url) && /[?&]architecture=/.test(url)) return url;
  return url.includes("?") ? `${url}&${LIVE_AVAS_QUERY}` : `${url}?${LIVE_AVAS_QUERY}`;
}

export function keyedLiveUrl(baseUrl: string): string {
  return withAvasQuery(`${baseUrl.replace(/\/v1\/?$/, "")}/v1/realtime/calls`);
}

export function forwardLiveUrl(baseUrl: string, usesBackendShape: boolean): string {
  const root = baseUrl.replace(/\/+$/, "");
  if (usesBackendShape) return withAvasQuery(`${root}/realtime/calls`);
  // Frameless API shape posts to /live without the AVAS query (codex RealtimeCallClient).
  return `${root}/live`;
}

function httpsToWss(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

export function parseLiveSidebandTarget(pathname: string, searchParams: URLSearchParams, rawQuery = ""): LiveSidebandTarget | null {
  const liveMatch = pathname.match(/^\/v1\/live\/([^/]+)\/?$/);
  if (liveMatch) {
    const callId = decodeLiveCallId(liveMatch[1]!);
    if (!callId) return null;
    return { style: "frameless-path", callId };
  }
  // Standalone Frameless session (no call-create): `GET /v1/live?model=`.
  if (pathname === "/v1/live" || pathname === "/v1/live/") {
    return { style: "frameless-standalone", query: sanitizeStandaloneRealtimeQuery(rawQuery) };
  }
  const callsMatch = pathname.match(/^\/v1\/realtime\/calls\/([^/]+)\/?$/);
  if (callsMatch) {
    const callId = decodeLiveCallId(callsMatch[1]!);
    if (!callId) return null;
    return { style: "realtime-calls-path", callId };
  }
  if (pathname === "/v1/realtime" || pathname === "/v1/realtime/") {
    // A present-but-invalid `call_id` is a malformed join, not a standalone
    // session — keep rejecting it instead of silently changing the request's
    // meaning.
    if (searchParams.has("call_id")) {
      const callId = searchParams.get("call_id")?.trim() ?? "";
      if (!LIVE_CALL_ID_RE.test(callId)) return null;
      return { style: "realtime-query", callId };
    }
    // Standalone Realtime session (codex-rs thread/realtime/start, WebSocket
    // transport): v1 sends `intent=quicksilver&model=`, v2 sends `model=` only.
    return { style: "realtime-standalone", query: sanitizeStandaloneRealtimeQuery(rawQuery) };
  }
  return null;
}

/**
 * True for the loopback hosts plaintext development servers listen on.
 * `URL.hostname` keeps the brackets on IPv6, so both forms are accepted.
 */
function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const ipv4 = lower.split(".");
  const ipv4Loopback = ipv4.length === 4
    && ipv4[0] === "127"
    && ipv4.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  return lower === "localhost" || lower.endsWith(".localhost")
    || ipv4Loopback
    || lower === "::1" || lower === "[::1]";
}

/**
 * Normalize the sideband base to end in exactly `/v1`, with no query, fragment,
 * or userinfo. Any failure closes to the canonical Realtime API root — never to
 * the input — because this string decides where upstream bearer credentials and
 * user audio are sent.
 *
 * Bounds, all fail-closed:
 *   - scheme must be https/wss, or http/ws with a loopback host (the local
 *     development case this knob exists for);
 *   - URL userinfo is rejected (URL#toString would forward it verbatim);
 *   - unparseable input is rejected.
 *
 * Endpoint-form overrides are recognized the way upstream recognizes them
 * (codex-rs realtime_websocket/methods.rs:994): a terminal `/realtime`,
 * `/realtime/calls/<id>`, or `/live/<id>` is stripped so the root can be
 * re-derived. A path prefix survives (`https://host/api/v1` keeps `/api`).
 */
function normalizeSidebandRoot(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return LIVE_SIDEBAND_API_ROOT;
  }
  const secure = parsed.protocol === "https:" || parsed.protocol === "wss:";
  const plaintext = parsed.protocol === "http:" || parsed.protocol === "ws:";
  if ((!secure && !plaintext) || (plaintext && !isLoopbackHost(parsed.hostname)) || parsed.username || parsed.password) {
    return LIVE_SIDEBAND_API_ROOT;
  }
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/realtime(?:\/calls\/[^/]+)?$/, "")
    .replace(/\/live\/[^/]+$/, "")
    .replace(/\/v1$/, "");
  parsed.pathname = `${path}/v1`;
  return parsed.toString().replace(/\/$/, "");
}

/**
 * Resolve the sideband base. Upstream policy (codex-rs 438c9e98d): the sideband
 * join is NOT derived from the selected model provider — precedence is exactly
 * the explicit override when configured, otherwise the canonical Realtime API
 * root. The provider base URL deliberately plays no part; a user who needs a
 * non-canonical host sets the override, the same escape hatch upstream ships as
 * `experimental_realtime_ws_base_url`.
 */
function sidebandBaseRoot(overrideBaseUrl?: string): string {
  return normalizeSidebandRoot(overrideBaseUrl?.trim() || LIVE_SIDEBAND_API_ROOT);
}

/**
 * Build the upstream sideband WebSocket URL for a resolved OpenAI/ChatGPT provider.
 * Mirrors openai/codex `websocket_url_from_api_url_for_call` + `normalize_realtime_path`.
 *
 * Deliberate deviation: the realtime-query style keeps `intent=quicksilver`,
 * which upstream does not send. That URL is live against real OpenAI
 * infrastructure for every canonical voice user and this parameter is known to
 * work; dropping it is future work gated on a live smoke test. Parity here is
 * scoped to the host, override precedence, and provider-query exclusion.
 */
export function buildLiveSidebandUpstreamWsUrl(
  target: LiveSidebandTarget,
  overrideBaseUrl?: string,
): string {
  const sidebandRoot = sidebandBaseRoot(overrideBaseUrl);
  if (target.style === "frameless-path") {
    return httpsToWss(`${sidebandRoot}/live/${target.callId}`);
  }
  if (target.style === "frameless-standalone") {
    return httpsToWss(`${sidebandRoot}/live${target.query ? `?${target.query}` : ""}`);
  }
  if (target.style === "realtime-standalone") {
    return httpsToWss(`${sidebandRoot}/realtime${target.query ? `?${target.query}` : ""}`);
  }
  if (target.style === "realtime-calls-path") {
    return httpsToWss(`${sidebandRoot}/realtime/calls/${target.callId}`);
  }
  return httpsToWss(
    `${sidebandRoot}/realtime?intent=quicksilver&call_id=${encodeURIComponent(target.callId)}`,
  );
}

export async function backendJsonBodyFromApiMultipart(
  body: ArrayBuffer,
  contentType: string,
): Promise<{ body: Uint8Array; contentType: string } | Response> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay could not parse multipart call-create body",
    );
  }
  const sdp = form.get("sdp");
  if (typeof sdp !== "string") {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay expects multipart field sdp on call-create",
    );
  }
  // `session` is optional on the public Realtime calls API; omit when the client sends SDP only.
  const sessionRaw = form.get("session");
  let session: unknown | undefined;
  if (sessionRaw != null) {
    if (typeof sessionRaw !== "string") {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected a string multipart session field",
      );
    }
    try {
      session = JSON.parse(sessionRaw);
    } catch {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected JSON in the multipart session field",
      );
    }
  }
  const payload = session === undefined ? { sdp } : { sdp, session };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return { body: encoded, contentType: "application/json" };
}

/** Read a body stream with a hard byte cap so oversized payloads abort before full buffering. */
export async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeMessage: (total: number) => string,
  signal?: AbortSignal,
): Promise<ArrayBuffer | Response> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const abortRead = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener("abort", abortRead, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (signal?.aborted) abortRead();
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return formatErrorResponse(502, "upstream_error", tooLargeMessage(total));
      }
      chunks.push(value);
    }
  } catch (err) {
    // A read that throws leaves the stream neither drained nor cancelled, and releasing the
    // lock alone hands back an unsettled body. Cancel first, then rethrow so the caller's
    // existing classification (client abort / timeout / connect error) is unchanged. The
    // cancel itself can reject with the stream's stored error — that is expected and must not
    // mask the original failure, so it is swallowed here.
    await reader.cancel(err).catch(() => {});
    throw err;
  } finally {
    signal?.removeEventListener("abort", abortRead);
    try {
      // Always release: `reader.cancel()` does NOT drop the lock, and holding it would leave
      // the stream permanently locked for any later consumer (audit R-WP5-2).
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
  }
  if (chunks.length === 0) return new ArrayBuffer(0);
  if (chunks.length === 1) {
    const only = chunks[0]!;
    return only.buffer.slice(only.byteOffset, only.byteOffset + only.byteLength) as ArrayBuffer;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function readRequestBodyCapped(req: Request, maxBytes: number): Promise<ArrayBuffer | Response> {
  try {
    const result = await readBodyCapped(
      req.body,
      maxBytes,
      total => `live request body too large (${total} bytes)`,
    );
    if (result instanceof Response) {
      // Oversize inbound is a client error, not an upstream failure.
      return formatErrorResponse(413, "invalid_request_error", `live request body too large`);
    }
    return result;
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    return formatErrorResponse(
      400,
      "invalid_request_error",
      `live request body unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Who is asking and for which live model, as far as a per-key scope is concerned.
 *
 * This path has no router to resolve a destination, so the model is read where
 * the client states it — the call-create session, or a standalone socket's own
 * query — and the provider is whichever OpenAI upstream this relay settles on.
 * `model` is undefined when nobody stated one: a call-create that sends no
 * session model, or a join onto a call this compatibility path never recorded.
 */
export interface LiveScopeDestination {
  admission?: DataPlaneAdmission;
  model: string | undefined;
}

/**
 * The live model a call-create body names, or undefined when it names none.
 *
 * Both inbound shapes carry it at `session.model` — JSON directly, multipart in
 * the `session` field — and this path relays the body upstream unchanged, so
 * the string is the destination rather than a selector the proxy rewrites. A
 * body that states nothing readable leaves the model to the upstream, which is
 * a destination no model list can describe.
 */
export async function liveCallCreateModel(body: ArrayBuffer, contentType: string): Promise<string | undefined> {
  try {
    let session: unknown;
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
      const raw = form.get("session");
      session = typeof raw === "string" ? JSON.parse(raw) : undefined;
    } else {
      session = (JSON.parse(new TextDecoder().decode(body)) as { session?: unknown } | null)?.session;
    }
    const model = (session as { model?: unknown } | null | undefined)?.model;
    return typeof model === "string" && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The model a sideband upgrade is for, or undefined when the request names none.
 *
 * A standalone session states it in the query it forwards. A join names nothing
 * of its own: the call it attaches to chose a model at create time, and only a
 * recorded binding can say which. This compatibility path keeps no such record,
 * so a native join is undefined here and the external path in `audio-live.ts`
 * supplies the model its binding stored.
 */
export function liveSidebandModel(target: LiveSidebandTarget): string | undefined {
  if (target.style === "realtime-standalone" || target.style === "frameless-standalone") {
    return new URLSearchParams(target.query).get("model")?.trim() || undefined;
  }
  return undefined;
}

/**
 * Resolve OpenAI/ChatGPT auth + headers for live HTTP or sideband WebSocket relays.
 * Shared by call-create and sideband so pool token override stays consistent.
 */
export async function resolveLiveRelay(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
  destination?: LiveScopeDestination,
): Promise<LiveRelayTarget | Response> {
  try {
    validateForwardAdmissionCredential(req.headers, config);
  } catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    throw err;
  }

  const candidates = selectOpenAiImagesProvider(config);
  if (candidates.forwardCandidates.length === 0 && !candidates.keyed) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in ChatGPT voice needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider), "
        + "but none is configured in opencodex. Routed providers cannot serve voice call-create.",
    );
  }

  let forward: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>> | undefined;
  let forwardAuthError: Response | undefined;
  if (candidates.forwardCandidates.length > 0) {
    try {
      forward = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, req.headers, config, {
        beginCodexAccountSelection: codexAccountSelectionForTurn(turnAdmissionLease),
      });
      if (forward) {
        logCtx.provider = formatCodexProviderForLog(
          forward.providerName,
          codexLogAccountId(forward.authContext),
          config,
        );
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = cooldownErrorResponse(err);
      } else if (err instanceof CodexMainProfileDrainingError) {
        forwardAuthError = codexMainProfileDrainingResponse();
      } else if (err instanceof CodexThreadAffinityExpiredError) {
        forwardAuthError = formatErrorResponse(
          409,
          "invalid_request_error",
          "Codex thread account affinity expired; start a new session",
        );
      } else if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog("openai", err.accountId, config);
        console.error(`[live] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        forwardAuthError = formatErrorResponse(
          401,
          "authentication_error",
          "Selected Codex account needs reauthentication",
        );
      } else if (err instanceof CodexModelAvailabilityError) {
        forwardAuthError = codexModelAvailabilityErrorResponse(err);
      } else if (err instanceof CodexPoolAuthenticationError) {
        forwardAuthError = formatErrorResponse(401, "authentication_error", err.message);
      } else {
        throw err;
      }
    }
  }

  // Client protocol headers first so provider/auth headers below always win on conflict.
  const headers: Record<string, string> = clientProtocolHeaders(req.headers);
  const scopedModel = destination?.model;
  if (forward) {
    const { provider } = forward;
    // The upstream is settled here and voice bills it for whatever model this
    // request carries. Refuse before any of it is sent, and give back the probe
    // lease the resolution took. A join states no model and this path keeps no
    // record of the call it attaches to, so a key with a model list is refused
    // there rather than admitted against an assumed default.
    const denial = admissionScopeDenial(config, destination?.admission, scopedModel, {
      providerName: forward.providerName,
      modelId: scopedModel,
    });
    if (denial) {
      forward.releaseProbeLease?.();
      return denial;
    }
    if (provider.headers) Object.assign(headers, provider.headers);
    for (const [name, value] of forward.headers) headers[name] = value;
    logCtx.model = "gpt-live";
    return {
      headers,
      providerBaseUrl: provider.baseUrl,
      usesBackendShape: isChatGptBackendBaseUrl(provider.baseUrl),
      keyed: false,
      recordOutcome: status => forward.recordOutcome?.(status),
    };
  }
  if (forwardAuthError) return forwardAuthError;
  if (candidates.keyed) {
    const { provider, apiKey, providerName } = candidates.keyed;
    const denial = admissionScopeDenial(config, destination?.admission, scopedModel, {
      providerName,
      modelId: scopedModel,
    });
    if (denial) return denial;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers.authorization = `Bearer ${apiKey}`;
    logCtx.provider = providerName;
    logCtx.model = "gpt-live";
    return {
      headers,
      providerBaseUrl: provider.baseUrl,
      usesBackendShape: false,
      keyed: true,
    };
  }
  return formatErrorResponse(
    401,
    "authentication_error",
    "voice relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
  );
}

export async function handleLive(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  turnAdmissionLease?: AdmissionLease,
  admission?: DataPlaneAdmission,
): Promise<Response> {
  const inboundContentType = req.headers.get("content-type") ?? "application/octet-stream";
  const inboundBodyOrError = await readRequestBodyCapped(req, LIVE_REQUEST_MAX_BYTES);
  if (inboundBodyOrError instanceof Response) return inboundBodyOrError;
  const inboundBody = inboundBodyOrError;

  const relay = await resolveLiveRelay(req, config, logCtx, turnAdmissionLease, {
    admission,
    model: await liveCallCreateModel(inboundBody, inboundContentType),
  });
  if (relay instanceof Response) return relay;

  const headers: Record<string, string> = { ...relay.headers };
  let url: string;
  let outboundBody: ArrayBuffer = inboundBody;
  let outboundContentType = inboundContentType;

  if (!relay.keyed) {
    url = forwardLiveUrl(relay.providerBaseUrl, relay.usesBackendShape);
    if (relay.usesBackendShape && inboundContentType.toLowerCase().includes("multipart/form-data")) {
      const rewritten = await backendJsonBodyFromApiMultipart(inboundBody, inboundContentType);
      if (rewritten instanceof Response) return rewritten;
      outboundBody = rewritten.body.buffer.slice(
        rewritten.body.byteOffset,
        rewritten.body.byteOffset + rewritten.body.byteLength,
      ) as ArrayBuffer;
      outboundContentType = rewritten.contentType;
    }
  } else {
    // Frameless API-shape call-create posts to `{base}/live` without the AVAS
    // query (openai/codex RealtimeCallClient, realtime_call.rs); only the
    // realtime/calls inbound shape keeps the legacy keyed AVAS endpoint.
    url = codexCompatibleUrl(req.url).pathname === "/v1/live"
      ? forwardLiveUrl(relay.providerBaseUrl, /* usesBackendShape */ false)
      : keyedLiveUrl(relay.providerBaseUrl);
  }

  headers["content-type"] = outboundContentType;

  const linkedSignal = signalWithTimeout(LIVE_UPSTREAM_TIMEOUT_MS, req.signal);
  const sidecarExit = sidecarEnter("live");
  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: outboundBody,
      signal: linkedSignal.signal,
      // Credential-bearing: do not follow a cross-origin 3xx. Bun strips `Authorization`
      // across origins but forwards nonstandard headers such as `chatgpt-account-id`,
      // `session_id`, and `x-codex-turn-metadata` to the redirect target.
      redirect: "manual",
    });
    // Record every completed upstream response before body size handling so account health /
    // cooldown still updates when we reject an oversized payload.
    relay.recordOutcome?.(upstreamResponse.status);
    // Settle the body on abort before the reader attaches. Without this, a client cancel or the
    // linked timeout landing between fetch resolution and `readBodyCapped`'s `getReader()`
    // leaves Bun's internal read rejection orphaned off the awaited path, where no caller
    // try/catch can intercept it (src/lib/abort.ts). The guard covers the window BEFORE the
    // reader exists; once a reader holds the lock only the reader can cancel, which is why
    // readBodyCapped also cancels on a failed read. Found while investigating #1419.
    const detachBodyGuard = cancelBodyOnAbort(upstreamResponse.body, linkedSignal.signal);
    let payload: ArrayBuffer | Response;
    try {
      payload = await readBodyCapped(
        upstreamResponse.body,
        LIVE_RESPONSE_MAX_BYTES,
        total => `live response too large (${total} bytes)`,
      );
    } finally {
      detachBodyGuard();
    }
    if (payload instanceof Response) return payload;
    const relayHeaders: Record<string, string> = {};
    for (const name of LIVE_RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) relayHeaders[name] = value;
    }
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      relay.recordOutcome?.("timeout");
      return formatErrorResponse(504, "upstream_error", "live upstream timed out");
    }
    relay.recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `live relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Resolve sideband upstream WebSocket URL + headers for an accepted upgrade. */
export async function resolveLiveSidebandUpgrade(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  target: LiveSidebandTarget,
  turnAdmissionLease?: AdmissionLease,
  admission?: DataPlaneAdmission,
): Promise<{ headers: Record<string, string>; upstreamWsUrl: string; recordOutcome?: LiveRelayTarget["recordOutcome"] } | Response> {
  const relay = await resolveLiveRelay(req, config, logCtx, turnAdmissionLease, {
    admission,
    model: liveSidebandModel(target),
  });
  if (relay instanceof Response) return relay;
  return {
    headers: relay.headers,
    upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(target, config.experimentalRealtimeWsBaseUrl),
    recordOutcome: relay.recordOutcome,
  };
}
