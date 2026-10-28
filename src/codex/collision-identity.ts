import { decodeJwtPayload, extractAccountIdClaims, extractEmail } from "../oauth/chatgpt";
import type { CodexAccount, OcxConfig } from "../types";
import { getCodexAccountCredential } from "./account-store";
import type { CodexTokens } from "./auth-collision";
import { captureMainAccountIdentityGeneration, isMainAccountIdentityGenerationLive } from "./main-account-cache";
import { codexPlanKey, extractChatgptPlanType } from "./plan";
import { nativeUserIdClaims } from "./reserve-availability";

export interface CodexCollisionIdentity {
  accountId: string;
  userId?: string;
  email?: string | null;
  plan?: unknown;
}

function normalizedEmail(email: string | null | undefined): string | undefined {
  return email?.trim().toLowerCase() || undefined;
}

function workspacePlan(plan: unknown): boolean {
  return /team|business|enterprise|workspace|edu/.test(codexPlanKey(plan) ?? "");
}

/** Missing member evidence cannot establish a distinct subscription within one plan bucket. */
export function sameCodexCollisionIdentity(a: CodexCollisionIdentity, b: CodexCollisionIdentity): boolean {
  if (!a.accountId || a.accountId !== b.accountId || workspacePlan(a.plan) !== workspacePlan(b.plan)) return false;
  const aEmail = normalizedEmail(a.email);
  const bEmail = normalizedEmail(b.email);
  return !aEmail || !bEmail || aEmail === bEmail;
}

// Ambient scope comparison is memory-only, including when the default-home resolver would probe WSL.
function homeScope(): string {
  return JSON.stringify([process.env.CODEX_HOME, process.env.HOME, process.env.USERPROFILE, process.env.OPENCODEX_HOME]);
}

let observed: { identity: CodexCollisionIdentity; homeScope: string; generation: number } | undefined;

function suppressObservedUserId(): void {
  if (!observed || observed.homeScope !== homeScope()
    || !isMainAccountIdentityGenerationLive(observed.generation)) return;
  observed = { ...observed, identity: { ...observed.identity, userId: undefined } };
}

/** Only existing owned lifecycle observations may publish; never call with a request bearer. */
export function observeMainCodexCollisionIdentity(tokens?: CodexTokens): void {
  if (!tokens) { observed = undefined; return; }
  if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string"
    || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")) {
    suppressObservedUserId();
    return;
  }
  const claims = [extractAccountIdClaims(tokens.id_token), extractAccountIdClaims(tokens.access_token)];
  if (claims.some(claim => claim.conflict)) { suppressObservedUserId(); return; }
  const accountId = tokens.account_id || claims.find(claim => claim.accountId)?.accountId;
  if (!accountId || claims.some(claim => claim.accountId && claim.accountId !== accountId)) {
    suppressObservedUserId();
    return;
  }
  const emails = new Set([extractEmail(tokens.id_token), extractEmail(undefined, tokens.access_token)]
    .flatMap(email => normalizedEmail(email) ? [normalizedEmail(email)!] : []));
  if (emails.size > 1) { suppressObservedUserId(); return; }
  const idPayload: unknown = tokens.id_token === undefined ? undefined : decodeJwtPayload(tokens.id_token);
  const idTokenMalformed = tokens.id_token !== undefined
    && (idPayload === null || typeof idPayload !== "object" || Array.isArray(idPayload));
  const users = [tokens.id_token ? nativeUserIdClaims(tokens.id_token) : undefined, nativeUserIdClaims(tokens.access_token)];
  const userIds = new Set(users.flatMap(user => user?.userId ? [user.userId] : []));
  // A join key needs one token claiming both the account and the user, as a Pool access token does;
  // auth.json account_id alone, or claims split across a mixed token set, prove no pairing.
  const bound = claims.some((claim, index) => claim.accountId === accountId && users[index]?.userId);
  const userId = !idTokenMalformed && !users.some(user => user?.conflict) && bound && userIds.size === 1
    ? [...userIds][0] : undefined;
  observed = { identity: { accountId, email: [...emails][0],
    ...(userId ? { userId } : {}),
    plan: extractChatgptPlanType(tokens.id_token, tokens.access_token) },
    homeScope: homeScope(), generation: captureMainAccountIdentityGeneration() };
}

/** Compare known identity only. External logins become visible at the next owned observation. */
export function getObservedMainCodexCollisionIdentity(): Readonly<CodexCollisionIdentity> | undefined {
  return observed?.homeScope === homeScope() && isMainAccountIdentityGenerationLive(observed.generation)
    ? observed.identity : undefined;
}

export function isStoredCodexMainDuplicate(account: CodexAccount): boolean {
  const main = getObservedMainCodexCollisionIdentity();
  if (account.isMain || !main) return false;
  const credential = getCodexAccountCredential(account.id);
  if (!credential?.chatgptAccountId) return false;
  const storedEmail = normalizedEmail(account.email);
  const email = storedEmail && storedEmail !== normalizedEmail(account.id)
    ? storedEmail : extractEmail(undefined, credential.accessToken);
  return sameCodexCollisionIdentity({ accountId: credential.chatgptAccountId, email,
    plan: codexPlanKey(account.plan) ? account.plan : extractChatgptPlanType(undefined, credential.accessToken) }, main);
}

export const CODEX_MAIN_DUPLICATE_ACTION =
  "Use the native Codex main account, or sign native Codex into a different account to use this stored Pool entry.";

export function configuredCodexMainDuplicate(config: Pick<OcxConfig, "codexAccounts">, accountId: string): boolean {
  const account = config.codexAccounts?.find(row => row.id === accountId);
  return !!account && isStoredCodexMainDuplicate(account);
}
