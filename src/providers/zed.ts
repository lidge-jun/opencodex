import { constants, generateKeyPairSync, privateDecrypt, randomUUID } from "node:crypto";
import { redactSecretString } from "../lib/redact";

export const ZED_WEB_BASE_URL = "https://zed.dev";
export const ZED_CLOUD_BASE_URL = "https://cloud.zed.dev";
export const ZED_HEADERS = Object.freeze({
  expiredToken: "x-zed-expired-token",
  outdatedToken: "x-zed-outdated-token",
  clientSupportsStatus: "x-zed-client-supports-status-messages",
  clientSupportsStreamEnded: "x-zed-client-supports-stream-ended-request-completion-status",
  clientSupportsXai: "x-zed-client-supports-x-ai",
  systemId: "x-zed-system-id",
});

const PRIVATE_KEY_PREFIX = "zed-rsa-pkcs1:";
const LLM_TOKEN_TTL_MS = 50 * 60 * 1000;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const SMALL_RESPONSE_MAX_BYTES = 64 * 1024;
const MODEL_MAX_ROWS = 2_000;

export interface ZedCredentials {
  userId: string;
  accessToken: string;
  systemId?: string;
}

export interface ZedNativeAuthData {
  authUrl: string;
  privateKeyVerifier: string;
  nativeAppPort: number;
  systemId: string;
  publicKey: string;
}

export interface ZedCallbackPayload {
  userId: string;
  encryptedAccessToken: string;
}

export interface ZedModel {
  id: string;
  name: string;
  provider?: string;
  contextLength?: number;
  contextLengthInMaxMode?: number;
  maxOutputTokens?: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsDisablingThinking: boolean;
  supportsFastMode: boolean;
  supportedEffortLevels: string[];
  isDisabled: boolean;
}

export interface ZedModelCatalog {
  expiresAt: number;
  models: ZedModel[];
  rawById: Map<string, Record<string, unknown>>;
  defaultModel?: string;
  defaultFastModel?: string;
  recommendedModels: string[];
}

export type ZedFetch = typeof globalThis.fetch;

interface ZedRequestOptions {
  fetchFn?: ZedFetch;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

interface CachedLlmToken {
  token: string;
  expiresAt: number;
  organizationId: string;
}

const llmTokenCache = new Map<string, CachedLlmToken>();
const organizationCache = new Map<string, string>();
const modelCache = new Map<string, ZedModelCatalog>();
const modelInflight = new Map<string, Promise<ZedModelCatalog>>();

function base64Url(value: Uint8Array | string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  return String(value || fallback).replace(/\/+$/, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeModelId(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return String((value as { id: string }).id).trim();
  }
  return "";
}

function zedCacheKey(credentials: ZedCredentials): string {
  return `${credentials.userId}:${credentials.accessToken}`;
}

function zedUrl(path: string, baseUrl = ZED_CLOUD_BASE_URL): string {
  return `${normalizeBaseUrl(baseUrl, ZED_CLOUD_BASE_URL)}${path}`;
}

/** Build Zed's native-app URL and retain the private key only in an opaque verifier string. */
export function createZedNativeAuthData(nativeAppPort: number, systemId = randomUUID()): ZedNativeAuthData {
  if (!Number.isInteger(nativeAppPort) || nativeAppPort <= 0 || nativeAppPort > 65_535) {
    throw new Error("Zed native-app callback port is invalid");
  }
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
    publicKeyEncoding: { type: "pkcs1", format: "der" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const url = new URL(`${ZED_WEB_BASE_URL}/native_app_signin`);
  url.searchParams.set("native_app_port", String(nativeAppPort));
  url.searchParams.set("native_app_public_key", base64Url(publicKey));
  url.searchParams.set("system_id", systemId);
  return {
    authUrl: url.toString(),
    privateKeyVerifier: `${PRIVATE_KEY_PREFIX}${base64Url(privateKey)}`,
    nativeAppPort,
    systemId,
    publicKey: base64Url(publicKey),
  };
}

function decodePrivateKeyVerifier(verifier: string): string {
  if (!verifier.startsWith(PRIVATE_KEY_PREFIX)) {
    throw new Error("Missing Zed private-key verifier; restart the login flow");
  }
  return decodeBase64Url(verifier.slice(PRIVATE_KEY_PREFIX.length)).toString("utf8");
}

/** Parse a native-app callback URL, query string, or JSON payload without logging its token. */
export function parseZedCallbackPayload(input: string): ZedCallbackPayload {
  const raw = input.trim();
  if (!raw) throw new Error("Missing Zed callback URL");
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    data = parsed as Record<string, unknown>;
  } catch {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.replace(/^\?/, "");
      url = new URL(`http://127.0.0.1/?${query}`);
    }
    url.searchParams.forEach((value, key) => { data[key] = value; });
  }
  const userId = stringValue(data.user_id) ?? stringValue(data.userId);
  const encryptedAccessToken = stringValue(data.access_token)
    ?? stringValue(data.accessToken)
    ?? stringValue(data.token);
  if (!userId || !encryptedAccessToken) {
    throw new Error("Zed callback must include user_id and access_token");
  }
  return { userId, encryptedAccessToken };
}

/** Decrypt the callback token with OAEP-SHA256, falling back to PKCS#1 v1.5 for older Zed builds. */
export function decryptZedAccessToken(encryptedAccessToken: string, privateKeyVerifier: string): string {
  const encrypted = decodeBase64Url(encryptedAccessToken);
  const privateKey = decodePrivateKeyVerifier(privateKeyVerifier);
  let oaepError: unknown;
  try {
    const token = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      encrypted,
    ).toString("utf8");
    if (!token || token.includes("�")) throw new Error("decrypted token is invalid UTF-8");
    return token;
  } catch (error) {
    oaepError = error;
  }
  try {
    const token = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
      encrypted,
    ).toString("utf8");
    // PKCS#1 v1.5 unpadding is not integrity-checked. Replacement characters are a
    // concrete signal that a wrong key or malformed ciphertext produced garbage.
    if (!token || token.includes("�")) throw new Error("decrypted token is invalid UTF-8");
    return token;
  } catch {
    const reason = oaepError instanceof Error ? oaepError.message : "unsupported ciphertext";
    throw new Error(`Failed to decrypt Zed access token: ${reason}`);
  }
}

export function buildZedUserAuthHeader(credentials: ZedCredentials): string {
  if (!credentials.userId || !credentials.accessToken) throw new Error("Zed credential is incomplete");
  return `${credentials.userId} ${credentials.accessToken}`;
}

function systemHeaders(credentials: ZedCredentials): Record<string, string> {
  return credentials.systemId ? { [ZED_HEADERS.systemId]: credentials.systemId } : {};
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > SMALL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${label}: response exceeded the size limit`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > SMALL_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label}: response exceeded the size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text) as unknown; } catch { data = { raw: text }; }
  }
  if (response.ok) return data;
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const nested = record?.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : undefined;
  const message = stringValue(record?.message) ?? stringValue(nested?.message) ?? `HTTP ${response.status}`;
  const error = new Error(`${label}: ${redactSecretString(message)}`);
  Object.assign(error, { status: response.status });
  throw error;
}

export async function fetchZedAuthenticatedUser(
  credentials: ZedCredentials,
  options: ZedRequestOptions = {},
): Promise<Record<string, unknown>> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const response = await fetchFn(zedUrl("/client/users/me"), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: buildZedUserAuthHeader(credentials),
      ...systemHeaders(credentials),
    },
    signal: options.signal,
  });
  const value = await responseJson(response, "Zed account lookup");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Zed account lookup returned an invalid response");
  return value as Record<string, unknown>;
}

function normalizeOrganizationId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim()) return value[0].trim();
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") {
    return String((value as { id: string }).id).trim() || undefined;
  }
  return undefined;
}

export function resolveZedOrganizationId(user: Record<string, unknown>): string | undefined {
  const explicit = normalizeOrganizationId(user.default_organization_id)
    ?? normalizeOrganizationId(user.defaultOrganizationId)
    ?? normalizeOrganizationId(user.organization_id)
    ?? normalizeOrganizationId(user.organizationId)
    ?? normalizeOrganizationId(user.default_organization);
  if (explicit) return explicit;
  const organizations = Array.isArray(user.organizations) ? user.organizations : [];
  const personal = organizations.find(item => item && typeof item === "object" && (item as { is_personal?: unknown }).is_personal === true);
  const selected = personal ?? organizations[0];
  return selected && typeof selected === "object"
    ? normalizeOrganizationId((selected as { id?: unknown }).id)
    : undefined;
}

async function resolveOrganization(
  credentials: ZedCredentials,
  options: ZedRequestOptions,
): Promise<string> {
  const key = zedCacheKey(credentials);
  const cached = organizationCache.get(key);
  if (cached) return cached;
  const user = await fetchZedAuthenticatedUser(credentials, options);
  const organizationId = resolveZedOrganizationId(user);
  if (!organizationId) throw new Error("Zed account has no organization");
  organizationCache.set(key, organizationId);
  return organizationId;
}

export async function fetchZedLlmToken(
  credentials: ZedCredentials,
  options: ZedRequestOptions = {},
): Promise<string> {
  const key = zedCacheKey(credentials);
  const cached = llmTokenCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached.token;
  const organizationId = await resolveOrganization(credentials, options);
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const response = await fetchFn(zedUrl("/client/llm_tokens"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: buildZedUserAuthHeader(credentials),
      ...systemHeaders(credentials),
    },
    body: JSON.stringify({ organization_id: organizationId }),
    signal: options.signal,
  });
  const data = await responseJson(response, "Zed LLM token exchange");
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const token = stringValue(record?.token)
    ?? (record?.token && typeof record.token === "object" ? stringValue((record.token as { value?: unknown }).value) : undefined)
    ?? stringValue(record?.access_token)
    ?? stringValue(record?.llm_token)
    ?? stringValue(record?.llmToken);
  if (!token) throw new Error("Zed LLM token exchange returned no token");
  llmTokenCache.set(key, { token, organizationId, expiresAt: Date.now() + LLM_TOKEN_TTL_MS });
  return token;
}

export function shouldRefreshZedLlmToken(response: Response): boolean {
  return response.status === 401
    || response.headers.has(ZED_HEADERS.expiredToken)
    || response.headers.has(ZED_HEADERS.outdatedToken);
}

export async function zedLlmFetch(
  credentials: ZedCredentials,
  path: string,
  options: ZedRequestOptions & { fetchInit?: RequestInit; baseUrl?: string } = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const request = async (forceRefresh: boolean): Promise<Response> => {
    const token = await fetchZedLlmToken(credentials, { ...options, forceRefresh });
    const headers = new Headers(options.fetchInit?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetchFn(zedUrl(path, options.baseUrl), {
      ...options.fetchInit,
      headers,
      signal: options.signal,
    });
  };
  let response = await request(false);
  if (shouldRefreshZedLlmToken(response)) {
    response = await request(true);
  }
  return response;
}

function mapZedModel(raw: unknown): ZedModel | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const model = raw as Record<string, unknown>;
  const id = normalizeModelId(model.id);
  if (!id) return undefined;
  const numberField = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = model[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const listField = (...keys: string[]): string[] => {
    for (const key of keys) {
      if (!Array.isArray(model[key])) continue;
      return model[key].filter(value => typeof value === "string" && value.trim()).map(value => String(value));
    }
    return [];
  };
  const contextLength = numberField("max_token_count", "maxTokenCount");
  const contextLengthInMaxMode = numberField("max_token_count_in_max_mode", "maxTokenCountInMaxMode");
  const maxOutputTokens = numberField("max_output_tokens", "maxOutputTokens");
  return {
    id,
    name: stringValue(model.display_name) ?? stringValue(model.displayName) ?? id,
    ...(stringValue(model.provider) ? { provider: stringValue(model.provider) } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(contextLengthInMaxMode ? { contextLengthInMaxMode } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    supportsTools: model.supports_tools === true || model.supportsTools === true,
    supportsImages: model.supports_images === true || model.supportsImages === true,
    supportsThinking: model.supports_thinking === true || model.supportsThinking === true,
    supportsDisablingThinking: model.supports_disabling_thinking === true || model.supportsDisablingThinking === true,
    supportsFastMode: model.supports_fast_mode === true || model.supportsFastMode === true,
    supportedEffortLevels: listField("supported_effort_levels", "supportedEffortLevels"),
    isDisabled: model.is_disabled === true || model.isDisabled === true,
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    if (response.body) await response.body.cancel().catch(() => undefined);
    throw new Error("Zed model catalog exceeded the response size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Zed model catalog returned no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Zed model catalog exceeded the response size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Zed model catalog returned invalid JSON");
  }
}

/** Resolve the account-scoped live model roster; the list is display metadata, not a model allowlist. */
export async function resolveZedModels(
  credentials: ZedCredentials,
  options: ZedRequestOptions = {},
): Promise<ZedModelCatalog> {
  const key = zedCacheKey(credentials);
  const cached = modelCache.get(key);
  if (!options.forceRefresh && cached && cached.expiresAt > Date.now()) return cached;
  const existing = modelInflight.get(key);
  if (existing && !options.forceRefresh) return existing;
  const promise = (async (): Promise<ZedModelCatalog> => {
    const response = await zedLlmFetch(credentials, "/models", {
      ...options,
      fetchInit: {
        method: "GET",
        headers: {
          Accept: "application/json",
          [ZED_HEADERS.clientSupportsXai]: "true",
        },
      },
    });
    if (!response.ok) throw new Error(`Zed model catalog failed: HTTP ${response.status}`);
    const data = await readBoundedJson(response, MODEL_RESPONSE_MAX_BYTES);
    const record = data && typeof data === "object" && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const rawModels = Array.isArray(data)
      ? data
      : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(record?.data)
        ? record.data
        : Array.isArray(record?.available_models) ? record.available_models : undefined;
    if (!rawModels || rawModels.length > MODEL_MAX_ROWS) throw new Error("Zed model catalog returned too many models");
    const models = rawModels.map(mapZedModel).filter((model): model is ZedModel => !!model && !model.isDisabled);
    const rawById = new Map<string, Record<string, unknown>>();
    for (const raw of rawModels) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const id = normalizeModelId((raw as Record<string, unknown>).id);
      if (id) rawById.set(id, raw as Record<string, unknown>);
    }
    const catalog: ZedModelCatalog = {
      expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
      models,
      rawById,
      ...(normalizeModelId(record?.default_model ?? record?.defaultModel) ? { defaultModel: normalizeModelId(record?.default_model ?? record?.defaultModel) } : {}),
      ...(normalizeModelId(record?.default_fast_model ?? record?.defaultFastModel) ? { defaultFastModel: normalizeModelId(record?.default_fast_model ?? record?.defaultFastModel) } : {}),
      recommendedModels: (Array.isArray(record?.recommended_models) ? record.recommended_models : Array.isArray(record?.recommendedModels) ? record.recommendedModels : [])
        .map(normalizeModelId).filter(Boolean),
    };
    modelCache.set(key, catalog);
    return catalog;
  })();
  modelInflight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (modelInflight.get(key) === promise) modelInflight.delete(key);
  }
}

export function normalizeZedProvider(value: unknown, model: string): "anthropic" | "open_ai" | "google" | "x_ai" {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai" || raw === "open_ai") return "open_ai";
  if (raw === "google" || raw === "gemini") return "google";
  if (raw === "xai" || raw === "x_ai" || raw === "x-ai") return "x_ai";
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes("claude")) return "anthropic";
  if (lowerModel.includes("gemini")) return "google";
  if (lowerModel.includes("grok") || lowerModel.includes("xai")) return "x_ai";
  return "open_ai";
}

export function clearZedCaches(): void {
  llmTokenCache.clear();
  organizationCache.clear();
  modelCache.clear();
  modelInflight.clear();
}
