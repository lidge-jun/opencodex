import { readCodexTokens } from "./auth-collision";
import { decodeJwtPayload } from "../oauth/chatgpt";
import { extractChatgptPlanType } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export { MAIN_CODEX_ACCOUNT_ID } from "./account-id";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;
let jwtPlanAttempted = false;

export function setMainAccountPlan(plan: string | null): void {
  mainAccountPlan = plan;
  if (plan === null) jwtPlanAttempted = false;
}

export function getMainAccountPlan(): string | undefined {
  if (mainAccountPlan) return mainAccountPlan;
  if (jwtPlanAttempted) return undefined;
  jwtPlanAttempted = true;
  const tokens = readCodexTokens();
  const jwtPlan = tokens
    ? extractChatgptPlanType(tokens.id_token, tokens.access_token)
    : undefined;
  if (jwtPlan) mainAccountPlan = jwtPlan;
  return jwtPlan;
}

/** Read-only main account token from ~/.codex/auth.json, or null when not logged in. */
export function getMainAccountToken(): { accessToken: string; chatgptAccountId: string } | null {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return null;
  return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id };
}

/**
 * The main token is usable when it exists and — if its JWT carries a decodable `exp` — is
 * not expired. When `exp` cannot be decoded we treat the token as live (best-effort); an
 * actually-invalid token then surfaces via the upstream 401 → cooldown path.
 */
export function isMainAccountTokenLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return false;
  const payload = decodeJwtPayload(tokens.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp === undefined || exp > now;
}

/**
 * Strict liveness for auth-terminality decisions: true only when the access-token JWT
 * carries a decodable `exp` that is still in the future.
 *
 * Unlike {@link isMainAccountTokenLive}, an undecodable `exp` counts as NOT live here.
 * This gate decides whether a bare WHAM 401 is downgraded to a transient failure; if an
 * undecodable token could vouch for itself, a genuinely dead credential would keep every
 * 401 "transient" and needsReauth could never flip.
 */
export function isMainAccountTokenVerifiablyLive(now = Date.now()): boolean {
  const tokens = readCodexTokens();
  if (!tokens?.access_token) return false;
  const payload = decodeJwtPayload(tokens.access_token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
  return exp !== undefined && exp > now;
}
