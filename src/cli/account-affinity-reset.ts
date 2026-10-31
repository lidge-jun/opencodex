import { isAnthropicOAuthInstance } from "../providers/anthropic-instance";
import { apiJson, resolveBaseUrl, type AccountDeps } from "./account-api";

/** Provider-only recovery remains available after the last account was removed. */
export async function cmdResetAffinity(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = args.includes("--json");
  const positional = args.filter(arg => arg !== "--json");
  const provider = positional[0]?.trim().toLowerCase() ?? "";
  const fail = (code: string, message: string, exit = 1, retryable = false): number => {
    if (wantsJson) console.log(JSON.stringify({ ok: false, code, retryable }));
    else console.error(message);
    return exit;
  };
  if (positional.length !== 1 || !isAnthropicOAuthInstance(provider) || args.filter(arg => arg === "--json").length > 1) {
    return fail("invalid_arguments", "Usage: ocx account reset-affinity <anthropic|anthropic2> [--json]");
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return fail("proxy_unreachable", "Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  const response = await apiJson(deps, baseUrl, "PUT", "/api/oauth/accounts/affinity-reset", { provider });
  if (response.status === 0) return fail("proxy_unreachable", "Proxy not reachable; affinity reset was not confirmed.");
  const result = response.json;
  if (response.status !== 200) {
    const pending = result?.code === "affinity_reset_not_persisted" && result.retryable === true;
    return fail(pending ? "affinity_reset_not_persisted" : "affinity_reset_failed",
      pending ? "Session-affinity reset was not persisted; retry this command." : `Affinity reset failed (HTTP ${response.status}).`,
      response.status === 404 ? 4 : response.status === 409 ? 5 : 1, pending);
  }
  if (result?.ok !== true || result.provider !== provider || result.affinityResetConfirmed !== true) {
    return fail("affinity_reset_unconfirmed", "Server did not confirm the session-affinity reset; success is unknown.");
  }
  if (wantsJson) console.log(JSON.stringify({ ok: true, provider, affinityResetConfirmed: true }));
  else console.log(`${provider}: session-affinity reset confirmed; account selection and pause state unchanged.`);
  return 0;
}
