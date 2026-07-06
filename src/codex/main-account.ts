import { readCodexTokens } from "./auth-collision";
import { decodeJwtPayload } from "../oauth/chatgpt";

/**
 * Stable id under which the "main" Codex account (the Codex CLI login stored in
 * ~/.codex/auth.json) participates in opencodex's account rotation. The main account is
 * NOT imported into the managed credential store (Option A): its token is read-only from
 * auth.json, so opencodex never refreshes it — an expired token surfaces as a reauth
 * notice (re-login via the Codex CLI) rather than a background refresh.
 */
export const MAIN_CODEX_ACCOUNT_ID = "__main__";

/**
 * Main account plan (e.g. "plus", "go", "free", "team"), populated from the WHAM usage
 * fetch. Used by the rotation usage-score so go/free main accounts score on monthly
 * percent, matching pool-account behavior.
 */
let mainAccountPlan: string | null = null;

export function setMainAccountPlan(plan: string | null): void {
  mainAccountPlan = plan;
}

export function getMainAccountPlan(): string | undefined {
  return mainAccountPlan ?? undefined;
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
