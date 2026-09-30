import { apiError, apiJson, proxyUnreachable, resolveBaseUrl, type AccountDeps } from "./account-api";

/** A separate account selector prevents accidentally changing the whole Anthropic pool. */
export async function cmdAnthropicAccountThreshold(args: string[], action: string, wantsJson: boolean, deps: AccountDeps): Promise<number> {
  const selector = args.indexOf("--account");
  const accountId = selector >= 0 ? args[selector + 1] : undefined;
  if (selector >= 0) args.splice(selector, 2);
  let threshold: number | null | undefined;
  if (action === "inherit" && args.length === 0) threshold = null;
  else if (action === "off" && args.length === 0) threshold = 0;
  else if (action === "on" && args.length === 0) threshold = 80;
  else if (action === "threshold" && args.length === 1 && /^\d+$/.test(args[0]!)) threshold = Number(args[0]);
  else if (action !== "status" || args.length !== 0) return invalid();
  if (!accountId?.trim() || accountId.startsWith("--") || (threshold !== undefined && threshold !== null && threshold > 100)) return invalid();
  const base = await resolveBaseUrl(deps);
  if (!base) return proxyUnreachable();
  const response = action === "status"
    ? await apiJson(deps, base, "GET", "/api/oauth/accounts?provider=anthropic")
    : await apiJson(deps, base, "PUT", "/api/oauth/accounts/auto-switch", { provider: "anthropic", accountId, threshold });
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, "failed to update account threshold", response.status);
  if (!response.json || typeof response.json !== "object" || Array.isArray(response.json)) return apiError({}, "invalid account threshold response", 400);
  const result = action === "status"
    ? (Array.isArray(response.json.accounts) ? response.json.accounts : []).find((row: { id?: string } | null) => row?.id === accountId)
    : response.json;
  if (!result || typeof result !== "object") return apiError({}, "account not found", 404);
  if (!Object.hasOwn(result, "autoSwitchThresholdOverride")) return apiError({}, "proxy does not support Anthropic account thresholds; upgrade and restart it", 400);
  const validPercent = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
  if ((result.autoSwitchThresholdOverride !== null && !validPercent(result.autoSwitchThresholdOverride))
    || !validPercent(result.effectiveAutoSwitchThreshold)) return apiError({}, "invalid account threshold response", 400);
  const payload = { provider: "anthropic", accountId, autoSwitchThresholdOverride: result.autoSwitchThresholdOverride,
    effectiveAutoSwitchThreshold: result.effectiveAutoSwitchThreshold };
  if (wantsJson) console.log(JSON.stringify(payload, null, 2));
  else console.log(`auto-switch: ${payload.autoSwitchThresholdOverride === null ? "inherited" : "custom"} (${payload.effectiveAutoSwitchThreshold === 0 ? "usage-based switching disabled" : `${payload.effectiveAutoSwitchThreshold}%`})`);
  return 0;
}

function invalid(): number {
  console.error("Usage: ocx account auto-switch anthropic <status|inherit|on|off|threshold <0-100>> --account <id> [--json]");
  return 2;
}
