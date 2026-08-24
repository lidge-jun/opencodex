import { createHash } from "node:crypto";
import { BodyTooLargeError, readBoundedBody } from "./body";
import type { HubConfig } from "./config";
import type { HubBilling } from "./billing";
import { hmacDigest, securityHeaders } from "./security";

export const HUB_PUBLIC_PROXY_PATHS = Object.freeze([
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/models",
] as const);
const FORWARDED_PATHS = new Set<string>(HUB_PUBLIC_PROXY_PATHS);
const BODY_MAX_BYTES = 8 * 1024 * 1024;
const MODEL_CATALOG_MAX_BYTES = 512 * 1024;
const MODEL_CATALOG_MAX_ENTRIES = 500;
const FORWARD_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "openai-beta",
  "user-agent",
]);
const FORWARD_RESPONSE_HEADERS = new Set([
  "cache-control",
  // `content-encoding` is intentionally omitted: Bun decodes the body but retains that upstream header.
  "content-type",
  "retry-after",
  "x-request-id",
  "request-id",
  "openai-processing-ms",
]);

function json(data: unknown, status: number, extra?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...securityHeaders(), ...Object.fromEntries(new Headers(extra)) },
  });
}

function publicApiKey(req: Request): string | null {
  const authorization = req.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? null;
  const xApiKey = req.headers.get("x-api-key");
  if (bearer && xApiKey && bearer !== xApiKey) return null;
  return bearer ?? xApiKey;
}

function forwardedHeaders(req: Request, internalToken: string, requestId: string): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    if (FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("X-OpenCodex-API-Key", internalToken);
  headers.set("X-Hubapi-Request-Id", requestId);
  return headers;
}

function responseHeaders(upstream: Response, requestId: string): Headers {
  const headers = new Headers(securityHeaders());
  for (const [name, value] of upstream.headers) {
    if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  headers.set("X-Hubapi-Request-Id", requestId);
  return headers;
}

function upstreamErrorHeaders(upstream: Response, requestId: string): Headers {
  const headers = new Headers({ "X-Hubapi-Request-Id": requestId });
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return headers;
}

function boundedSignal(requestSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]);
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes || !response.body) throw new Error("invalid_catalog_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("catalog_response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export interface HubModelCatalog {
  status: "available" | "empty" | "unavailable";
  models: string[];
  observedAt: number;
  upstreamStatus: number | null;
}

function modelAliasFromBody(body: ArrayBuffer): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as { model?: unknown };
    if (typeof parsed?.model !== "string") return null;
    const normalized = parsed.model.trim().normalize("NFKC");
    return normalized.length >= 1 && normalized.length <= 200 ? normalized : null;
  } catch {
    return null;
  }
}

function wrapSettledBody(
  body: ReadableStream<Uint8Array>,
  firstOutput: () => void,
  settle: () => void,
  interrupt: (kind: "error" | "cancel") => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let terminal = false;
  let outputStarted = false;
  const finish = (fn: () => void) => {
    if (terminal) return;
    terminal = true;
    fn();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish(settle);
          controller.close();
        } else {
          if (!outputStarted && result.value.byteLength > 0) {
            outputStarted = true;
            firstOutput();
          }
          controller.enqueue(result.value);
        }
      } catch (error) {
        finish(() => interrupt("error"));
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        finish(() => interrupt("cancel"));
      } finally {
        await reader.cancel(reason);
      }
    },
  });
}

export class HubAdmission {
  constructor(
    private readonly config: HubConfig,
    private readonly billing: HubBilling,
    private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  ) {}

  handles(pathname: string): boolean {
    return FORWARDED_PATHS.has(pathname);
  }

  async modelCatalog(requestSignal?: AbortSignal): Promise<HubModelCatalog> {
    const observedAt = Date.now();
    const requestId = crypto.randomUUID();
    let upstreamStatus: number | null = null;
    const target = new URL("/v1/models", this.config.opencodexOrigin);
    const headers = new Headers({ Accept: "application/json" });
    headers.set("X-OpenCodex-API-Key", this.config.internalAdmissionToken);
    headers.set("X-Hubapi-Request-Id", requestId);
    const signal = requestSignal
      ? boundedSignal(requestSignal, this.config.upstreamTimeoutMs)
      : AbortSignal.timeout(this.config.upstreamTimeoutMs);
    try {
      const upstream = await this.fetchImpl(target, { method: "GET", headers, redirect: "manual", signal });
      upstreamStatus = upstream.status;
      if (!upstream.ok || !upstream.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        await upstream.body?.cancel().catch(() => undefined);
        return { status: "unavailable", models: [], observedAt, upstreamStatus: upstream.status };
      }
      const payload = await readBoundedJson(upstream, MODEL_CATALOG_MAX_BYTES) as { data?: unknown };
      if (!Array.isArray(payload?.data)) return { status: "unavailable", models: [], observedAt, upstreamStatus: upstream.status };
      const models: string[] = [];
      const seen = new Set<string>();
      for (const row of payload.data) {
        if (!row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string") continue;
        const id = (row as { id: string }).id.trim().normalize("NFKC");
        if (id.length < 1 || id.length > 200 || seen.has(id)) continue;
        seen.add(id);
        models.push(id);
        if (models.length >= MODEL_CATALOG_MAX_ENTRIES) break;
      }
      return { status: models.length ? "available" : "empty", models, observedAt, upstreamStatus: upstream.status };
    } catch {
      return { status: "unavailable", models: [], observedAt, upstreamStatus };
    }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (!this.handles(url.pathname)) return json({ error: "not_found" }, 404);
    if ((url.pathname === "/v1/models" && req.method !== "GET") || (url.pathname !== "/v1/models" && req.method !== "POST")) {
      return json({ error: "method_not_allowed" }, 405, { Allow: url.pathname === "/v1/models" ? "GET" : "POST" });
    }
    const key = publicApiKey(req);
    const principal = key ? this.billing.authenticateApiKey(key) : null;
    if (!principal) return json({ error: "invalid_api_key" }, 401);
    const requestId = crypto.randomUUID();
    const target = new URL(`${url.pathname}${url.search}`, this.config.opencodexOrigin);
    const signal = boundedSignal(req.signal, this.config.upstreamTimeoutMs);

    if (url.pathname === "/v1/models") {
      try {
        const upstream = await this.fetchImpl(target, {
          method: "GET",
          headers: forwardedHeaders(req, this.config.internalAdmissionToken, requestId),
          redirect: "manual",
          signal,
        });
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => undefined);
          return json({ error: "upstream_rejected", requestId }, upstream.status, upstreamErrorHeaders(upstream, requestId));
        }
        return new Response(upstream.body, { status: upstream.status, headers: responseHeaders(upstream, requestId) });
      } catch {
        return json({ error: "upstream_unavailable", requestId }, 502);
      }
    }

    const contentEncoding = req.headers.get("content-encoding")?.trim().toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") return json({ error: "unsupported_content_encoding" }, 415);
    const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return json({ error: "unsupported_media_type" }, 415);
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared < 0 || declared > BODY_MAX_BYTES) return json({ error: "request_too_large" }, 413);
    let body: ArrayBuffer;
    try {
      body = await readBoundedBody(req.body, BODY_MAX_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json({ error: "request_too_large" }, 413);
      return json({ error: "invalid_request_body" }, 400);
    }
    const bodyHash = createHash("sha256").update(new Uint8Array(body)).digest("base64url");
    const fingerprint = hmacDigest(this.config.digestSecret, "request-fingerprint", `${req.method}\n${url.pathname}${url.search}\n${bodyHash}`);
    try {
      this.billing.reserveRequest({
        userId: principal.userId,
        apiKeyId: principal.keyId,
        requestId,
        clientIdempotencyKey: req.headers.get("Idempotency-Key"),
        requestFingerprint: fingerprint,
        pricingVersion: this.config.pricingVersion,
        routePath: url.pathname,
        modelAlias: modelAliasFromBody(body),
        units: this.config.requestCostUnits,
      });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "insufficient_credit") return json({ error: code }, 402);
      if (code === "request_replayed" || code === "idempotency_conflict") return json({ error: code }, 409);
      return json({ error: code === "invalid_idempotency_key" ? code : "admission_rejected" }, 400);
    }

    let upstreamAccepted = false;
    try {
      const upstream = await this.fetchImpl(target, {
        method: "POST",
        headers: forwardedHeaders(req, this.config.internalAdmissionToken, requestId),
        body,
        redirect: "manual",
        signal,
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        this.billing.releaseRequest(requestId, `upstream_status_${upstream.status}`, Date.now(), upstream.status);
        await upstream.body?.cancel().catch(() => undefined);
        return json({ error: "upstream_rejected", requestId }, upstream.status, upstreamErrorHeaders(upstream, requestId));
      }
      upstreamAccepted = true;
      const headers = responseHeaders(upstream, requestId);
      this.billing.markUpstreamAccepted(requestId, upstream.status);
      if (!upstream.body) {
        this.billing.settleRequest(requestId, "upstream_accepted_without_body");
        return new Response(null, { status: upstream.status, headers });
      }
      const bodyStream = wrapSettledBody(
        upstream.body,
        () => { this.billing.markFirstOutput(requestId); },
        () => { this.billing.settleRequest(requestId, "response_stream_completed"); },
        kind => {
          this.billing.settleRequest(requestId, kind === "cancel"
            ? "response_stream_cancelled_after_acceptance"
            : "response_stream_failed_after_acceptance");
        },
      );
      return new Response(bodyStream, { status: upstream.status, headers });
    } catch {
      try {
        if (upstreamAccepted) this.billing.settleRequest(requestId, "response_handoff_failed_after_acceptance");
        else this.billing.releaseRequest(requestId, "upstream_fetch_failed");
      } catch { /* preserve the redacted response if durable accounting is unavailable */ }
      return json({ error: "upstream_unavailable", requestId }, 502);
    }
  }
}
