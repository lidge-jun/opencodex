/**
 * Devin / Cognition OAuth.
 *
 * Login is import-first: a signed-in Devin CLI has already completed PKCE, so
 * its credentials.toml session is adopted without opening a browser (the kiro
 * shape). Only when no CLI credential exists does login fall back to the Auth0
 * browser sign-in flow (windsurf.com/windsurf/signin with
 * redirect_uri=show-auth-token), which exchanges the pasted Firebase ID token
 * via Cognition's RegisterUser for a long-lived API key. The browser path is
 * kept because it is the only login route for a user without the CLI.
 *
 * `devin-cli` used to be a second provider id owning the import half; it is
 * now a deprecated alias for `devin` (see DEPRECATED_OAUTH_PROVIDER_ALIASES in
 * ./index), and this module is the single login/refresh owner for both.
 */
import { randomUUID } from "node:crypto";
import type { OAuthController, OAuthCredentials } from "./types";
import { DEFAULT_REGION, type WindsurfRegion } from "./devin/types";
import { registerUser } from "./devin/register-user";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "./devin/api-base";
import { readDevinCliCredentialOutcome } from "./devin/cli-import";
import { getCredential, listAccounts } from "./store";
import { DEPRECATED_OAUTH_PROVIDER_ALIASES } from "./index";

export { DEVIN_DEFAULT_API_SERVER } from "./devin/api-base";

/**
 * Credential slots the deprecated-alias map ties to `providerId`, in both
 * directions: a deprecated id also reads its destination's slot, and a merge
 * destination also reads every deprecated source slot pointing at it. Derived
 * from DEPRECATED_OAUTH_PROVIDER_ALIASES rather than a second "devin-cli"
 * literal so the map stays the single source of truth — a hard-coded pair here
 * would drift the day another alias is added.
 */
function devinAliasCredentialSlots(providerId: string): string[] {
  const slots: string[] = [];
  const destination = DEPRECATED_OAUTH_PROVIDER_ALIASES[providerId];
  if (destination !== undefined) slots.push(destination);
  for (const [alias, target] of Object.entries(DEPRECATED_OAUTH_PROVIDER_ALIASES)) {
    if (target === providerId && alias !== providerId) slots.push(alias);
  }
  return slots;
}

/**
 * The api-server host this account must talk to.
 *
 * RegisterUser hands EU and FedStart tenants a host of their own and it is kept
 * on the credential, so the signed-in account decides the destination. The
 * configured provider baseUrl is the fallback, and the US default is the last
 * resort; both are re-validated because neither is trusted more than the
 * network value.
 *
 * A stored tenant host is used only for the account that owns `apiKey`, the key
 * this request will transmit. Devin keeps several accounts per provider id and
 * the request path injects the admitted account's token, which need not be the
 * active one, while a provider-configured key, a forwarded bearer, or a test
 * token is not stored at all. Reading the active slot's host for any of those
 * would send one account's key to another account's EU or FedStart tenant.
 */
export function resolveDevinApiServer(configuredBaseUrl?: string, providerId = "devin", apiKey?: string): string {
  const owner = apiKey ? findDevinCredentialOwner(providerId, apiKey) : undefined;
  if (owner !== undefined) {
    // The owning account decides. An owner whose recorded host is missing or
    // off-allowlist falls through to the configured base URL rather than
    // borrowing another slot's tenant: the same key stored twice is the rekey
    // window, and a second slot's host is not more trustworthy than this one.
    const host = validateDevinApiBaseUrl(owner.apiBaseUrl);
    if (host !== undefined) return host;
  }
  return validateDevinApiBaseUrl(configuredBaseUrl) ?? DEVIN_DEFAULT_API_SERVER;
}

/**
 * The stored credential whose access token is exactly `apiKey`.
 *
 * The configured provider id is searched first and verbatim: `devin-cli` is a
 * deprecated alias for `devin`, but an unmigrated config row still owns its old
 * slot until the startup migration rekeys the row and the slot together. The
 * startup merge saves providers["devin"] synchronously but fires the credential
 * rekey detached (runDevinProviderMergeStartupMigration cannot await inside the
 * synchronous startServer window), so the alias-linked slots are searched next,
 * in both directions. Within a slot the active account is read first, then the
 * rest, because the admitted account can be any of them.
 *
 * A key refreshed between token resolution and this lookup would match nothing
 * and use the configured host for that turn. Devin keys are long-lived
 * RegisterUser API keys, so this window is not a routine refresh race.
 */
function findDevinCredentialOwner(providerId: string, apiKey: string): OAuthCredentials | undefined {
  for (const slot of [providerId, ...devinAliasCredentialSlots(providerId)]) {
    const active = getCredential(slot);
    if (active?.access === apiKey) return active;
    for (const account of listAccounts(slot)) {
      if (account.credential.access === apiKey) return account.credential;
    }
  }
  return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length < 2 || !payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function identityFromApiKey(apiKey: string): { accountId?: string; email?: string } {
  const jwtPart = apiKey.includes("$") ? apiKey.slice(apiKey.indexOf("$") + 1) : apiKey;
  const payload = decodeJwtPayload(jwtPart);
  const email = typeof payload?.email === "string" && payload.email.length > 0 ? payload.email : undefined;
  const sub = typeof payload?.sub === "string" && payload.sub.length > 0 ? payload.sub : undefined;
  const authUid = typeof payload?.auth_uid === "string" && payload.auth_uid.length > 0 ? payload.auth_uid : undefined;
  return { ...(email ? { email } : {}), ...(sub || authUid ? { accountId: sub ?? authUid } : {}) };
}

function credentialsFromApiKey(
  apiKey: string,
  apiBaseUrl: string,
  source: OAuthCredentials["source"] = "oauth",
): OAuthCredentials {
  const identity = identityFromApiKey(apiKey);
  return {
    access: apiKey,
    // Cognition issues a durable key and exposes no refresh endpoint. Carrying
    // the key here rather than "" is the house pattern for durable-key
    // providers: an empty refresh makes detectOAuthWarning report
    // stale_credentials for every Devin account from the moment it logs in.
    refresh: apiKey,
    // No expiry to model. A synthetic one-year deadline only produces a
    // refresh attempt against an endpoint that does not exist.
    expires: Number.MAX_SAFE_INTEGER,
    source,
    apiBaseUrl,
    ...identity,
  };
}

function buildSignInUrl(region: WindsurfRegion): string {
  const params = new URLSearchParams({
    response_type: "token",
    client_id: region.oauthClientId,
    redirect_uri: "show-auth-token",
    state: randomUUID(),
    prompt: "login",
  });
  return region.website + "/windsurf/signin?" + params.toString();
}

/**
 * Shape of the value the sign-in page hands back.
 *
 * It is not always a JWT. A live free-tier sign-in against
 * windsurf.com/windsurf/signin returns a 47-character one-time token of the
 * form `ott$<base64url>`, and RegisterUser accepts it; an earlier JWT-only
 * check here would have rejected every real login. So this is deliberately a
 * shape check for "one opaque credential-looking word" rather than a format
 * check: the point is to tell a token from a pasted URL or a sentence, not to
 * second-guess what the vendor mints.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9._$~+/=-]{20,4096}$/;

const TOKEN_PARAM_NAMES = ["firebase_id_token", "access_token", "id_token", "token"] as const;

/**
 * Turn whatever the user pasted into the Firebase ID token RegisterUser expects.
 *
 * The sign-in page shows a bare token, but a user who copies the address bar
 * instead hands us a callback URL whose fragment carries it. Posting that URL
 * as `firebase_id_token` produces an opaque server-side rejection, so pull the
 * token out and refuse a paste that has none rather than sending something that
 * cannot work.
 */
export function parseDevinAuthPaste(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("No auth token pasted; cannot complete Devin sign-in.");
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("That paste is not a usable Devin auth token or sign-in URL.");
    }
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    for (const params of [new URLSearchParams(hash), url.searchParams]) {
      for (const name of TOKEN_PARAM_NAMES) {
        const value = params.get(name)?.trim();
        if (value && TOKEN_SHAPE.test(value)) return value;
      }
    }
    throw new Error("That sign-in URL carries no auth token. Paste the token shown on the Windsurf page instead.");
  }
  if (TOKEN_SHAPE.test(trimmed)) return trimmed;
  throw new Error("That paste is not a Devin auth token. Copy the token shown on the Windsurf sign-in page.");
}

async function loginDevinBrowser(ctrl: OAuthController, region: WindsurfRegion): Promise<OAuthCredentials> {
  const url = buildSignInUrl(region);
  ctrl.onAuth?.({
    url,
    instructions: "Sign in with your Cognition/Devin account, then paste the on-screen auth token here.",
  });
  ctrl.onProgress?.("Waiting for the pasted auth token...");
  const pasted = (await ctrl.onManualCodeInput?.())?.trim();
  if (!pasted) throw new Error("No auth token pasted; cannot complete Devin sign-in.");
  const firebaseIdToken = parseDevinAuthPaste(pasted);
  const result = await registerUser(firebaseIdToken, region, ctrl.signal);
  const credentials = credentialsFromApiKey(result.apiKey, resolveDevinApiBaseUrl(result.apiServerUrl), "oauth");
  // The display name is not an identity. Use it only when the key carried no
  // email, otherwise reauth compares a label against an address and mismatches.
  if (!credentials.email && result.name) credentials.email = result.name;
  return credentials;
}

/**
 * Import-first login for the merged `devin` provider.
 *
 * A signed-in CLI already completed PKCE, so its session is adopted directly
 * and no browser opens. Only `missing` falls through to the browser flow:
 * `unreadable` and `incomplete` describe a file that exists but is broken,
 * and a browser sign-in would not repair it, so they throw rather than
 * silently routing around the real problem. `forceLogin` skips the import
 * outright — reauth and add-account must be able to reach a different account
 * than the CLI's, and the management routes already set it for both.
 */
export async function loginDevin(
  ctrl: OAuthController,
  opts?: { forceLogin?: boolean },
): Promise<OAuthCredentials> {
  if (opts?.forceLogin !== true) {
    const outcome = readDevinCliCredentialOutcome();
    // No branch names path contents or parsed values. A Connect error can echo
    // a request, and redactSecretString does not recognise a bare JWT or a
    // devin-session-token — the same caution register-user.ts applies to error
    // bodies applies to anything thrown here.
    if (outcome.kind === "unreadable") {
      // The file is there and we could not read it, so `devin auth login` is
      // the wrong instruction: it would succeed and change nothing.
      throw new Error(
        "Found a Devin CLI credential file but could not read it. Check its permissions and size, then try again.",
      );
    }
    if (outcome.kind === "incomplete") {
      throw new Error(
        "The Devin CLI credential file is missing its session key or API server URL. Run `devin auth login` again to rewrite it.",
      );
    }
    if (outcome.kind === "ok") {
      // The host comes off disk and then receives the key, so it passes the
      // same allowlist as the RegisterUser host. An unallowlisted value falls
      // back to the default rather than becoming an exfiltration target.
      const apiBaseUrl = resolveDevinApiBaseUrl(outcome.file.apiServerUrl);
      ctrl.onProgress?.("Imported the signed-in Devin CLI session.");
      return credentialsFromApiKey(outcome.file.apiKey, apiBaseUrl, "local-cli");
    }
    // "missing": no CLI session to adopt. The browser flow below is the only
    // login path left for a user without the CLI installed.
  }
  return loginDevinBrowser(ctrl, DEFAULT_REGION);
}

export async function refreshDevinToken(
  _refreshToken: string,
  _signal?: AbortSignal,
  _credential?: OAuthCredentials,
): Promise<OAuthCredentials> {
  // Cognition has no refresh endpoint. Extending the stored expiry here is what
  // the carried implementation did, and it makes a revoked key look valid
  // forever. Throwing lets the request path mark the account needsReauth the
  // first time a forced refresh happens.
  throw new Error("invalid_grant: Devin API keys do not refresh. Run ocx login devin again.");
}
