import { createHash } from "node:crypto";
import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { ProviderOutboundSendCancelledError, providerOutboundGet, providerOutboundPost } from "../lib/provider-outbound";
import { githubCopilotHttpError, resolveCopilotApiBaseUrl } from "../oauth/github-copilot";
import { resolveGithubCopilotTransport } from "./github-copilot-transport";
import { waitForProviderRequestSlot, releaseProviderRequestSlot } from "./request-pacing";

export interface CopilotModel {
  id: string;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  [key: string]: unknown;
}
const catalogs = new Map<string, { expires: number; models: CopilotModel[] }>();
const MAX_MODELS = 512;
const MAX_RESPONSE_BYTES = 1_048_576;
export class CopilotAutoHttpError extends Error {
  /** Preserve only the upstream status and bounded retry delay; never retain response bodies. */
  constructor(readonly status: number, readonly retryAfter?: string) {
    super(githubCopilotHttpError("Auto negotiation", status).message);
  }
}
/** Reject array/scalar payloads before interpreting negotiation objects. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
/** Accept a bounded, homogeneous list so malformed pools cannot grant routing eligibility. */
function strings(value: unknown): string[] {
  return Array.isArray(value) && value.length <= MAX_MODELS
    && value.every(/** Require every pool entry to be a bounded nonempty string before it can authorize model selection. */
      v => typeof v === "string" && v.length > 0 && v.length <= 256)
    ? value as string[] : [];
}
/** Isolate discovery caches by endpoint and credential without storing plaintext cache keys. */
function authority(provider: OcxProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([provider.baseUrl, provider.apiKey])).digest("hex");
}
/** Make one paced, origin-fenced negotiation send with bounded decoding and secret-safe errors. */
async function requestJson(provider: OcxProviderConfig, path: string, signal?: AbortSignal, body?: unknown,
  sessionToken?: string, beforeSend?: () => boolean, concurrency = true): Promise<Record<string, unknown>> {
  const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
  boundedSignal.throwIfAborted();
  const headers = new Headers(provider.headers);
  headers.set("Authorization", `Bearer ${provider.apiKey}`);
  headers.set("X-GitHub-Api-Version", "2026-08-01");
  headers.set("Content-Type", "application/json");
  headers.delete("Copilot-Session-Token");
  if (sessionToken) headers.set("Copilot-Session-Token", sessionToken);
  const url = `${provider.baseUrl}${path}`;
  // Queued-dispatch rebuilding can already own a provider concurrency lease; that
  // caller opts out of taking a second lease while retaining interval pacing.
  const slot = await waitForProviderRequestSlot("github-copilot", provider, "auto", boundedSignal, { concurrency });
  try {
    const init = { headers, signal: boundedSignal };
    const response = body === undefined
      ? await providerOutboundGet("github-copilot", provider, url, init, { beforeSend })
      : await providerOutboundPost("github-copilot", provider, url, { ...init, body: JSON.stringify(body) }, { beforeSend });
    // Status-only failures: session endpoints can echo secret material in their bodies.
    if (!response.ok) {
      void response.body?.cancel().catch(/** Ignore cleanup failures after discarding a refusal body that may contain reflected credentials. */
        () => undefined);
      const retry = response.headers.get("retry-after");
      throw new CopilotAutoHttpError(response.status, retry && /^\d{1,4}$/.test(retry)
        ? String(Math.max(1, Math.min(3600, Number(retry)))) : undefined);
    }
    const bounded = await readBoundedResponseBody(response, { maxBytes: MAX_RESPONSE_BYTES,
      signal: boundedSignal, totalTimeoutMs: 8_000, fatalUtf8: true });
    if (bounded.truncated) throw new Error("GitHub Copilot Auto negotiation returned an incomplete response");
    let value: unknown;
    try { value = JSON.parse(bounded.text); } catch { /* never include raw bodies */ }
    const payload = record(value);
    if (!payload) throw new Error("GitHub Copilot Auto negotiation returned invalid JSON");
    return payload;
  } catch (error) {
    if (error instanceof CopilotAutoHttpError || error instanceof ProviderOutboundSendCancelledError) throw error;
    // Transport/decoder exception messages may contain reflected header values.
    throw new Error(boundedSignal.aborted ? "GitHub Copilot Auto negotiation cancelled"
      : "GitHub Copilot Auto negotiation transport failed");
  } finally { releaseProviderRequestSlot(slot); }
}

/** Detect Auto-only permission only when every row explicitly denies named selection. */
export function copilotRequiresAuto(_provider: OcxProviderConfig, models: CopilotModel[]): boolean {
  return models.length > 0 && models.every(/** Missing or malformed metadata cannot establish an account-wide picker denial. */
    model => model.model_picker_enabled === false);
}
/** Retain legacy rows with unknown permissions; only an explicit denial removes a named picker row. */
export function copilotPickerModels(provider: OcxProviderConfig, models: CopilotModel[]): CopilotModel[] {
  if (copilotRequiresAuto(provider, models)) return [{ id: "auto" }];
  return models.filter(/** Preserve named selection unless the provider explicitly marks the row unavailable. */
    model => model.model_picker_enabled !== false);
}
/** Read the credential-bound catalog; callers may disable caching or reuse an existing lease. */
export async function fetchCopilotAutoModels(provider: OcxProviderConfig, signal?: AbortSignal,
  beforeSend?: () => boolean, cacheTtlMs = 60_000, concurrency = true): Promise<CopilotModel[]> {
  const key = authority(provider);
  const cached = catalogs.get(key);
  if (cacheTtlMs > 0 && cached && cached.expires > Date.now()) return cached.models;
  const payload = await requestJson(provider, "/models", signal, undefined, undefined, beforeSend, concurrency);
  if (!Array.isArray(payload.data) || payload.data.length > MAX_MODELS)
    throw new Error("GitHub Copilot model discovery returned an invalid catalog");
  const models = payload.data.flatMap(/** Discard malformed catalog rows while retaining metadata for bounded model identifiers. */
    value => {
    const row = record(value);
    if (!row || typeof row.id !== "string" || !row.id || row.id.length > 256) return [];
    return [{ ...row, id: row.id } as CopilotModel];
  });
  if (cacheTtlMs > 0) {
    if (!catalogs.has(key) && catalogs.size >= 32) catalogs.delete(catalogs.keys().next().value!);
    catalogs.set(key, { expires: Date.now() + Math.min(cacheTtlMs, 60_000), models });
  }
  return models;
}
/** Reset discovery state between isolated account/permission regression cases. */
export function clearCopilotAutoModelsForTests(): void { catalogs.clear(); }

/** Resolve before adapter construction: the server can choose either wire on every turn. */
export async function resolveCopilotAuto(provider: OcxProviderConfig, requestedModel: string,
  parsed: OcxParsedRequest, signal?: AbortSignal, beforeSend?: () => boolean, concurrency = true): Promise<{
    provider: OcxProviderConfig; modelId: string; auto: boolean; expiresAt?: number;
  }> {
  const transport = resolveGithubCopilotTransport(provider, provider.authMode === "oauth"
    ? resolveCopilotApiBaseUrl(provider.baseUrl) : undefined);
  // Never inherit a session token from a previous account or persist it in config.
  const cleanHeaders = new Headers(transport.headers);
  cleanHeaders.delete("Copilot-Session-Token");
  transport.headers = Object.fromEntries(cleanHeaders);
  let models: CopilotModel[];
  try { models = await fetchCopilotAutoModels(transport, signal, beforeSend, 60_000, concurrency); }
  catch (error) {
    if (signal?.aborted || error instanceof ProviderOutboundSendCancelledError) throw error;
    // Permission discovery is additive for legacy paid configurations. A temporary
    // discovery outage must not turn a previously usable named route into a refusal.
    return { provider: transport, modelId: requestedModel, auto: false };
  }
  if (!copilotRequiresAuto(provider, models))
    return { provider: transport, modelId: requestedModel, auto: false };
  const session = await requestJson(transport, "/models/session", signal,
    { auto_mode: { model_hints: ["auto"] } }, undefined, beforeSend, concurrency);
  const pool = strings(session.available_models);
  if (typeof session.session_token !== "string" || !session.session_token || session.session_token.length > 32_768 || !/^[\x21-\x7e]+$/.test(session.session_token) || !pool.length)
    throw new Error("GitHub Copilot Auto session omitted its routing credentials");
  if (session.expires_at !== undefined && (typeof session.expires_at !== "number" || !Number.isFinite(session.expires_at)))
    throw new Error("GitHub Copilot Auto session returned an invalid expiry");
  const expiresAt = typeof session.expires_at === "number" && Number.isFinite(session.expires_at)
    ? session.expires_at * 1000 : Date.now() + 60_000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 1000) throw new Error("GitHub Copilot Auto session is already expired");
  const lastUser = [...parsed.context.messages].reverse().find(/** Find the newest user turn as the intent-routing source instead of replaying earlier conversation text. */
    message => message.role === "user");
  const prompt = lastUser?.role === "user"
    ? typeof lastUser.content === "string" ? lastUser.content : lastUser.content.flatMap(/** Extract text parts for intent negotiation without forwarding image or other multimodal payloads. */
      part => part.type === "text" ? [part.text] : []).join("\n")
    : "";
  const intent = await requestJson(transport, "/models/session/intent", signal,
    { prompt: prompt.slice(0, 32_768), available_models: pool }, session.session_token, beforeSend, concurrency);
  const modelId = strings(intent.candidate_models).find(/** Choose the first server-ranked candidate that belongs to this credential-bound session pool. */
    candidate => pool.includes(candidate));
  if (!modelId) throw new Error("GitHub Copilot Auto intent returned no eligible model");
  const endpoints = strings(models.find(/** Read endpoint capabilities for the selected model before choosing its inference adapter. */
    model => model.id === modelId)?.supported_endpoints);
  const adapter = endpoints.includes("/responses") ? "openai-responses"
    : endpoints.includes("/chat/completions") ? "openai-chat" : undefined;
  if (!adapter) throw new Error("GitHub Copilot Auto selected a model with no supported inference endpoint");
  return { auto: true, modelId, expiresAt: Math.min(expiresAt, Date.now() + 60_000), provider: { ...transport, adapter,
    ...(adapter === "openai-responses" ? { responsesPath: "/responses" } : { chatCompletionsPath: "/chat/completions" }),
    headers: { ...transport.headers, "X-GitHub-Api-Version": "2026-08-01", "Copilot-Session-Token": session.session_token } } };
}
