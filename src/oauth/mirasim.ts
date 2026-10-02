import { randomBytes } from "node:crypto";
import { createMirasimDeviceIdentity } from "../adapters/mirasim/crypto";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import type { OcxProviderConfig } from "../types";
import type { MirasimOAuthMetadata, OAuthController, OAuthCredentials } from "./types";

export const MIRASIM_RELAY_URL = "https://relay.mirasim.ai";
export const MIRASIM_ADMIN_URL = "https://auth.mirasim.ai";
export const MIRASIM_CLIENT_VERSION = "0.0.336";

const MAX_AUTH_BODY = 64 * 1024;
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
const AUTH_REQUEST_TIMEOUT_MS = 20_000;
const PROFILE_REQUEST_TIMEOUT_MS = 5_000;
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
  /** Optional account email. Browser and default CLI login both use Mirasim email verification. */
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
    chooseProvider: "Enter the email address for your Mirasim account. A short-lived verification code will be sent to that address.",
    continueWith: () => "Send verification code",
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
    chooseProviderInstruction: "Complete Mirasim sign-in in the browser using the emailed verification code.",
    waitingForBrowser: "Waiting for Mirasim browser authentication...",
    continueInstruction: provider => `Continue with ${provider}.`,
  },
  "zh-TW": {
    htmlLang: "zh-TW",
    signInTitle: "登入 Mirasim",
    chooseProvider: "輸入 Mirasim 帳號的電子郵件地址。我們會寄送一組短效驗證碼到該地址。",
    continueWith: () => "傳送驗證碼",
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
    chooseProviderInstruction: "請在瀏覽器中使用電子郵件驗證碼完成 Mirasim 登入。",
    waitingForBrowser: "正在等待 Mirasim 瀏覽器驗證…",
    continueInstruction: provider => `使用 ${provider} 繼續。`,
  },
  "zh-CN": {
    htmlLang: "zh-CN",
    signInTitle: "登录 Mirasim",
    chooseProvider: "输入 Mirasim 账户的电子邮件地址。我们会向该地址发送一组短效验证码。",
    continueWith: () => "发送验证码",
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
    chooseProviderInstruction: "请在浏览器中使用电子邮件验证码完成 Mirasim 登录。",
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

export function mirasimCredentialNeedsMigration(credential: OAuthCredentials): boolean {
  return credential.mirasim === undefined;
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

interface CallbackTokens {
  accessToken: string;
  refreshToken: string;
}

const MIRASIM_BROWSER_START_PATH = "/oauth/mirasim/start";
const MIRASIM_BROWSER_FORM_MAX_BYTES = 4 * 1024;
const MIRASIM_BROWSER_MAX_VERIFY_ATTEMPTS = 5;

interface MirasimBrowserSession {
  state: string;
  locale: MirasimBrowserLocale;
  adminUrl: string;
  baseUrl: string;
  expiresAt: number;
  email?: string;
  codeSent: boolean;
  verifyAttempts: number;
  verifyInFlight: number;
  completed: boolean;
  promise: Promise<CallbackTokens>;
  resolve: (tokens: CallbackTokens) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

const mirasimBrowserSessions = new Map<string, MirasimBrowserSession>();

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
    adminUrl,
    baseUrl,
    expiresAt: Date.now() + LOGIN_TIMEOUT_MS,
    codeSent: false,
    verifyAttempts: 0,
    verifyInFlight: 0,
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

function reserveMirasimBrowserVerifyAttempt(session: MirasimBrowserSession): boolean {
  if (mirasimBrowserSessions.get(session.state) !== session || session.completed) return false;
  if (session.verifyAttempts >= MIRASIM_BROWSER_MAX_VERIFY_ATTEMPTS) return false;
  session.verifyAttempts += 1;
  session.verifyInFlight += 1;
  return true;
}

function finishMirasimBrowserVerifyAttempt(session: MirasimBrowserSession): boolean {
  session.verifyInFlight = Math.max(0, session.verifyInFlight - 1);
  return mirasimBrowserSessions.get(session.state) === session && !session.completed;
}

function oauthBrowserHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
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

function mirasimBrowserFormAction(session: MirasimBrowserSession): string {
  const action = new URL(MIRASIM_BROWSER_START_PATH, `${session.baseUrl}/`);
  action.searchParams.set("state", session.state);
  action.searchParams.set("lang", session.locale);
  return action.pathname + action.search;
}

function renderMirasimEmailEntry(session: MirasimBrowserSession, message?: string, status = 200): Response {
  const copy = MIRASIM_BROWSER_COPY[session.locale];
  const notice = message ? `<p role="alert">${escapeHtml(message)}</p>` : "";
  return browserHtml(
    session.locale,
    copy.signInTitle,
    `<img src="/provider-icons/mirasim.svg" alt="Mirasim" width="72" height="64" style="display:block;object-fit:contain;margin:0 0 1.25rem;border-radius:.6rem"><p>${escapeHtml(copy.chooseProvider)}</p>${notice}<form method="post" action="${escapeHtml(mirasimBrowserFormAction(session))}"><input type="hidden" name="action" value="send"><label style="display:block;margin:.75rem 0 .4rem">Email</label><input name="email" type="email" autocomplete="email" required maxlength="320" style="box-sizing:border-box;width:100%;padding:.65rem .75rem;border:1px solid #999;border-radius:.55rem"><button type="submit" style="margin-top:1rem;padding:.65rem 1rem">${escapeHtml(copy.continueWith("email"))}</button></form>`,
    status,
  );
}

function renderMirasimCodeEntry(session: MirasimBrowserSession, message?: string, status = 200): Response {
  const copy = MIRASIM_BROWSER_COPY[session.locale];
  const notice = message ? `<p role="alert">${escapeHtml(message)}</p>` : "";
  const instruction = session.locale === "zh-TW"
    ? "驗證碼已寄出。請輸入郵件中的驗證碼。"
    : session.locale === "zh-CN"
      ? "验证码已发送。请输入邮件中的验证码。"
      : "The verification code was sent. Enter the code from your email.";
  const label = session.locale === "zh-TW" ? "驗證碼" : session.locale === "zh-CN" ? "验证码" : "Verification code";
  const submit = session.locale === "zh-TW" ? "完成登入" : session.locale === "zh-CN" ? "完成登录" : "Complete sign-in";
  return browserHtml(
    session.locale,
    copy.signInTitle,
    `<p>${escapeHtml(instruction)}</p>${notice}<form method="post" action="${escapeHtml(mirasimBrowserFormAction(session))}"><input type="hidden" name="action" value="verify"><label style="display:block;margin:.75rem 0 .4rem">${escapeHtml(label)}</label><input name="code" inputmode="numeric" autocomplete="one-time-code" required maxlength="32" style="box-sizing:border-box;width:100%;padding:.65rem .75rem;border:1px solid #999;border-radius:.55rem"><button type="submit" style="margin-top:1rem;padding:.65rem 1rem">${escapeHtml(submit)}</button></form>`,
    status,
  );
}

function settleMirasimBrowserSession(session: MirasimBrowserSession, tokens: CallbackTokens): void {
  if (session.completed) return;
  session.completed = true;
  clearTimeout(session.timeout);
  session.abort?.();
  session.abort = undefined;
  session.resolve(tokens);
  mirasimBrowserSessions.delete(session.state);
}

function rejectMirasimBrowserSession(session: MirasimBrowserSession, error: Error): void {
  if (mirasimBrowserSessions.get(session.state) !== session) return;
  mirasimBrowserSessions.delete(session.state);
  clearTimeout(session.timeout);
  session.abort?.();
  session.abort = undefined;
  session.reject(error);
}

async function readBoundedBrowserForm(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("Mirasim browser form used an unsupported content type");
  }
  const reader = req.body?.getReader();
  if (!reader) return new URLSearchParams();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MIRASIM_BROWSER_FORM_MAX_BYTES) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new Error("Mirasim browser form exceeded the accepted size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

/**
 * Public browser resource for the management-owned Mirasim login flow.
 *
 * Renewable credentials never cross the browser URL. The browser POSTs only an email address and
 * a short-lived verification code to this management origin; OpenCodex exchanges those values
 * server-to-server with Mirasim and stores the returned access/refresh material directly.
 */
export async function handleMirasimBrowserOAuthRequest(
  req: Request,
  url = new URL(req.url),
): Promise<Response | null> {
  if (url.pathname !== MIRASIM_BROWSER_START_PATH) return null;
  const requestLocale = normalizeMirasimBrowserLocale(
    url.searchParams.get("lang") ?? req.headers.get("accept-language"),
  );
  const returnedState = url.searchParams.get("state")?.trim() ?? "";
  const session = returnedState ? currentMirasimBrowserSession(returnedState) : undefined;
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

  if (req.method === "GET") {
    return session.email ? renderMirasimCodeEntry(session) : renderMirasimEmailEntry(session);
  }
  if (req.method !== "POST") {
    return new Response(copy.methodNotAllowed, {
      status: 405,
      headers: oauthBrowserHeaders("text/plain; charset=utf-8"),
    });
  }

  let form: URLSearchParams;
  try {
    form = await readBoundedBrowserForm(req);
  } catch {
    return renderMirasimEmailEntry(session, copy.failedBody, 400);
  }
  const action = form.get("action")?.trim();
  if (action === "send") {
    let email: string;
    try {
      email = normalizeLoginEmail(form.get("email") ?? "");
    } catch {
      return renderMirasimEmailEntry(session, copy.failedBody, 400);
    }
    if (session.codeSent) {
      return renderMirasimCodeEntry(session, copy.callbackAlreadyUsed, 409);
    }
    // Spend the one send before the network call so concurrent POSTs cannot turn a leaked
    // login capability into a mail relay. A failed send requires starting a fresh login.
    session.codeSent = true;
    session.email = email;
    try {
      const response = await postMirasimAuthJson(session.adminUrl, "/auth/code", { email }, req.signal);
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return renderMirasimCodeEntry(session);
    } catch {
      rejectMirasimBrowserSession(session, new Error("Mirasim browser sign-in code request failed"));
      return browserHtml(locale, copy.unavailableTitle, `<p>${escapeHtml(copy.unavailableBody)}</p>`, 502);
    }
  }

  if (action === "verify") {
    const email = session.email;
    if (!email) return renderMirasimEmailEntry(session, copy.incompleteBody, 400);
    let code: string;
    try {
      code = normalizeLoginCode(form.get("code") ?? "");
    } catch {
      return renderMirasimCodeEntry(session, copy.failedBody, 400);
    }
    if (!reserveMirasimBrowserVerifyAttempt(session)) {
      const active = mirasimBrowserSessions.get(session.state) === session && !session.completed;
      return active
        ? renderMirasimCodeEntry(session, copy.failedBody, 400)
        : browserHtml(locale, copy.expiredTitle, `<p>${escapeHtml(copy.expiredBody)}</p>`, 400);
    }
    try {
      const response = await postMirasimAuthJson(
        session.adminUrl,
        "/auth/verify",
        { email, code },
        req.signal,
      );
      code = "";
      const payload = await boundedJson(response);
      let accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
      let refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
      if (!accessToken.trim() || !refreshToken.trim()) {
        accessToken = "";
        refreshToken = "";
        throw new Error("Mirasim browser sign-in returned no renewable credential");
      }
      const tokens = {
        accessToken: normalizeCredentialSecret("access token", accessToken),
        refreshToken: normalizeCredentialSecret("refresh token", refreshToken),
      };
      accessToken = "";
      refreshToken = "";
      finishMirasimBrowserVerifyAttempt(session);
      settleMirasimBrowserSession(session, tokens);
      return browserHtml(locale, copy.completeTitle, `<p>${escapeHtml(copy.completeBody)}</p>`);
    } catch (error) {
      code = "";
      const active = finishMirasimBrowserVerifyAttempt(session);
      if (error instanceof Error && error.message.includes("no renewable credential")) {
        if (active) rejectMirasimBrowserSession(session, error);
        return browserHtml(locale, copy.failedTitle, `<p>${escapeHtml(copy.failedBody)}</p>`, 502);
      }
      if (
        active
        && session.verifyAttempts >= MIRASIM_BROWSER_MAX_VERIFY_ATTEMPTS
        && session.verifyInFlight === 0
      ) {
        rejectMirasimBrowserSession(session, new Error("Mirasim browser sign-in verification attempts exhausted"));
        return browserHtml(locale, copy.failedTitle, `<p>${escapeHtml(copy.failedBody)}</p>`, 400);
      }
      if (!active) {
        return browserHtml(locale, copy.expiredTitle, `<p>${escapeHtml(copy.expiredBody)}</p>`, 400);
      }
      return renderMirasimCodeEntry(session, copy.failedBody, 400);
    }
  }

  return renderMirasimEmailEntry(session, copy.failedBody, 400);
}

export interface MirasimProviderLoginOptions {
  mirasimBrowserBaseUrl?: string;
  mirasimBrowserLocale?: string;
  mirasimEmail?: string;
  mirasimCode?: string;
}

export function loginMirasimForProvider(
  ctrl: OAuthController,
  opts?: MirasimProviderLoginOptions,
): Promise<OAuthCredentials> {
  return loginMirasim(ctrl, {
    ...(opts?.mirasimBrowserBaseUrl ? { browserBaseUrl: opts.mirasimBrowserBaseUrl } : {}),
    ...(opts?.mirasimBrowserLocale ? { browserLocale: opts.mirasimBrowserLocale } : {}),
    ...(opts?.mirasimEmail ? { email: opts.mirasimEmail } : {}),
    ...(opts?.mirasimCode ? { code: opts.mirasimCode } : {}),
  });
}

export function mirasimOAuthProviderConfig(
  base: OcxProviderConfig,
  relayUrl?: string,
): OcxProviderConfig {
  return {
    ...base,
    ...(relayUrl ? { baseUrl: relayUrl } : {}),
    upstreamHttpVersion: "http1.1",
  };
}

export function mirasimOAuthProviderDefinition(
  resolveBaseConfig: () => OcxProviderConfig,
  defaultModel: string,
) {
  return {
    login: loginMirasimForProvider,
    refresh: refreshMirasimToken,
    providerConfig: mirasimOAuthProviderConfig(resolveBaseConfig()),
    resolveProviderConfig: () => mirasimOAuthProviderConfig(resolveBaseConfig(), mirasimRelayUrl()),
    defaultModel,
    defaultRefreshPolicy: "lazy-only" as const,
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

    const tokens = await pending.tokens;
    return enrichMirasimCredentialFromProfile(
      credentialsFromTokens(tokens.accessToken, tokens.refreshToken, mirasim),
      ctrl.signal,
    );
  }

  if (!ctrl.onManualCodeInput) {
    throw new Error("Mirasim sign-in requires an interactive account email");
  }
  const email = await ctrl.onManualCodeInput(undefined, "Enter the Mirasim account email: ");
  return loginMirasimWithEmail(ctrl, mirasim, { email });
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
