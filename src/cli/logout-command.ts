import { isValidProviderName } from "../config/provider-name";
import { oauthCredentialSiblingsOf, oauthCredentialSlot } from "../oauth/credential-siblings";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, printData, runtimeBaseUrl, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

export interface LogoutCommandDeps extends RuntimeApiDeps {
  /** Atomic store disposition; test callers use a synthetic store only. */
  removeCredential?: (provider: string) => Promise<"removed" | "not-found">;
}

/**
 * A login shared by several provider rows (#8087: kimi and kimi-responses). Logging out of any of
 * them removes the active account of the one shared slot, so the result names every row it reaches.
 */
function sharedLogin(provider: string): { slot: string; rows: string[] } | null {
  const slot = oauthCredentialSlot(provider);
  const rows = [slot, ...oauthCredentialSiblingsOf(slot)];
  return rows.length > 1 ? { slot, rows } : null;
}

function sharedLoginLine(shared: { slot: string; rows: string[] }): string {
  return `This removed the active account of the shared ${shared.slot} login, so the ${shared.rows.join(" and ")} rows are both signed out of it. Another stored ${shared.slot} account, if any, is now active for both; if it is paused or needs re-login, neither row can use it until you resume or re-login.`;
}

/** Explicit target selection precedes all credential access; never fall back between targets. */
export async function handleLogoutCommand(argv: string[], deps: LogoutCommandDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const json = takeFlag(args, "--json");
    const live = takeFlag(args, "--live");
    const provider = args.shift()?.trim().toLowerCase();
    if (!provider || !isValidProviderName(provider) || args.length) {
      throw new CliUsageError("Expected one provider and no unknown or repeated options.", "Usage: ocx logout <provider> [--live] [--json]");
    }
    const shared = sharedLogin(provider);
    const sharedFields = shared ? { credentialSlot: shared.slot, affectedRows: shared.rows } : {};
    if (live) {
      const { isPublicOAuthProvider } = await import("../oauth");
      if (!isPublicOAuthProvider(oauthCredentialSlot(provider))) throw new CliUsageError("Live logout requires a public OAuth provider; Codex and native-main logout are not supported.");
      const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
      const data = await runtimeRequest<unknown>(`/api/oauth/logout?provider=${encodeURIComponent(provider)}`, {
        method: "POST", redirect: "error",
      }, pinned);
      if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).success !== true) {
        throw new Error("Unverified logout result");
      }
      printData({ schemaVersion: 1, success: true, provider, live: true, ...sharedFields }, json,
        [`Logged out of ${provider} on the selected proxy.`, ...(shared ? [sharedLoginLine(shared)] : [])]);
      return 0;
    }
    const remove = deps.removeCredential ?? (await import("../oauth/store")).removeCredential;
    const outcome = await remove(oauthCredentialSlot(provider));
    if (outcome === "not-found") {
      if (json) printData({ schemaVersion: 1, ok: false, provider, removed: false, reason: "not_found" }, true);
      else console.error(`No stored credential for '${provider}'.`);
      return 4;
    }
    if (outcome !== "removed") throw new Error("Unverified local logout result");
    printData({ schemaVersion: 1, ok: true, provider, removed: true, ...sharedFields }, json,
      [`Logged out of ${provider}.`, ...(shared ? [sharedLoginLine(shared)] : [])]);
    return 0;
  });
}
