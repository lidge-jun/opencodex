import { isValidProviderName } from "../config/provider-name";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, printData, runtimeBaseUrl, runtimeRequest, takeFlag, type RuntimeApiDeps } from "./runtime-api";

export interface LogoutCommandDeps extends RuntimeApiDeps {
  /** Atomic store disposition; test callers use a synthetic store only. */
  removeCredential?: (provider: string) => Promise<"removed" | "not-found">;
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
    if (live) {
      const { isPublicOAuthProvider } = await import("../oauth");
      if (!isPublicOAuthProvider(provider)) throw new CliUsageError("Live logout requires a public OAuth provider; Codex and native-main logout are not supported.");
      const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
      const data = await runtimeRequest<unknown>(`/api/oauth/logout?provider=${encodeURIComponent(provider)}`, {
        method: "POST", redirect: "error",
      }, pinned);
      if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).success !== true) {
        throw new Error("Unverified logout result");
      }
      printData({ schemaVersion: 1, success: true, provider, live: true }, json, [`Logged out of ${provider} on the selected proxy.`]);
      return 0;
    }
    const remove = deps.removeCredential ?? (await import("../oauth/store")).removeCredential;
    const outcome = await remove(provider);
    if (outcome === "not-found") {
      if (json) printData({ schemaVersion: 1, ok: false, provider, removed: false, reason: "not_found" }, true);
      else console.error(`No stored credential for '${provider}'.`);
      return 4;
    }
    if (outcome !== "removed") throw new Error("Unverified local logout result");
    printData({ schemaVersion: 1, ok: true, provider, removed: true }, json, [`Logged out of ${provider}.`]);
    return 0;
  });
}
