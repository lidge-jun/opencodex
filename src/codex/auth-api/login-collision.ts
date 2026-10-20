import { lstatSync } from "node:fs";
import { extractAccountId, extractAccountIdClaims, extractEmail } from "../../oauth/chatgpt";
import { checkAccountIdCollision, readMainAuth } from "../auth-collision";
import { resolveCodexHomeDir } from "../home";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";
import { extractChatgptPlanType } from "../plan";
import { isNativeMainClaimUnavailable } from "./http";

export class CodexCollisionReadBusyError extends Error {
  constructor() { super("Native Codex login is busy or unreadable; retry login shortly."); }
}

/** Only admission owns physical reads; synchronous collision consumers use observed identity. */
export async function checkAccountIdCollisionWithNativeMain(
  accountId: string, email?: string | null, plan?: unknown, excludeAccountId?: string | null,
): Promise<ReturnType<typeof checkAccountIdCollision>> {
  const lease = tryAcquireNativeMainProfileClaim();
  if (!lease) throw new CodexCollisionReadBusyError();
  try {
    const codexHome = resolveCodexHomeDir();
    try { lstatSync(codexHome); } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return checkAccountIdCollision(accountId, email, plan, excludeAccountId, null);
      }
      throw new CodexCollisionReadBusyError();
    }
    const context = resolveNativeProfileContext({ codexHome });
    return await withNativeMainSharedClaim(context, async () => {
      const main = readMainAuth(context.authPath);
      if (main.status === "missing" || main.status === "api-key-only") {
        return checkAccountIdCollision(accountId, email, plan, excludeAccountId, null);
      }
      if (main.status !== "ok") throw new CodexCollisionReadBusyError();
      const tokens = main.tokens;
      const nativeId = extractAccountId(tokens.id_token, tokens.access_token) ?? tokens.account_id;
      const claims = [extractAccountIdClaims(tokens.id_token), extractAccountIdClaims(tokens.access_token)];
      const emails = [extractEmail(tokens.id_token), extractEmail(undefined, tokens.access_token)].filter(Boolean);
      if (!nativeId || typeof tokens.account_id !== "string" || typeof tokens.access_token !== "string"
        || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")
        || claims.some(claim => claim.conflict || (claim.accountId && claim.accountId !== nativeId))
        || (tokens.account_id && tokens.account_id !== nativeId) || new Set(emails).size > 1) {
        throw new CodexCollisionReadBusyError();
      }
      return checkAccountIdCollision(accountId, email, plan, excludeAccountId, {
        accountId: nativeId, email: extractEmail(tokens.id_token, tokens.access_token),
        plan: extractChatgptPlanType(tokens.id_token, tokens.access_token),
      });
    });
  } catch (error) {
    if (isNativeMainClaimUnavailable(error)
      || (error instanceof NativeProfileError && error.code === "CODEX_HOME_UNAVAILABLE")) {
      throw new CodexCollisionReadBusyError();
    }
    throw error;
  } finally { lease.release(); }
}
