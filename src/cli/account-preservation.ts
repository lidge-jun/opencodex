import { apiError, apiJson, proxyUnreachable, resolveBaseUrl, type AccountDeps } from "./account-api";

/** This operation follows the selected runtime; never read a local account/config roster. */
export async function cmdPreserveSignedIn(args: string[], deps: AccountDeps): Promise<number> {
  const provider = args.shift();
  let mode = "status";
  let hasMode = false;
  let json = false;
  let applyToBound = false;
  for (const arg of args) {
    if (arg === "--json" && !json) json = true;
    else if (arg === "--apply-to-bound" && !applyToBound) applyToBound = true;
    else if (["on", "off", "status"].includes(arg) && !hasMode) { mode = arg; hasMode = true; }
    else return usage();
  }
  if (provider !== "openai" || (applyToBound && mode !== "on")) return usage();
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const result = await apiJson(deps, baseUrl, mode === "status" ? "GET" : "PUT", "/api/codex-auth/preserve-signed-in",
    mode === "status" ? undefined : { enabled: mode === "on", applyToBound });
  if (result.status === 0) return proxyUnreachable(result.transportError);
  if (result.status !== 200) return apiError(result.json, "Signed-in quota policy unavailable", result.status);
  if (typeof result.json.enabled !== "boolean" || !Array.isArray(result.json.affectedAccountIds)
    || !result.json.affectedAccountIds.every(id => typeof id === "string")
    || (result.json.nextAccountId !== null && typeof result.json.nextAccountId !== "string")) {
    return apiError({}, "Invalid signed-in quota policy response", 502);
  }
  if (json) console.log(JSON.stringify(result.json, null, 2));
  else {
    console.log(`Preserve signed-in quota: ${result.json.enabled ? "on" : "off"}`);
    console.log(`Affected pool entries: ${result.json.affectedAccountIds.join(", ")}`);
    console.log(`Next unbound choice: ${result.json.nextAccountId ?? "none"}`);
    console.log(`Bindings: ${result.json.bindings}; manual pin: ${result.json.pinnedAccountId ?? "none"}`);
    if (result.json.priorityFailbackEnabled === true) console.log("Existing priority failback can move bound work when its quota and freshness conditions hold.");
    console.log("Fallback can consume signed-in quota. Exact-account models override this preference.");
    console.log("Use on --apply-to-bound to release affected bindings and pins for the next request.");
  }
  return 0;
}

function usage(): number {
  console.error("Usage: ocx account preserve-signed-in openai [on|off|status] [--apply-to-bound] [--json]");
  return 1;
}
