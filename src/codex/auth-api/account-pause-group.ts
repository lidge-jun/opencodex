import { observeSignedInCodexIdentity } from "../signed-in-identity";
import { lstatSync } from "node:fs";
import type { OcxConfig } from "../../types";
import { readCodexTokensResult } from "../auth-collision";
import type { CodexTokenReadResult } from "../auth-collision";
import { linkedCodexAccountIds } from "../account-identity";
import { resolveCodexHomeDir } from "../home";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { withNativeMainSharedClaim } from "../native-main-claim";
import { MAX_AUTH_BYTES, readBounded, resolveNativeProfileContext } from "../native-profile-store";
import { NativeProfileError } from "../native-profile-types";
import { isNativeMainClaimUnavailable, nativeMainProfileBusyResponse } from "./http";

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
      const ids = linkedCodexAccountIds(config, selectedId, { status: "missing" });
      if (ids) observeSignedInCodexIdentity();
      return ids ? publish(ids) : nativeMainProfileBusyResponse();
    }
    const context = resolveNativeProfileContext({ codexHome });
    return await withNativeMainSharedClaim(context, async () => {
      const main = readMainAuth(context.authPath);
      const ids = linkedCodexAccountIds(config, selectedId, main);
      if (ids) observeSignedInCodexIdentity(main.status === "ok" ? main.tokens : undefined);
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
