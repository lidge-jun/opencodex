import { lstatSync } from "node:fs";
import { decodeJwtPayload, extractAccountIdClaims, extractEmail } from "../../oauth/chatgpt";
import { checkAccountIdCollision, readMainAuth } from "../auth-collision";
import { resolveCodexHomeDir } from "../home";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";
import { extractChatgptPlanType } from "../plan";
import { nativeUserIdClaims } from "../reserve-availability";
import { isNativeMainClaimUnavailable } from "./http";

export class CodexCollisionReadBusyError extends Error {
  constructor() { super("Native Codex login is busy or unreadable; retry login shortly."); }
}

/** A workspace rollover may retain an older ID token, but never a different user or subject. */
function sameNativeWorkspaceUser(idToken: string, accessToken: string): boolean {
  const id = nativeUserIdClaims(idToken), access = nativeUserIdClaims(accessToken);
  const idSubject = decodeJwtPayload(idToken)?.sub, accessSubject = decodeJwtPayload(accessToken)?.sub;
  const idEmail = extractEmail(idToken), accessEmail = extractEmail(undefined, accessToken);
  return !id.conflict && !access.conflict && Boolean(id.userId?.trim()) && id.userId === access.userId
    && typeof idSubject === "string" && idSubject.trim().length > 0 && idSubject === accessSubject
    && Boolean(idEmail) && idEmail === accessEmail;
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
      const claims = [extractAccountIdClaims(tokens.id_token), extractAccountIdClaims(tokens.access_token)];
      // The selected workspace belongs to the current access token and explicit envelope.
      // An older ID token may name another workspace for the exact same authenticated user.
      const nativeId = claims[1]!.accountId ?? (tokens.account_id || claims[0]!.accountId);
      const priorWorkspace = Boolean(claims[0]!.accountId && claims[0]!.accountId !== nativeId);
      const nativePlan = extractChatgptPlanType(priorWorkspace ? undefined : tokens.id_token, tokens.access_token);
      const emails = [extractEmail(tokens.id_token), extractEmail(undefined, tokens.access_token)].filter(Boolean);
      if (!nativeId || typeof tokens.account_id !== "string" || typeof tokens.access_token !== "string"
        || (tokens.id_token !== undefined && typeof tokens.id_token !== "string")
        || claims.some(claim => claim.conflict)
        || (tokens.account_id && tokens.account_id !== nativeId) || new Set(emails).size > 1
        || (priorWorkspace && (!tokens.account_id.trim() || !claims[1]!.accountId || !tokens.id_token || !nativePlan
          || !sameNativeWorkspaceUser(tokens.id_token, tokens.access_token)))) {
        throw new CodexCollisionReadBusyError();
      }
      return checkAccountIdCollision(accountId, email, plan, excludeAccountId, {
        accountId: nativeId, email: extractEmail(tokens.id_token, tokens.access_token),
        plan: nativePlan,
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
