import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import type { OcxProviderConfig, OcxParsedRequest } from "../types";
import { createOpenAIChatAdapter } from "./openai-chat";
import type { ProviderAdapter, AdapterRequest } from "./base";

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

// In-process JWT cache -- survives across requests, reset on restart.
let cachedJwt: string | null = null;
let jwtExpiresAt = 0;
// Single-flight guard: concurrent first requests share one bootstrap.
let inFlightJwt: Promise<string> | null = null;

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
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

async function fetchJwt(signal?: AbortSignal): Promise<string> {
  // Bounded bootstrap: request-abort propagates, and a stalled bootstrap can never
  // hang past BOOTSTRAP_TIMEOUT_MS.
  const timeout = AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": randomUserAgent(),
    },
    body: JSON.stringify({ client: getMimoClientId() }),
    signal: combined,
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* already consumed */ }
    throw new Error(`MiMo bootstrap failed: ${response.status}`);
  }
  const data = await response.json() as { jwt?: string };
  if (!data.jwt) throw new Error("MiMo bootstrap returned no JWT");
  return data.jwt;
}

export async function getMimoJwt(signal?: AbortSignal): Promise<string> {
  if (cachedJwt && Date.now() < jwtExpiresAt - JWT_EXPIRY_BUFFER_MS) {
    return cachedJwt;
  }
  // Single-flight: concurrent callers await the same bootstrap instead of issuing
  // parallel bootstraps.
  if (!inFlightJwt) {
    inFlightJwt = (async () => {
      try {
        const jwt = await fetchJwt(signal);
        cachedJwt = jwt;
        jwtExpiresAt = parseJwtExp(jwt);
        return jwt;
      } finally {
        inFlightJwt = null;
      }
    })();
  }
  return inFlightJwt;
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
  const base = createOpenAIChatAdapter(provider);
  // Per-adapter session-affinity id (random, per process instance).
  const sessionId = `ses_${Math.random().toString(36).slice(2, 26)}`;

  return {
    ...base,
    name: "mimo-free",

    async buildRequest(parsed: OcxParsedRequest): Promise<AdapterRequest> {
      const jwt = await getMimoJwt();

      // Let the base adapter build the wire body (handles reasoning, tools, etc.)
      // but override the URL and headers after.
      const baseReq = base.buildRequest(parsed) as AdapterRequest;
      const baseBody = JSON.parse(baseReq.body as string) as unknown;
      // Xiaomi free chat only accepts reasoning_effort in {low, medium, high}.
      // Codex Desktop often sends max/xhigh/ultra — clamp so free turns don't 400.
      const clampReasoningEffort = (body: unknown): unknown => {
        if (!body || typeof body !== "object" || Array.isArray(body)) return body;
        const rec = body as Record<string, unknown>;
        const effort = rec.reasoning_effort;
        if (typeof effort !== "string") return body;
        const allowed = new Set(["low", "medium", "high"]);
        if (allowed.has(effort)) return body;
        const mapped = effort === "minimal" || effort === "none" ? "low" : "high";
        return { ...rec, reasoning_effort: mapped };
      };
      const markedBody = clampReasoningEffort(injectMimoSystemMarker(baseBody));

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
      };
    },

    async fetchResponse(request: AdapterRequest, ctx): Promise<Response> {
      const doFetch = (headers: Record<string, string>) => fetch(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: ctx?.abortSignal,
      });

      let headers = request.headers as Record<string, string>;
      let response = await doFetch(headers);

      // Retry predicate: 401 (expired/invalid JWT) retries ONCE with a fresh token.
      // 403 is NOT retried — Xiaomi uses it for anti-abuse "Illegal access" and there is
      // no documented token-expiry signature that would mark a 403 as retryable.
      if (response.status === 401) {
        try { await response.body?.cancel(); } catch { /* already consumed */ }
        resetMimoJwtCache();
        const freshJwt = await getMimoJwt(ctx?.abortSignal);
        headers = {
          ...headers,
          "Authorization": `Bearer ${freshJwt}`,
        };
        response = await doFetch(headers);
      }

      // Pre-stream 5xx blips from the free tier — retry a couple times (body is replayable).
      for (let attempt = 0; attempt < 2 && (response.status === 500 || response.status === 502 || response.status === 503); attempt++) {
        try { await response.body?.cancel(); } catch { /* already consumed */ }
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        response = await doFetch(headers);
      }

      // 441 / high-frequency abuse: rotate anonymous client id + JWT once and retry.
      if (response.status === 400 || response.status === 403 || response.status === 441) {
        let payloadText = "";
        try { payloadText = await response.clone().text(); } catch { /* ignore */ }
        const blocked = response.status === 441
          || /高频|违规|441|Illegal access|rate/i.test(payloadText);
        if (blocked) {
          try { await response.body?.cancel(); } catch { /* already consumed */ }
          resetMimoJwtCache();
          resetMimoClientIdCache();
          try {
            const { unlinkSync, existsSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { getConfigDir } = await import("../config");
            const idFile = join(getConfigDir(), "mimo-client-id");
            if (existsSync(idFile)) unlinkSync(idFile);
          } catch { /* best-effort file rotate */ }
          const freshJwt = await getMimoJwt(ctx?.abortSignal);
          headers = { ...headers, "Authorization": `Bearer ${freshJwt}` };
          response = await doFetch(headers);
        }
      }

      return response;
    },
  };
}
