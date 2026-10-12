import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { OcxProviderConfig, OcxParsedRequest } from "../types";
import { createOpenAIChatAdapter } from "./openai-chat";
import type { ProviderAdapter, AdapterRequest, IncomingMeta } from "./base";
import { createAdapterPhysicalSend } from "./physical-send";
import { SendBudgetExhaustedError } from "../lib/upstream-retry";

const BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
export const MIMO_CHAT_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";

/**
 * Anti-abuse gate: the free chat endpoint returns 403 "Illegal access" unless
 * a system message contains this exact string as a substring.
 */
export const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

// Chrome-like User-Agent required by the upstream anti-abuse gate.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const JWT_FALLBACK_TTL_MS = 3_000_000; // 50 min
const JWT_EXPIRY_BUFFER_MS = 300_000;  // 5 min early refresh
const BOOTSTRAP_TIMEOUT_MS = 15_000;
const MIMO_BOOTSTRAP_MAX_BYTES = 128 * 1024;
const MIMO_JWT_MAX_BYTES = 64 * 1024;

// In-process JWT cache -- survives across requests, reset on restart.
let cachedJwt: string | null = null;
let jwtExpiresAt = 0;
// Single-flight guard: concurrent first requests share one bootstrap.
let inFlightJwt: Promise<string> | null = null;

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

function isCanonicalMimoFreeEndpoint(baseUrl: string): boolean {
  try {
    const actual = new URL(baseUrl.trim());
    const expected = new URL(MIMO_CHAT_URL);
    actual.pathname = actual.pathname.replace(/\/+$/, "") || "/";
    expected.pathname = expected.pathname.replace(/\/+$/, "") || "/";
    return actual.toString().replace(/\/$/, "") === expected.toString().replace(/\/$/, "");
  } catch {
    return false;
  }
}

/**
 * Anonymous per-install client id for the bootstrap `client` field. A random UUID
 * persisted under the config dir (OPENCODEX_HOME-aware) — deliberately NOT derived
 * from machine attributes (hostname/username/CPU), which would be a stable
 * pseudonymous device fingerprint. Delete the file to rotate the id.
 */
let cachedClientId: string | null = null;
export function getMimoClientId(): string {
  if (cachedClientId) return cachedClientId;
  const dir = getConfigDir();
  const file = join(dir, "mimo-client-id");
  try {
    if (existsSync(file)) {
      const stored = readFileSync(file, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(stored)) {
        cachedClientId = stored;
        return stored;
      }
    }
  } catch { /* fall through to regenerate */ }
  const fresh = randomUUID();
  try {
    recordOwnedConfigPath(dir, file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${fresh}\n`, "utf8");
  } catch { /* persist best-effort; still usable for this process */ }
  cachedClientId = fresh;
  return fresh;
}

/** Test hook: clear the in-process client-id cache (file state is the test's concern). */
export function resetMimoClientIdCache(): void {
  cachedClientId = null;
}

function parseJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64").toString()) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch { /* ignore */ }
  return Date.now() + JWT_FALLBACK_TTL_MS;
}

export function resetMimoJwtCache(): void {
  cachedJwt = null;
  jwtExpiresAt = 0;
  inFlightJwt = null;
}

async function fetchJwt(): Promise<string> {
  // Bounded bootstrap: a stalled bootstrap can never hang past BOOTSTRAP_TIMEOUT_MS. It carries
  // no caller signal because concurrent requests share it; each caller aborts its own wait.
  const timeout = AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS);
  const response = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": randomUserAgent(),
    },
    body: JSON.stringify({ client: getMimoClientId() }),
    signal: timeout,
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* already consumed */ }
    throw new Error(`MiMo bootstrap failed: ${response.status}`);
  }
  const announced = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(announced) && announced > MIMO_BOOTSTRAP_MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("MiMo bootstrap response too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MIMO_BOOTSTRAP_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("MiMo bootstrap response too large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as { jwt?: string };
  if (!data.jwt) throw new Error("MiMo bootstrap returned no JWT");
  if (new TextEncoder().encode(data.jwt).byteLength > MIMO_JWT_MAX_BYTES) {
    throw new Error("MiMo bootstrap response too large");
  }
  return data.jwt;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** Wait for the shared bootstrap, or stop waiting when this caller aborts; the bootstrap keeps running. */
function awaitForCaller(shared: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      jwt => { signal.removeEventListener("abort", onAbort); resolve(jwt); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export async function getMimoJwt(signal?: AbortSignal): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }
  if (signal?.aborted) throw abortReason(signal);
  // Single-flight: concurrent callers await the same bootstrap instead of issuing
  // parallel bootstraps. One caller aborting must not fail the others, so the shared
  // bootstrap is bound only to its timeout and each caller races it against its own signal.
  if (!inFlightJwt) {
    const shared = fetchJwt().then(jwt => {
      cachedJwt = jwt;
      jwtExpiresAt = parseJwtExp(jwt);
      return jwt;
    });
    inFlightJwt = shared;
    // Registered before any waiter, so the slot is cleared first; it also handles a failure that
    // arrives after every waiter has left. A reset during the flight owns the slot and is kept.
    const release = () => { if (inFlightJwt === shared) inFlightJwt = null; };
    shared.then(release, release);
  }
  return awaitForCaller(inFlightJwt, signal);
}

/**
 * Idempotently prepend the MiMo anti-abuse system marker if it is not already present.
 * The marker must appear in a system message; we prepend one if the request has none with it.
 */
export function injectMimoSystemMarker(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const parsed = body as Record<string, unknown>;
  const messages = parsed["messages"];
  if (!Array.isArray(messages)) return body;
  const hasMarker = messages.some(
    (m): m is { role: string; content: string } =>
      m !== null &&
      typeof m === "object" &&
      (m as Record<string, unknown>)["role"] === "system" &&
      typeof (m as Record<string, unknown>)["content"] === "string" &&
      ((m as Record<string, unknown>)["content"] as string).includes(MIMO_SYSTEM_MARKER),
  );
  if (hasMarker) return body;
  return { ...parsed, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...messages] };
}

/**
 * Creates the MiMo Free adapter. Wraps openai-chat's request builder to inject:
 *   1. JWT from the bootstrap endpoint (cached, auto-refreshed).
 *   2. Anti-abuse system marker in the request body.
 *   3. Required headers (User-Agent, X-Mimo-Source, x-session-affinity).
 * On 401/403, flushes the JWT cache and retries once via fetchResponse.
 */
export function createMimoFreeAdapter(provider: OcxProviderConfig): ProviderAdapter {
  if (!isCanonicalMimoFreeEndpoint(provider.baseUrl)) {
    throw new Error(
      "The mimo-free adapter only supports the canonical Xiaomi MiMo Free endpoint. Use openai-chat for a custom endpoint.",
    );
  }
  const base = createOpenAIChatAdapter(provider);
  // Per-adapter session-affinity id (random, per process instance).
  const sessionId = `ses_${Math.random().toString(36).slice(2, 26)}`;

  return {
    ...base,
    name: "mimo-free",

    async buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): Promise<AdapterRequest> {
      const jwt = await getMimoJwt(incoming?.abortSignal);

      // Let the base adapter build the wire body (handles reasoning, tools, etc.)
      // but override the URL and headers after.
      const baseReq = await base.buildRequest(parsed, incoming);
      const baseBody = JSON.parse(baseReq.body as string) as unknown;
      const markedBody = injectMimoSystemMarker(baseBody);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${jwt}`,
        "X-Mimo-Source": "mimocode-cli-free",
        "User-Agent": randomUserAgent(),
        "x-session-affinity": sessionId,
        "Accept": parsed.stream ? "text/event-stream" : "application/json",
      };

      return {
        url: MIMO_CHAT_URL,
        method: "POST",
        headers,
        body: JSON.stringify(markedBody),
        ...(baseReq.reasoningLog ? { reasoningLog: baseReq.reasoningLog } : {}),
      };
    },

    async fetchResponse(request: AdapterRequest, ctx): Promise<Response> {
      const send = createAdapterPhysicalSend(ctx);
      const response = await send({ url: request.url, dispatch: executor => executor(request.url, {
        method: request.method,
        redirect: "manual",
        headers: request.headers as Record<string, string>,
        body: request.body,
        signal: ctx?.abortSignal,
      }) });

      // Retry predicate: 401 (expired/invalid JWT) retries ONCE with a fresh token.
      // 403 is NOT retried — Xiaomi uses it for anti-abuse "Illegal access" and there is
      // no documented token-expiry signature that would mark a 403 as retryable.
      if (response.status === 401) {
        let retryHeaders = request.headers;
        try {
          return await send({ url: request.url, sendClass: "auth-recovery", recovery: "oauth-401",
            beforeDispatch: async () => {
              // Drain the first response body and refresh the JWT only after admission: a
              // refused replay still returns THIS response to the caller, body intact.
              // Draining comes first within the block because getMimoJwt issues its own
              // network call and may throw, and the 401 body would then never be released.
              try { void response.body?.cancel().catch(() => {}); } catch { /* already consumed */ }
              resetMimoJwtCache();
              const freshJwt = await getMimoJwt(ctx?.abortSignal);
              retryHeaders = {
                ...(request.headers as Record<string, string>),
                "Authorization": `Bearer ${freshJwt}`,
              };
            },
            dispatch: executor => executor(request.url, {
              method: request.method,
              redirect: "manual",
              headers: retryHeaders,
              body: request.body,
              signal: ctx?.abortSignal,
            }) });
        } catch (error) {
          if (error instanceof SendBudgetExhaustedError) return response;
          throw error;
        }
      }

      return response;
    },
  };
}
