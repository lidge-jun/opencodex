/**
 * Live Cursor model discovery via the `GetUsableModels` Connect-unary protobuf RPC.
 * HTTP/2 remains the default; an explicit HTTP/1.1 provider pin uses Bun fetch instead.
 *
 * Returns the account's actually-usable model ids (the full effort-suffixed variants Cursor offers
 * for THIS plan), so the routed catalog reflects reality instead of a static superset. Failures are
 * classified so callers can surface the reason before applying their existing degradation policy.
 *
 * Protocol notes (hard-won, see devlog 350.110):
 * - content-type `application/proto` + `connect-protocol-version: 1` (NOT `application/connect+proto`,
 *   which the endpoint rejects with 415).
 * - The request body is the EMPTY `GetUsableModelsRequest` → 0 bytes. It MUST be sent with `req.end()`
 *   and NO argument; `req.end(Buffer.alloc(0))` triggers `NGHTTP2_FRAME_SIZE_ERROR` on Bun, and a
 *   5-byte gRPC/Connect frame makes the server mis-parse it ("illegal tag: field no 0").
 */
import http2 from "node:http2";
import { cursorH2Pool } from "./h2-pool";
import { fromBinary } from "@bufbuild/protobuf";
import type { UpstreamHttpVersion } from "../../types";
import { readBoundedResponseBytes } from "../../lib/bounded-body";
import {
  isPinnedHttp1,
  UpstreamHttpVersionTargetError,
  withUpstreamHttpVersionValue,
} from "../../lib/upstream-http-version";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { GetUsableModelsResponseSchema } from "./gen/agent_pb";

const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const CURSOR_DISCOVERY_CLIENT_VERSION = "cli-2026.02.13-41ac335";
const CURSOR_MODEL_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
type CursorUsableModelsFetcher = (opts: CursorUsableModelsOptions) => Promise<CursorUsableModelsResult>;
let cursorUsableModelsFetcherForTests: CursorUsableModelsFetcher | null = null;

export interface CursorUsableModelsOptions {
  apiKey: string;
  baseUrl?: string;
  clientVersion?: string;
  timeoutMs?: number;
  upstreamHttpVersion?: UpstreamHttpVersion;
  /** Test/embedding seam. Production discovery uses Bun's global fetch in HTTP/1.1 mode. */
  fetch?: typeof globalThis.fetch;
}

export type CursorUsableModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "http" | "policy" | "transport" | "timeout" | "decode" | "empty" | "too_large"; detail?: string };

/** Test-only seam for management connectivity probes; production callers retain the HTTP/2 path. */
export function setFetchCursorUsableModelsForTests(next: CursorUsableModelsFetcher | null): void {
  cursorUsableModelsFetcherForTests = next;
}

const RETRYABLE_DISCOVERY_ERRORS = new Set(["timeout", "transport"]);
const DISCOVERY_RETRY_TIMEOUT_MS = 3_000;
const CURSOR_MAX_DISCOVERED_MODELS = 500;

/**
 * Live discovery with ONE bounded retry for transient pre-response failures (a fresh transport
 * attempt each time). Completed non-2xx responses ("http"), auth, decode, and empty are
 * deterministic and never retried. The retry attempt's deadline is capped so a cache-miss
 * catalog poll cannot stall much past the primary timeout (~11.5s worst case, accepted in
 * devlog 260723_cursor_context_continuity/030).
 */
export async function fetchCursorUsableModels(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  if (cursorUsableModelsFetcherForTests) return cursorUsableModelsFetcherForTests(opts);
  const resolved = resolveCursorDiscoveryBaseUrl(opts.baseUrl ?? "https://api2.cursor.sh");
  if (!resolved.ok) return resolved;
  const first = await fetchCursorUsableModelsOnce({ ...opts, baseUrl: resolved.baseUrl });
  if (first.ok || !RETRYABLE_DISCOVERY_ERRORS.has(first.error)) return first;
  await new Promise(resolve => setTimeout(resolve, 250 + Math.floor(Math.random() * 250)));
  return fetchCursorUsableModelsOnce({
    ...opts,
    baseUrl: resolved.baseUrl,
    timeoutMs: Math.min(opts.timeoutMs ?? 8000, DISCOVERY_RETRY_TIMEOUT_MS),
  });
}

function resolveCursorDiscoveryBaseUrl(raw: string): { ok: true; baseUrl: string } | Extract<CursorUsableModelsResult, { ok: false }> {
  const baseUrl = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { ok: false, error: "transport", detail: "Cursor discovery URL is invalid" };
  }
  if (parsed.protocol === "https:") return { ok: true, baseUrl };
  // Local h2c fixtures (and an operator loopback proxy) never leave the machine.
  // Anything else with a Bearer token must be HTTPS, matching providerOutbound POST.
  if (parsed.protocol === "http:") {
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "localhost" || host.endsWith(".localhost")) {
      return { ok: true, baseUrl };
    }
  }
  return { ok: false, error: "transport", detail: "Cursor discovery URL must use HTTPS" };
}

async function fetchCursorUsableModelsOnce(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  if (isPinnedHttp1(opts.upstreamHttpVersion)) return fetchCursorUsableModelsHttp1Once(opts);
  return fetchCursorUsableModelsHttp2Once(opts);
}

function cursorDiscoveryHeaders(opts: CursorUsableModelsOptions): Record<string, string> {
  return {
    "content-type": "application/proto",
    "connect-protocol-version": "1",
    authorization: `Bearer ${opts.apiKey}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": opts.clientVersion ?? CURSOR_DISCOVERY_CLIENT_VERSION,
    "x-cursor-client-type": "cli",
    "x-session-id": crypto.randomUUID(),
  };
}

function decodeCursorUsableModels(bytes: Uint8Array): CursorUsableModelsResult {
  try {
    const response = fromBinary(GetUsableModelsResponseSchema, bytes);
    // Account filtering uses wire `model_id` values only. Aliases like `composer-2-5` must not
    // make stale configured ids such as `composer-2` look activated.
    const ids: string[] = [];
    const seenIds = new Set<string>();
    for (const model of response.models ?? []) {
      const rawId = (model as { modelId?: string }).modelId;
      if (typeof rawId !== "string") continue;
      const id = rawId.trim();
      if (!isValidModelDiscoveryModelId(id) || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
      if (ids.length >= CURSOR_MAX_DISCOVERED_MODELS) break;
    }
    return ids.length > 0 ? { ok: true, models: ids } : { ok: false, error: "empty" };
  } catch {
    return { ok: false, error: "decode", detail: "Invalid GetUsableModels protobuf response" };
  }
}

async function fetchCursorUsableModelsHttp1Once(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  let requestUrl: string;
  try {
    const parsed = new URL(CURSOR_GET_USABLE_MODELS_PATH, opts.baseUrl ?? "https://api2.cursor.sh");
    if (parsed.protocol !== "https:") {
      return { ok: false, error: "policy", detail: "Cursor HTTP/1.1 discovery requires HTTPS" };
    }
    requestUrl = parsed.toString();
  } catch {
    return { ok: false, error: "transport", detail: "Cursor HTTP/1.1 discovery base URL is invalid" };
  }
  const timeoutMs = opts.timeoutMs ?? 8000;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException(`No response within ${timeoutMs}ms`, "TimeoutError"));
  }, timeoutMs);
  try {
    const init = withUpstreamHttpVersionValue(requestUrl, {
      method: "POST",
      headers: cursorDiscoveryHeaders(opts),
      redirect: "manual",
      signal: controller.signal,
    }, opts.upstreamHttpVersion);
    const response = await (opts.fetch ?? globalThis.fetch)(requestUrl, init);
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, error: "auth", detail: `HTTP ${response.status}` };
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, error: "http", detail: `HTTP ${response.status || "unknown"}` };
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > CURSOR_MODEL_DISCOVERY_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, error: "too_large", detail: "GetUsableModels response exceeds 4 MiB" };
    }
    const body = await readBoundedResponseBytes(response, {
      maxBytes: CURSOR_MODEL_DISCOVERY_MAX_BYTES,
      signal: controller.signal,
    });
    if (body.oversized) {
      return { ok: false, error: "too_large", detail: "GetUsableModels response exceeds 4 MiB" };
    }
    return decodeCursorUsableModels(body.bytes);
  } catch (error) {
    if (error instanceof UpstreamHttpVersionTargetError) {
      return { ok: false, error: "policy", detail: error.message };
    }
    return timedOut
      ? { ok: false, error: "timeout", detail: `No response within ${timeoutMs}ms` }
      : { ok: false, error: "transport", detail: "HTTP/1.1 request failed" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCursorUsableModelsHttp2Once(opts: CursorUsableModelsOptions): Promise<CursorUsableModelsResult> {
  const baseUrl = (opts.baseUrl ?? "https://api2.cursor.sh").replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise<CursorUsableModelsResult>(resolve => {
    let settled = false;
    const finish = (value: CursorUsableModelsResult): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };


   const timer = setTimeout(() => {
     // Cancel the borrowed pooled stream so it does not continue receiving
     // body bytes after the caller has timed out (regression vs pre-pool behavior).
     req?.destroy();
     finish({ ok: false, error: "timeout", detail: `No response within ${timeoutMs}ms` });
   }, timeoutMs);
   const close = (value: CursorUsableModelsResult): void => {
     clearTimeout(timer);
     finish(value);
   };


   let req: http2.ClientHttp2Stream;
   try {
      req = cursorH2Pool.request(baseUrl, {
       ":method": "POST",
       ":path": CURSOR_GET_USABLE_MODELS_PATH,
       ...cursorDiscoveryHeaders(opts),
     });
   } catch {
     return close({ ok: false, error: "transport", detail: "HTTP/2 request setup failed" });
   }

    let status = 0;
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let bodyRejected = false;
    req.on("response", headers => {
      status = Number(headers[":status"] ?? 0);
      const contentLength = Number(headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > CURSOR_MODEL_DISCOVERY_MAX_BYTES) {
        bodyRejected = true;
        req.close(http2.constants.NGHTTP2_CANCEL);
        close({ ok: false, error: "too_large", detail: "GetUsableModels response exceeds 4 MiB" });
      }
    });
    req.on("data", (chunk: Buffer) => {
      if (bodyRejected) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > CURSOR_MODEL_DISCOVERY_MAX_BYTES) {
        bodyRejected = true;
        req.close(http2.constants.NGHTTP2_CANCEL);
        close({ ok: false, error: "too_large", detail: "GetUsableModels response exceeds 4 MiB" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => close({ ok: false, error: "transport", detail: "HTTP/2 request failed" }));
    req.on("end", () => {
      if (bodyRejected) return;
      if (status === 401 || status === 403) {
        return close({ ok: false, error: "auth", detail: `HTTP ${status}` });
      }
      if (status !== 200) return close({ ok: false, error: "http", detail: `HTTP ${status || "unknown"}` });
      close(decodeCursorUsableModels(new Uint8Array(Buffer.concat(chunks))));
    });

    req.end(); // CRITICAL: no body argument (empty Buffer breaks Bun's HTTP/2 framing).
  });
}
