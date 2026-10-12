import { lstatSync } from "node:fs";
import type { OcxConfig } from "../../types";
import { inspectChatGptDomainClaim, extractEmail } from "../../oauth/chatgpt";
import { MAIN_CODEX_ACCOUNT_ID, isSelectableCodexPoolAccount } from "../account-id";
import { readCodexTokensResult } from "../auth-collision";
import type { CodexTokenReadResult } from "../auth-collision";
import { getCodexAccountCredential } from "../account-store";
import { resolveCodexHomeDir } from "../home";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { MAX_AUTH_BYTES, readBounded, resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";
import { isNativeMainClaimUnavailable, nativeMainProfileBusyResponse } from "./http";

type AccountIdentity = { accountId: string; email: string };
type MainAuth = CodexTokenReadResult | { status: "api-key-only" };

/** A valid API-key login has no ChatGPT identity; anything else unreadable stays unknown. */
function readMainAuth(authPath: string): MainAuth {
  const main = readCodexTokensResult(authPath, { bounded: true });
  if (main.status !== "invalid") return main;
  try {
    const j: unknown = JSON.parse(readBounded(authPath, MAX_AUTH_BYTES).toString("utf-8"));
    if (j === null || typeof j !== "object" || Array.isArray(j)) return main;
    const envelope = j as { auth_mode?: unknown; OPENAI_API_KEY?: unknown; tokens?: unknown };
    const apiKeyOnly = envelope.tokens == null
      && (envelope.auth_mode === undefined || envelope.auth_mode === "api_key")
      && typeof envelope.OPENAI_API_KEY === "string" && envelope.OPENAI_API_KEY.trim() !== "";
    return apiKeyOnly ? { status: "api-key-only" } : main;
  } catch {
    return main;
  }
}

function identity(accountId: unknown, email: unknown): AccountIdentity | undefined {
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : undefined;
  return typeof accountId === "string" && accountId.trim() && normalizedEmail
    ? { accountId: accountId.trim(), email: normalizedEmail }
    : undefined;
}

/** Resolve only existing entries, under native-main ownership, never on the request path. */
function linkedAccountIds(config: OcxConfig, selectedId: string, main: MainAuth): string[] | undefined {
  // Unknown main identity must not produce a successful but incomplete pause.
  if (main.status === "unreadable" || main.status === "invalid") return undefined;
  const identities = new Map<string, AccountIdentity | undefined>();
  if (main.status === "ok") {
    const tokens = main.tokens;
    if (typeof tokens.access_token !== "string" || typeof tokens.account_id !== "string"
      || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")) return undefined;
    const claims = [tokens.id_token, tokens.access_token]
      .filter((token): token is string => typeof token === "string")
      .map(inspectChatGptDomainClaim);
    if (claims.some(claim => claim.kind === "invalid")) return undefined;
    const claimIds = claims.flatMap(claim => claim.kind === "valid" ? [claim.accountId] : []);
    // organizations[] describes memberships, not the selected workspace. Never use its first row.
    const accountId = tokens.account_id.trim() || claimIds[0];
    if (claimIds.some(claim => claim !== accountId)) return undefined;
    // Both tokens must name the same member; otherwise the bearer's identity is unknown.
    const emails = new Set([extractEmail(tokens.id_token), extractEmail(undefined, tokens.access_token)]
      .flatMap(email => email?.trim() ? [email.trim().toLowerCase()] : []));
    if (emails.size > 1) return undefined;
    identities.set(MAIN_CODEX_ACCOUNT_ID, identity(accountId, [...emails][0]));
  }
  for (const account of config.codexAccounts ?? []) {
    if (!isSelectableCodexPoolAccount(account)) continue;
    const credential = getCodexAccountCredential(account.id);
    identities.set(account.id, identity(credential?.chatgptAccountId, account.email));
  }
  const selected = identities.get(selectedId);
  // Missing identity evidence never links unrelated logins, including members of one workspace.
  if (!selected) return [selectedId];
  return [selectedId, ...[...identities].flatMap(([id, candidate]) => (
    id !== selectedId && candidate?.accountId === selected.accountId && candidate.email === selected.email
      ? [id] : []
  ))];
}

/** Hold admission throughout; claim the physical main whenever its home exists. */
export async function withCodexAccountPauseGroup(
  config: OcxConfig,
  selectedId: string,
  publish: (accountIds: string[]) => Response,
): Promise<Response> {
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) return nativeMainProfileBusyResponse();
  try {
    const codexHome = resolveCodexHomeDir();
    try {
      lstatSync(codexHome);
    } catch (error) {
      // Only positive absence permits Pool-only publication. A dangling symlink or access
      // failure is not absence; do not create a home just to coordinate an unused main login.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return nativeMainProfileBusyResponse();
      const ids = linkedAccountIds(config, selectedId, { status: "missing" });
      return ids ? publish(ids) : nativeMainProfileBusyResponse();
    }
    const context = resolveNativeProfileContext({ codexHome });
    return await withNativeMainSharedClaim(context, async () => {
      const main = readMainAuth(context.authPath);
      const ids = linkedAccountIds(config, selectedId, main);
      return ids ? publish(ids) : nativeMainProfileBusyResponse();
    });
  } catch (error) {
    if (isNativeMainClaimUnavailable(error)
      || (error instanceof NativeProfileError && error.code === "CODEX_HOME_UNAVAILABLE")) {
      return nativeMainProfileBusyResponse();
    }
    throw error;
  } finally {
    lease.release();
  }
}
