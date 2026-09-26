import { randomBytes } from "node:crypto";
import { createMirasimDeviceIdentity } from "../adapters/mirasim/crypto";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { MirasimOAuthMetadata, OAuthController, OAuthCredentials } from "./types";

export const MIRASIM_RELAY_URL = "https://relay.mirasim.ai";
export const MIRASIM_ADMIN_URL = "https://auth.mirasim.ai";
export const MIRASIM_CLIENT_VERSION = "0.0.336";

const MAX_AUTH_BODY = 64 * 1024;
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 20_000;
const PROFILE_REQUEST_TIMEOUT_MS = 5_000;
const PROVIDER_SLUG = /^[a-z][a-z0-9_-]{0,63}$/;
const EMAIL_ADDRESS = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const OAUTH_ERROR_CODE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

export class MirasimTokenRefreshError extends Error {
  readonly httpStatus: number;
  readonly oauthError?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(httpStatus: number, oauthError?: string, retryAfterMs?: number) {
    super(`Mirasim token refresh failed with HTTP ${httpStatus}`);
    this.name = "MirasimTokenRefreshError";
    this.httpStatus = httpStatus;
    this.oauthError = oauthError;
    this.retryAfterMs = retryAfterMs;
    this.retryable = httpStatus === 429 || httpStatus >= 500;
  }
}

export interface MirasimLoginOptions {
  /** Management-owned browser origin used by the dashboard OAuth flow. */
  browserBaseUrl?: string;
  /** Dashboard locale used by the management-owned OAuth pages. */
  browserLocale?: string;
  /** CLI-only alternative for accounts that are not bound to GitHub/Google OAuth. */
  email?: string;
  /** Optional code from a previous /auth/code request. */
  code?: string;
}

type MirasimBrowserLocale = "en" | "zh-TW" | "zh-CN";

type MirasimBrowserCopy = {
  htmlLang: string;
  signInTitle: string;
  chooseProvider: string;
  continueWith: (provider: string) => string;
  expiredTitle: string;
  expiredBody: string;
  failedTitle: string;
  mismatchBody: string;
  failedBody: string;
  unavailableTitle: string;
  unavailableBody: string;
  unsupportedTitle: string;
  unsupportedBody: string;
  completeTitle: string;
  completeBody: string;
  incompleteTitle: string;
  incompleteBody: string;
  methodNotAllowed: string;
  callbackAlreadyUsed: string;
  notFound: string;
  chooseProviderInstruction: string;
  waitingForBrowser: string;
  continueInstruction: (provider: string) => string;
};

const MIRASIM_BROWSER_COPY: Record<MirasimBrowserLocale, MirasimBrowserCopy> = {
  en: {
    htmlLang: "en",
    signInTitle: "Sign in to Mirasim",
    chooseProvider: "Choose the account provider you want to use.",
    continueWith: provider => `Continue with ${provider}`,
    expiredTitle: "Mirasim sign-in expired",
    expiredBody: "This sign-in link is invalid or has expired. Return to OpenCodex and start again.",
    failedTitle: "Mirasim sign-in failed",
    mismatchBody: "The sign-in response did not match this OpenCodex login attempt.",
    failedBody: "Mirasim did not complete the sign-in. Return to OpenCodex and try again.",
    unavailableTitle: "Mirasim sign-in unavailable",
    unavailableBody: "OpenCodex could not load the currently enabled Mirasim sign-in providers.",
    unsupportedTitle: "Unsupported Mirasim sign-in provider",
    unsupportedBody: "Choose one of the providers offered by Mirasim.",
    completeTitle: "Mirasim sign-in complete",
    completeBody: "Return to OpenCodex. You may close this tab.",
    incompleteTitle: "Mirasim sign-in incomplete",
    incompleteBody: "No renewable credential was received.",
    methodNotAllowed: "Method Not Allowed",
    callbackAlreadyUsed: "Mirasim login callback already used.",
    notFound: "Not Found",
    chooseProviderInstruction: "Choose GitHub or Google on the Mirasim sign-in page.",
    waitingForBrowser: "Waiting for Mirasim browser authentication...",
    continueInstruction: provider => `Continue with ${provider}.`,
  },
  "zh-TW": {
    htmlLang: "zh-TW",
    signInTitle: "登入 Mirasim",
    chooseProvider: "選擇要用於登入的帳號供應商。",
    continueWith: provider => `使用 ${provider} 繼續`,
    expiredTitle: "Mirasim 登入連結已過期",
    expiredBody: "此登入連結無效或已過期。請返回 OpenCodex 重新開始。",
    failedTitle: "Mirasim 登入失敗",
    mismatchBody: "登入回應與這次 OpenCodex 登入要求不相符。",
    failedBody: "Mirasim 未完成登入。請返回 OpenCodex 後重試。",
    unavailableTitle: "Mirasim 登入暫時無法使用",
    unavailableBody: "OpenCodex 無法載入 Mirasim 目前啟用的登入供應商。",
    unsupportedTitle: "不支援的 Mirasim 登入供應商",
    unsupportedBody: "請選擇 Mirasim 提供的登入方式。",
    completeTitle: "Mirasim 登入完成",
    completeBody: "請返回 OpenCodex。現在可以關閉此分頁。",
    incompleteTitle: "Mirasim 登入未完成",
    incompleteBody: "未收到可續期的憑證。",
    methodNotAllowed: "不允許此方法",
    callbackAlreadyUsed: "Mirasim 登入回呼已使用。",
    notFound: "找不到頁面",
    chooseProviderInstruction: "請在 Mirasim 登入頁面選擇 GitHub 或 Google。",
    waitingForBrowser: "正在等待 Mirasim 瀏覽器驗證…",
    continueInstruction: provider => `使用 ${provider} 繼續。`,
  },
  "zh-CN": {
    htmlLang: "zh-CN",
    signInTitle: "登录 Mirasim",
    chooseProvider: "选择用于登录的账户提供商。",
    continueWith: provider => `使用 ${provider} 继续`,
    expiredTitle: "Mirasim 登录链接已过期",
    expiredBody: "此登录链接无效或已过期。请返回 OpenCodex 重新开始。",
    failedTitle: "Mirasim 登录失败",
    mismatchBody: "登录响应与本次 OpenCodex 登录请求不匹配。",
    failedBody: "Mirasim 未完成登录。请返回 OpenCodex 后重试。",
    unavailableTitle: "Mirasim 登录暂不可用",
    unavailableBody: "OpenCodex 无法加载 Mirasim 当前启用的登录提供商。",
    unsupportedTitle: "不支持的 Mirasim 登录提供商",
    unsupportedBody: "请选择 Mirasim 提供的登录方式。",
    completeTitle: "Mirasim 登录完成",
    completeBody: "请返回 OpenCodex。现在可以关闭此标签页。",
    incompleteTitle: "Mirasim 登录未完成",
    incompleteBody: "未收到可续期凭证。",
    methodNotAllowed: "不允许此方法",
    callbackAlreadyUsed: "Mirasim 登录回调已使用。",
    notFound: "找不到页面",
    chooseProviderInstruction: "请在 Mirasim 登录页面选择 GitHub 或 Google。",
    waitingForBrowser: "正在等待 Mirasim 浏览器验证…",
    continueInstruction: provider => `使用 ${provider} 继续。`,
  },
};

function normalizeMirasimBrowserLocale(value: string | null | undefined): MirasimBrowserLocale {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "en";
  if (
    normalized.startsWith("zh-tw")
    || normalized.startsWith("zh-hk")
    || normalized.startsWith("zh-mo")
    || normalized.startsWith("zh-hant")
  ) {
    return "zh-TW";
  }
  if (normalized === "zh" || normalized.startsWith("zh-")) return "zh-CN";
  return "en";
}

interface MirasimJwtClaims {
  exp?: unknown;
  email?: unknown;
  account_id?: unknown;
  accountId?: unknown;
  user_id?: unknown;
  userId?: unknown;
  sub?: unknown;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validatedServiceUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid Mirasim ${label} URL`);
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error(`Invalid Mirasim ${label} URL`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error(`Mirasim ${label} URL must use HTTPS unless it is loopback`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function mirasimRelayUrl(): string {
  return validatedServiceUrl(process.env.MIRASIM_RELAY_URL ?? MIRASIM_RELAY_URL, "relay");
}

export function mirasimAdminUrl(): string {
  return validatedServiceUrl(
    process.env.MIRASIM_ADMIN_URL ?? MIRASIM_ADMIN_URL,
    "authentication service",
  );
}

export function mirasimClientVersion(): string {
  const value = (process.env.MIRASIM_CLIENT_VERSION ?? MIRASIM_CLIENT_VERSION).trim();
  if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid Mirasim client version");
  }
  return value;
}

function defaultMirasimMetadata(existingPrivateKey?: string): MirasimOAuthMetadata {
  const identity = createMirasimDeviceIdentity(existingPrivateKey);
  return {
    devicePrivateKey: identity.privateKeyPem,
    relayUrl: mirasimRelayUrl(),
    adminUrl: mirasimAdminUrl(),
    clientVersion: mirasimClientVersion(),
  };
}

function decodeJwtClaims(token: string): MirasimJwtClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as MirasimJwtClaims
      : undefined;
  } catch {
    return undefined;
  }
}

function claimString(claims: MirasimJwtClaims | undefined, ...names: Array<keyof MirasimJwtClaims>): string | undefined {
  for (const name of names) {
    const value = claims?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function accessTokenExpiry(accessToken: string, expiresInSeconds?: number): number {
  const now = Date.now();
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return now + Math.floor(expiresInSeconds * 1000);
  }
  const exp = decodeJwtClaims(accessToken)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) return Math.floor(exp * 1000);
  return now + 30 * 60 * 1000;
}

function normalizeCredentialSecret(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_AUTH_BODY || /[\r\n\0]/.test(normalized)) {
    throw new Error(`Mirasim ${label} is invalid`);
  }
  return normalized;
}

function normalizeLoginEmail(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 254 || !EMAIL_ADDRESS.test(normalized)) {
    throw new Error("Invalid Mirasim account email address");
  }
  return normalized;
}

function normalizeLoginCode(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 64 || /[\r\n\0]/.test(normalized)) {
    throw new Error("Invalid Mirasim sign-in code");
  }
  return normalized;
}

function credentialsFromTokens(
  accessToken: string,
  refreshToken: string,
  mirasim: MirasimOAuthMetadata,
  expiresInSeconds?: number,
): OAuthCredentials {
  const access = normalizeCredentialSecret("access token", accessToken);
  const refresh = normalizeCredentialSecret("refresh token", refreshToken);
  const claims = decodeJwtClaims(access);
  const accountId = claimString(claims, "account_id", "accountId", "user_id", "userId", "sub");
  const email = claimString(claims, "email");
  return {
    access,
    refresh,
    expires: accessTokenExpiry(access, expiresInSeconds),
    source: "oauth",
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    mirasim,
  };
}

function requestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

function profileSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROFILE_REQUEST_TIMEOUT_MS);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUTH_BODY) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new Error("Mirasim authentication response is too large");
  }
  const bounded = await readBoundedResponseBytes(response, { maxBytes: MAX_AUTH_BODY });
  if (bounded.oversized) throw new Error("Mirasim authentication response is too large");
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Mirasim authentication response is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Mirasim authentication response is invalid");
  }
  return parsed as Record<string, unknown>;
}

function safeOAuthCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return OAUTH_ERROR_CODE.test(normalized) ? normalized : undefined;
}

function safeOAuthErrorCode(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  for (const field of ["code", "type"]) {
    const code = safeOAuthCode(payload[field]);
    if (code) return code;
  }
  const nested = payload.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    for (const field of ["code", "type"]) {
      const code = safeOAuthCode(record[field]);
      if (code) return code;
    }
  }
  return safeOAuthCode(payload.error);
}

function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

function safeProfileEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  if (!email || email.length > 320 || /[\r\n\0]/.test(email)) return undefined;
  return email;
}

async function enrichMirasimCredentialFromProfile(
  credential: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const metadata = credential.mirasim;
  if (!metadata) return credential;
  try {
    const response = await fetch(`${metadata.adminUrl}/auth/me`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.access}`,
      },
      redirect: "error",
      signal: profileSignal(signal),
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return credential;
    }
    const profile = await boundedJson(response);
    const email = safeProfileEmail(profile.email);
    return email ? { ...credential, email } : credential;
  } catch {
    // The official client treats /auth/me as best-effort during login. The renewable credential
    // remains usable even when the profile service is temporarily unavailable.
    return credential;
  }
}

async function postMirasimAuthJson(
  adminUrl: string,
  path: "/auth/code" | "/auth/verify",
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${adminUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    // These requests carry account/login secrets. Do not reflect an upstream body into
    // CLI/dashboard logs; the status is enough to diagnose the public failure.
    try { await response.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`Mirasim email sign-in failed with HTTP ${response.status}`);
  }
  return response;
}

async function loginMirasimWithEmail(
  ctrl: OAuthController,
  mirasim: MirasimOAuthMetadata,
  options: Required<Pick<MirasimLoginOptions, "email">> & Pick<MirasimLoginOptions, "code">,
): Promise<OAuthCredentials> {
  const email = normalizeLoginEmail(options.email);
  let code = options.code?.trim();
  if (!code) {
    const request = await postMirasimAuthJson(
      mirasim.adminUrl,
      "/auth/code",
      { email },
      ctrl.signal,
    );
    // A development auth service may echo the code. Deliberately discard every success body.
    try { await request.body?.cancel(); } catch { /* already closed */ }
    ctrl.onProgress?.(`Mirasim sent a sign-in code to ${email}.`);
    if (!ctrl.onManualCodeInput) {
      throw new Error("Mirasim email sign-in requires an interactive verification code");
    }
    code = await ctrl.onManualCodeInput(undefined, "Enter the Mirasim sign-in code: ");
  }
  code = normalizeLoginCode(code);

  const response = await postMirasimAuthJson(
    mirasim.adminUrl,
    "/auth/verify",
    { email, code },
    ctrl.signal,
  );
  const payload = await boundedJson(response);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  if (!accessToken.trim()) throw new Error("Mirasim email sign-in returned no access token");
  if (!refreshToken.trim()) throw new Error("Mirasim email sign-in returned no renewable credential");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  const credential = credentialsFromTokens(accessToken, refreshToken, mirasim, expiresIn);
  return enrichMirasimCredentialFromProfile(
    credential.email ? credential : { ...credential, email },
    ctrl.signal,
  );
}

async function discoverLoginProviders(adminUrl: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${adminUrl}/auth/oauth/providers`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) throw new Error(`Mirasim sign-in provider discovery failed with HTTP ${response.status}`);
  const payload = await boundedJson(response);
  const rows = Array.isArray(payload.providers) ? payload.providers : [];
  const providers: string[] = [];
  const seen = new Set<string>();
  for (const value of rows) {
    if (typeof value !== "string") continue;
    const id = value.trim().toLowerCase();
    if (!PROVIDER_SLUG.test(id) || seen.has(id)) continue;
    seen.add(id);
    providers.push(id);
  }
  if (providers.length === 0) throw new Error("Mirasim has no enabled sign-in provider");
  return providers;
}

function chooseLoginProvider(providers: string[]): string {
  const configured = process.env.MIRASIM_OAUTH_PROVIDER?.trim().toLowerCase();
  if (configured) {
    if (!PROVIDER_SLUG.test(configured) || !providers.includes(configured)) {
      throw new Error(`Mirasim sign-in provider "${configured}" is not currently offered`);
    }
    return configured;
  }
  return providers.includes("github") ? "github" : providers[0]!;
}

interface CallbackTokens {
  accessToken: string;
  refreshToken: string;
}

function parseCallbackTokens(url: URL, expectedState: string): CallbackTokens {
  const returnedState = url.searchParams.get("state")?.trim();
  // Some Mirasim deployments omit state. The unguessable callback path is then the channel
  // binding; a present state must still match exactly.
  if (returnedState && returnedState !== expectedState) throw new Error("Mirasim OAuth state mismatch");
  const error = url.searchParams.get("error")?.trim();
  if (error) throw new Error("Mirasim OAuth login was cancelled or rejected");
  const accessToken = url.searchParams.get("access_token")?.trim() || url.searchParams.get("token")?.trim() || "";
  const refreshToken = url.searchParams.get("refresh_token")?.trim() || "";
  return {
    accessToken: normalizeCredentialSecret("access token", accessToken),
    refreshToken: normalizeCredentialSecret("refresh token", refreshToken),
  };
}

function parseManualCallback(input: string, expectedState: string): CallbackTokens {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Mirasim OAuth callback is empty");
  try {
    return parseCallbackTokens(new URL(trimmed), expectedState);
  } catch (error) {
    if (!trimmed.includes("=")) throw error;
    return parseCallbackTokens(new URL(`http://localhost/?${trimmed.replace(/^\?/, "")}`), expectedState);
  }
}

const MIRASIM_BROWSER_START_PATH = "/oauth/mirasim/start";
const MIRASIM_BROWSER_CALLBACK_PREFIX = "/oauth/mirasim/callback/";
const MIRASIM_BROWSER_COMPLETED_TTL_MS = 30_000;

interface MirasimBrowserSession {
  state: string;
  locale: MirasimBrowserLocale;
  callbackToken: string;
  callbackPath: string;
  adminUrl: string;
  baseUrl: string;
  expiresAt: number;
  pendingTokens?: CallbackTokens;
  completed: boolean;
  promise: Promise<CallbackTokens>;
  resolve: (tokens: CallbackTokens) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

const mirasimBrowserSessions = new Map<string, MirasimBrowserSession>();
const mirasimBrowserCallbackStates = new Map<string, string>();

function validatedBrowserBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("Invalid Mirasim browser callback origin");
  }
  if (
    parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error("Invalid Mirasim browser callback origin");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error("Mirasim browser callback origin must use HTTPS unless it is loopback");
  }
  return parsed.origin;
}

function deleteMirasimBrowserSession(state: string): void {
  const session = mirasimBrowserSessions.get(state);
  if (!session) return;
  clearTimeout(session.timeout);
  mirasimBrowserCallbackStates.delete(session.callbackToken);
  mirasimBrowserSessions.delete(state);
}

function createMirasimBrowserSession(
  ctrl: OAuthController,
  state: string,
  adminUrl: string,
  rawBaseUrl: string,
  rawLocale?: string,
): { startUrl: string; tokens: Promise<CallbackTokens>; discard: () => void } {
  const baseUrl = validatedBrowserBaseUrl(rawBaseUrl);
  const locale = normalizeMirasimBrowserLocale(rawLocale);
  let resolveTokens!: (tokens: CallbackTokens) => void;
  let rejectTokens!: (error: Error) => void;
  const promise = new Promise<CallbackTokens>((resolve, reject) => {
    resolveTokens = resolve;
    rejectTokens = reject;
  });
  const callbackToken = randomBytes(18).toString("base64url");
  const callbackPath = `${MIRASIM_BROWSER_CALLBACK_PREFIX}${callbackToken}`;
  const timeout = setTimeout(() => {
    const current = mirasimBrowserSessions.get(state);
    if (!current) return;
    deleteMirasimBrowserSession(state);
    current.reject(new Error("Mirasim OAuth login timed out"));
  }, LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  const session: MirasimBrowserSession = {
    state,
    locale,
    callbackToken,
    callbackPath,
    adminUrl,
    baseUrl,
    expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    completed: false,
    promise,
    resolve: resolveTokens,
    reject: rejectTokens,
    timeout,
  };
  const onAbort = () => {
    const current = mirasimBrowserSessions.get(state);
    if (!current) return;
    deleteMirasimBrowserSession(state);
    current.reject(new Error("Mirasim OAuth login cancelled"));
  };
  ctrl.signal?.addEventListener("abort", onAbort, { once: true });
  session.abort = () => ctrl.signal?.removeEventListener("abort", onAbort);
  mirasimBrowserSessions.set(state, session);
  mirasimBrowserCallbackStates.set(callbackToken, state);

  const startUrl = new URL(MIRASIM_BROWSER_START_PATH, `${baseUrl}/`);
  startUrl.searchParams.set("state", state);
  startUrl.searchParams.set("lang", locale);
  return {
    startUrl: startUrl.toString(),
    tokens: promise,
    discard: () => {
      session.abort?.();
      session.abort = undefined;
      deleteMirasimBrowserSession(state);
    },
  };
}

function currentMirasimBrowserSession(state: string): MirasimBrowserSession | undefined {
  const session = mirasimBrowserSessions.get(state);
  if (!session) return undefined;
  if (Date.now() < session.expiresAt) return session;
  deleteMirasimBrowserSession(state);
  session.reject(new Error("Mirasim OAuth login timed out"));
  return undefined;
}

function callbackTokenFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(MIRASIM_BROWSER_CALLBACK_PREFIX)) return undefined;
  const token = pathname.slice(MIRASIM_BROWSER_CALLBACK_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token) || token.includes("/")) return undefined;
  return token;
}

function currentMirasimBrowserSessionByCallback(pathname: string): MirasimBrowserSession | undefined {
  const callbackToken = callbackTokenFromPath(pathname);
  if (!callbackToken) return undefined;
  const state = mirasimBrowserCallbackStates.get(callbackToken);
  if (!state) return undefined;
  const session = currentMirasimBrowserSession(state);
  return session?.callbackToken === callbackToken ? session : undefined;
}

function oauthBrowserHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  });
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function browserHtml(
  locale: MirasimBrowserLocale,
  title: string,
  body: string,
  status = 200,
): Response {
  const copy = MIRASIM_BROWSER_COPY[locale];
  return new Response(
    `<!doctype html><html lang="${escapeHtml(copy.htmlLang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1.25rem;line-height:1.55"><h2>${escapeHtml(title)}</h2>${body}</body></html>`,
    { status, headers: oauthBrowserHeaders("text/html; charset=utf-8") },
  );
}

function renderMirasimProviderSelection(
  state: string,
  providers: string[],
  locale: MirasimBrowserLocale,
): Response {
  const copy = MIRASIM_BROWSER_COPY[locale];
  const links = providers.map(provider => {
    const href = new URL(MIRASIM_BROWSER_START_PATH, "http://localhost");
    href.searchParams.set("state", state);
    href.searchParams.set("provider", provider);
    href.searchParams.set("lang", locale);
    const label = provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider;
    return `<li style="margin:.75rem 0"><a href="${escapeHtml(href.pathname + href.search)}" style="display:inline-block;padding:.65rem 1rem;border:1px solid #999;border-radius:.6rem;text-decoration:none;color:inherit">${escapeHtml(copy.continueWith(label))}</a></li>`;
  }).join("");
  return browserHtml(
    locale,
    copy.signInTitle,
    `<img src="/provider-icons/mirasim.svg" alt="Mirasim" width="72" height="64" style="display:block;object-fit:contain;margin:0 0 1.25rem;border-radius:.6rem"><p>${escapeHtml(copy.chooseProvider)}</p><ul style="list-style:none;padding:0">${links}</ul>`,
  );
}

function settleMirasimBrowserSession(session: MirasimBrowserSession, tokens: CallbackTokens): void {
  if (session.completed) return;
  session.completed = true;
  session.pendingTokens = undefined;
  clearTimeout(session.timeout);
  session.abort?.();
  session.abort = undefined;
  session.resolve(tokens);
  const cleanup = setTimeout(() => {
    if (mirasimBrowserSessions.get(session.state) === session) {
      mirasimBrowserCallbackStates.delete(session.callbackToken);
      mirasimBrowserSessions.delete(session.state);
    }
  }, MIRASIM_BROWSER_COMPLETED_TTL_MS);
  cleanup.unref?.();
}

function rejectMirasimBrowserSession(session: MirasimBrowserSession, error: Error): void {
  if (mirasimBrowserSessions.get(session.state) !== session) return;
  mirasimBrowserCallbackStates.delete(session.callbackToken);
  mirasimBrowserSessions.delete(session.state);
  clearTimeout(session.timeout);
  session.abort?.();
  session.abort = undefined;
  session.pendingTokens = undefined;
  session.reject(error);
}

/**
 * Public browser resources for the management-owned Mirasim OAuth flow.
 *
 * These routes deliberately sit outside /api management auth. The 256-bit pending state is the
 * capability, matching the upstream CPA design: the start route only chooses an offered provider,
 * while the callback accepts bounded renewable credentials only for that one live state.
 */
export async function handleMirasimBrowserOAuthRequest(
  req: Request,
  url = new URL(req.url),
): Promise<Response | null> {
  const isStart = url.pathname === MIRASIM_BROWSER_START_PATH;
  const isCallbackNamespace = url.pathname.startsWith(MIRASIM_BROWSER_CALLBACK_PREFIX);
  if (!isStart && !isCallbackNamespace) {
    return null;
  }
  const requestLocale = normalizeMirasimBrowserLocale(
    url.searchParams.get("lang") ?? req.headers.get("accept-language"),
  );
  if (req.method !== "GET") {
    return new Response(MIRASIM_BROWSER_COPY[requestLocale].methodNotAllowed, {
      status: 405,
      headers: oauthBrowserHeaders("text/plain; charset=utf-8"),
    });
  }

  const returnedState = url.searchParams.get("state")?.trim() ?? "";
  const session = isStart
    ? (returnedState ? currentMirasimBrowserSession(returnedState) : undefined)
    : currentMirasimBrowserSessionByCallback(url.pathname);
  if (!session) {
    const copy = MIRASIM_BROWSER_COPY[requestLocale];
    return browserHtml(
      requestLocale,
      copy.expiredTitle,
      `<p>${escapeHtml(copy.expiredBody)}</p>`,
      400,
    );
  }
  const locale = session.locale;
  const copy = MIRASIM_BROWSER_COPY[locale];
  const state = session.state;
  if (returnedState && returnedState !== state) {
    rejectMirasimBrowserSession(session, new Error("Mirasim OAuth state mismatch"));
    return browserHtml(
      locale,
      copy.failedTitle,
      `<p>${escapeHtml(copy.mismatchBody)}</p>`,
      400,
    );
  }

  if (isStart) {
    let providers: string[];
    try {
      providers = await discoverLoginProviders(session.adminUrl, req.signal);
    } catch {
      return browserHtml(
        locale,
        copy.unavailableTitle,
        `<p>${escapeHtml(copy.unavailableBody)}</p>`,
        503,
      );
    }
    const provider = url.searchParams.get("provider")?.trim().toLowerCase() ?? "";
    if (!provider) return renderMirasimProviderSelection(state, providers, locale);
    if (!PROVIDER_SLUG.test(provider) || !providers.includes(provider)) {
      return browserHtml(
        locale,
        copy.unsupportedTitle,
        `<p>${escapeHtml(copy.unsupportedBody)}</p>`,
        400,
      );
    }

    const callbackUrl = new URL(session.callbackPath, `${session.baseUrl}/`);
    const authUrl = new URL(`${session.adminUrl}/auth/oauth/${encodeURIComponent(provider)}/login`);
    authUrl.searchParams.set("redirect_uri", callbackUrl.toString());
    authUrl.searchParams.set("state", state);
    const headers = oauthBrowserHeaders();
    headers.set("Location", authUrl.toString());
    return new Response(null, { status: 302, headers });
  }

  if (url.searchParams.get("result") === "complete") {
    if (session.completed) {
      return browserHtml(
        locale,
        copy.completeTitle,
        `<p>${escapeHtml(copy.completeBody)}</p>`,
      );
    }
    const tokens = session.pendingTokens;
    if (!tokens) {
      return browserHtml(
        locale,
        copy.incompleteTitle,
        `<p>${escapeHtml(copy.incompleteBody)}</p>`,
        400,
      );
    }
    settleMirasimBrowserSession(session, tokens);
    return browserHtml(
      locale,
      copy.completeTitle,
      `<p>${escapeHtml(copy.completeBody)}</p>`,
    );
  }

  try {
    const tokens = parseCallbackTokens(url, state);
    session.pendingTokens = tokens;
    const clean = new URL(session.callbackPath, `${session.baseUrl}/`);
    clean.searchParams.set("state", state);
    clean.searchParams.set("result", "complete");
    const headers = oauthBrowserHeaders();
    headers.set("Location", clean.toString());
    return new Response(null, { status: 303, headers });
  } catch (error) {
    rejectMirasimBrowserSession(
      session,
      error instanceof Error ? error : new Error("Mirasim OAuth callback failed"),
    );
    return browserHtml(
      locale,
      copy.failedTitle,
      `<p>${escapeHtml(copy.failedBody)}</p>`,
      400,
    );
  }
}

async function waitForCallback(
  ctrl: OAuthController,
  expectedState: string,
  callbackPath: string,
): Promise<{ callbackUrl: string; tokens: Promise<CallbackTokens>; stop: () => void }> {
  let resolveTokens!: (tokens: CallbackTokens) => void;
  let rejectTokens!: (error: Error) => void;
  const tokens = new Promise<CallbackTokens>((resolve, reject) => {
    resolveTokens = resolve;
    rejectTokens = reject;
  });

  let consumed = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    reusePort: false,
    fetch(request) {
      const url = new URL(request.url);
      const locale = normalizeMirasimBrowserLocale(request.headers.get("accept-language"));
      const copy = MIRASIM_BROWSER_COPY[locale];
      if (url.pathname !== callbackPath) return new Response(copy.notFound, { status: 404 });
      if (consumed) return new Response(copy.callbackAlreadyUsed, { status: 409 });
      consumed = true;
      try {
        resolveTokens(parseCallbackTokens(url, expectedState));
        return new Response(
          `<!doctype html><html lang="${escapeHtml(copy.htmlLang)}"><body style="font-family:system-ui;padding:3rem"><h2>${escapeHtml(copy.completeTitle)}</h2><p>${escapeHtml(copy.completeBody)}</p></body></html>`,
          { headers: { "Content-Type": "text/html; charset=utf-8", "Connection": "close" } },
        );
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Mirasim OAuth callback failed");
        rejectTokens(failure);
        return new Response(copy.failedBody, {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" },
        });
      }
    },
  });

  const timeout = setTimeout(() => rejectTokens(new Error("Mirasim OAuth login timed out")), LOGIN_TIMEOUT_MS);
  timeout.unref?.();
  const abort = () => rejectTokens(new Error("Mirasim OAuth login cancelled"));
  ctrl.signal?.addEventListener("abort", abort, { once: true });

  const stop = () => {
    clearTimeout(timeout);
    ctrl.signal?.removeEventListener("abort", abort);
    server.stop(true);
  };
  return {
    callbackUrl: `http://127.0.0.1:${server.port}${callbackPath}`,
    tokens: tokens.finally(stop),
    stop,
  };
}

export async function loginMirasim(
  ctrl: OAuthController,
  options: MirasimLoginOptions = {},
): Promise<OAuthCredentials> {
  const mirasim = defaultMirasimMetadata();
  const browserLocale = normalizeMirasimBrowserLocale(options.browserLocale);
  const browserCopy = MIRASIM_BROWSER_COPY[browserLocale];
  if (options.email) {
    return loginMirasimWithEmail(ctrl, mirasim, {
      email: options.email,
      ...(options.code ? { code: options.code } : {}),
    });
  }
  if (options.code) throw new Error("Mirasim --code requires --email");
  const state = randomBytes(32).toString("base64url");
  if (options.browserBaseUrl) {
    const pending = createMirasimBrowserSession(
      ctrl,
      state,
      mirasim.adminUrl,
      options.browserBaseUrl,
      browserLocale,
    );
    ctrl.onAuth?.({
      url: pending.startUrl,
      instructions: browserCopy.chooseProviderInstruction,
    });
    ctrl.onProgress?.(browserCopy.waitingForBrowser);

    const browserResult = pending.tokens.then(tokens => ({ source: "browser" as const, tokens }));
    const result = ctrl.onManualCodeInput
      ? await Promise.race([
          browserResult,
          ctrl.onManualCodeInput(state).then(input => ({
            source: "manual" as const,
            tokens: parseManualCallback(input, state),
          })),
        ])
      : await browserResult;
    if (result.source === "manual") pending.discard();
    return enrichMirasimCredentialFromProfile(
      credentialsFromTokens(result.tokens.accessToken, result.tokens.refreshToken, mirasim),
      ctrl.signal,
    );
  }

  const providers = await discoverLoginProviders(mirasim.adminUrl, ctrl.signal);
  const provider = chooseLoginProvider(providers);
  const callbackPath = `/mirasim/oauth/${randomBytes(24).toString("base64url")}`;
  const pending = await waitForCallback(ctrl, state, callbackPath);

  const authUrl = new URL(`${mirasim.adminUrl}/auth/oauth/${encodeURIComponent(provider)}/login`);
  authUrl.searchParams.set("redirect_uri", pending.callbackUrl);
  authUrl.searchParams.set("state", state);
  ctrl.onAuth?.({
    url: authUrl.toString(),
    instructions: browserCopy.continueInstruction(
      provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider,
    ),
  });
  ctrl.onProgress?.(browserCopy.waitingForBrowser);

  try {
    const callbackPromise = pending.tokens;
    const tokens = ctrl.onManualCodeInput
      ? await Promise.race([
          callbackPromise,
          ctrl.onManualCodeInput(state).then(input => parseManualCallback(input, state)),
        ])
      : await callbackPromise;
    return enrichMirasimCredentialFromProfile(
      credentialsFromTokens(tokens.accessToken, tokens.refreshToken, mirasim),
      ctrl.signal,
    );
  } finally {
    pending.stop();
  }
}

export async function refreshMirasimToken(
  refreshToken: string,
  signal?: AbortSignal,
  credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  const priorMetadata = credential?.mirasim;
  const mirasim = priorMetadata
    ? {
        ...priorMetadata,
        relayUrl: validatedServiceUrl(priorMetadata.relayUrl, "relay"),
        adminUrl: validatedServiceUrl(priorMetadata.adminUrl, "authentication service"),
        clientVersion: mirasimClientVersion(),
      }
    : defaultMirasimMetadata();

  const response = await fetch(`${mirasim.adminUrl}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: normalizeCredentialSecret("refresh token", refreshToken) }),
    redirect: "error",
    signal: requestSignal(signal),
  });
  if (!response.ok) {
    // The request body contains a long-lived secret. Read only a bounded, structured error code
    // for terminal/transient classification; never reflect the provider payload in user output.
    let errorPayload: Record<string, unknown> | undefined;
    try {
      errorPayload = await boundedJson(response);
    } catch {
      try { await response.body?.cancel(); } catch { /* already closed */ }
    }
    throw new MirasimTokenRefreshError(
      response.status,
      safeOAuthErrorCode(errorPayload),
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  const payload = await boundedJson(response);
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const rotatedRefresh = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
    ? payload.refresh_token
    : refreshToken;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : undefined;
  return credentialsFromTokens(accessToken, rotatedRefresh, mirasim, expiresIn);
}
