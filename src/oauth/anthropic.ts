/** Anthropic OAuth flow (Claude Pro/Max). Ported from jawcode oauth/anthropic.ts. */
import { OAuthCallbackFlow } from "./callback-server";
import { bindAnthropicIdentity, resolveAnthropicAccountIdentity } from "./anthropic-identity";
import { generatePKCE } from "./pkce";
import type { LocalTokenImportMode, OAuthController, OAuthCredentials } from "./types";
import { outboundProxyConfigured, startupOutboundProxyConfigured } from "../lib/proxy-env";

const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

// ── OAuth-request requirements applied by the anthropic adapter when authMode==="oauth" ──
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";
export const CLAUDE_CODE_SYSTEM_INSTRUCTION = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_TOOL_PREFIX = "custom_";
const ANTHROPIC_BUILTIN_TOOLS = new Set(["web_search", "code_execution", "text_editor", "computer"]);

/** OAuth tokens reject arbitrary tool names; prefix custom tools (Anthropic builtins are exempt). */
export function applyClaudeToolPrefix(name: string): string {
  if (ANTHROPIC_BUILTIN_TOOLS.has(name.toLowerCase()) || name.toLowerCase().startsWith(CLAUDE_TOOL_PREFIX)) return name;
  return CLAUDE_TOOL_PREFIX + name;
}

/** Strip the custom_ prefix from a returned tool_use name so the caller (Codex) sees the original. */
export function stripClaudeToolPrefix(name: string): string {
  return name.startsWith(CLAUDE_TOOL_PREFIX) ? name.slice(CLAUDE_TOOL_PREFIX.length) : name;
}

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account?: { uuid?: string; email_address?: string };
}

export class AnthropicTokenError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number | undefined,
    readonly oauthError: string | undefined,
    readonly requestNotSent = false,
  ) {
    super(message);
    this.name = "AnthropicTokenError";
  }
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
  const direct = !startupOutboundProxyConfigured && !outboundProxyConfigured();
  const init: RequestInit & { protocol: "http1.1" } = {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    // Pinned Bun 1.4.0: one HTTP/1.1 attempt, no keep-alive reuse or redirect following.
    // Only without an outbound proxy can token-host DNS failure prove no request was sent.
    redirect: "manual",
    keepalive: false,
    protocol: "http1.1",
  };
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (direct && typeof error === "object" && error !== null
      && "code" in error && error.code === "ENOTFOUND"
      && "syscall" in error && error.syscall === "getaddrinfo"
      && "hostname" in error && error.hostname === new URL(url).hostname) {
      throw new AnthropicTokenError("Anthropic OAuth DNS lookup failed before connection", undefined, undefined, true);
    }
    throw error;
  }
  if (response.status >= 300 && response.status < 400) {
    // A redirect can follow a completed POST and token rotation; it is not a rejection.
    await response.body?.cancel().catch(() => {});
    throw new AnthropicTokenError(`Anthropic OAuth redirect HTTP ${response.status}: outcome unknown`, undefined, undefined);
  }
  const responseBody = await response.text();
  if (!response.ok) {
    let oauthError: string | undefined;
    try {
      const parsed = JSON.parse(responseBody) as { error?: unknown };
      if (typeof parsed.error === "string") oauthError = parsed.error;
    } catch {
      // Best-effort only: malformed error bodies remain structured by HTTP status.
    }
    throw new AnthropicTokenError(
      `Anthropic OAuth HTTP ${response.status}: ${responseBody}`,
      response.status,
      oauthError,
    );
  }
  return responseBody;
}

function parseTokenResponse(responseBody: string): AnthropicTokenResponse {
  try {
    return JSON.parse(responseBody) as AnthropicTokenResponse;
  } catch {
    throw new Error(`Anthropic OAuth returned invalid JSON: ${responseBody.slice(0, 200)}`);
  }
}

function credsFrom(data: AnthropicTokenResponse, refreshFallback?: string): OAuthCredentials {
  const accountUuid = data.account?.uuid;
  const email = data.account?.email_address;
  // Guard against a missing/non-finite/negative expires_in (malformed upstream
  // response): a NaN expiry would never compare as expired, and a negative
  // duration would stamp an already-past expiry — both block refresh semantics.
  const expiresIn =
    typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in >= 0
      ? data.expires_in
      : 3600;
  // The computed timestamp itself must stay finite: Number.MAX_VALUE passes
  // Number.isFinite but overflows to Infinity once multiplied by 1000.
  const computedExpires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
  const expires = Number.isFinite(computedExpires) ? computedExpires : Date.now() + 3600 * 1000 - 5 * 60 * 1000;
  return {
    refresh: data.refresh_token || refreshFallback || "",
    access: data.access_token,
    expires,
    anthropicIdentity: bindAnthropicIdentity(data.access_token, accountUuid),
    accountId: typeof accountUuid === "string" && accountUuid.length > 0 ? accountUuid : undefined,
    email: typeof email === "string" && email.length > 0 ? email : undefined,
  };
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
  #verifier = "";

  constructor(ctrl: OAuthController) {
    super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
  }

  async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
    const pkce = await generatePKCE();
    this.#verifier = pkce.verifier;
    const authParams = new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    });
    return {
      url: `${AUTHORIZE_URL}?${authParams.toString()}`,
      instructions:
        "Complete Claude login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
    };
  }

  async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
    let exchangeCode = code;
    let exchangeState = state;
    const hash = code.indexOf("#");
    if (hash >= 0) {
      exchangeCode = code.slice(0, hash);
      const frag = code.slice(hash + 1);
      if (frag.length > 0) exchangeState = frag;
    }
    const responseBody = await postJson(TOKEN_URL, {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: exchangeCode,
      state: exchangeState,
      redirect_uri: redirectUri,
      code_verifier: this.#verifier,
    });
    return credsFrom(parseTokenResponse(responseBody));
  }
}

export async function loginAnthropic(
  ctrl: OAuthController,
  opts?: { importLocal?: LocalTokenImportMode },
): Promise<OAuthCredentials> {
  const importLocal = opts?.importLocal ?? "off";
  if (importLocal !== "off") {
    const { detectClaudeCodeToken } = await import("./local-token-detect");
    const local = detectClaudeCodeToken();
    if (local) {
      ctrl.onProgress?.("Found Claude Code token, importing automatically");
      if (local.expires >= Date.now() + 60_000) {
        const identity = await resolveAnthropicAccountIdentity(local.access, ctrl.signal);
        ctrl.signal?.throwIfAborted();
        return { ...local, ...(identity ? { accountId: identity.accountUuid, anthropicIdentity: identity } : {}) };
      }
      try {
        return { ...(await refreshAnthropicToken(local.refresh)), source: "local-cli" };
      } catch (error) {
        if (importLocal === "only") {
          throw new Error(`Claude Code token expired and could not be refreshed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else if (importLocal === "only") {
      throw new Error(
        process.platform === "darwin"
          ? "No Claude Code token found (Keychain or ~/.claude/.credentials.json). Run 'ocx login anthropic' for browser OAuth."
          : "No Claude Code token found (~/.claude/.credentials.json). Run 'ocx login anthropic' for browser OAuth.",
      );
    }
  }
  return new AnthropicOAuthFlow(ctrl).login();
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const responseBody = await postJson(TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  return credsFrom(parseTokenResponse(responseBody), refreshToken);
}
