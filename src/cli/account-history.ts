import { parseCapacityReason } from "../codex/quota-capacity";
import { isValidCodexAccountId } from "../codex/account-id";
import { apiError, apiJson, proxyUnreachable, resolveBaseUrl, type AccountDeps } from "./account-api";

function historyDate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unknown";
}

/** Read cached pool observations without refreshing credentials or spending quota. */
export async function cmdAccountHistory(args: string[], deps: AccountDeps): Promise<number> {
  const [provider, accountId, ...flags] = args;
  let json = false;
  let limit = 200;
  let hasLimit = false;
  let valid = provider === "openai" && isValidCodexAccountId(accountId);
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "--json" && !json) json = true;
    else if (flags[index] === "--limit" && !hasLimit && /^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(flags[index + 1] ?? "")) {
      limit = Number(flags[++index]); hasLimit = true;
    } else valid = false;
  }
  if (!valid) {
    console.error("Usage: ocx account history openai <pool-account-id> [--limit <1-200>] [--json]");
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  const result = await apiJson(deps, baseUrl, "GET", `/api/codex-auth/quota/history?accountId=${encodeURIComponent(accountId)}&limit=${limit}`);
  if (result.status === 0) return proxyUnreachable(result.transportError);
  if (result.status !== 200) return apiError(result.json, "Quota history unavailable", result.status);
  if (json) { console.log(JSON.stringify(result.json, null, 2)); return 0; }
  const observations = result.json.observations;
  if (!Array.isArray(observations)) return apiError({}, "Invalid quota history response", 502);
  console.log("OBSERVED\tSOURCE\tWINDOW\tUSED\tRESET");
  if (!observations.length) console.log("No quota observations for this credential publication.");
  for (const observation of observations) {
    if (!observation || typeof observation !== "object" || !Array.isArray(observation.windows)
      || !Number.isFinite(observation.observedAt)) return apiError({}, "Invalid quota history response", 502);
    for (const window of observation.windows) {
      console.log(`${historyDate(observation.observedAt)}\t${observation.source}\t${window.family}/${window.window}\t${window.usedPercent}%\t${historyDate(window.resetAtMs)}`);
    }
  }
  const capacity = result.json.capacity;
  if (capacity && typeof capacity === "object" && "status" in capacity && capacity.status === "estimated"
    && "estimates" in capacity && Array.isArray(capacity.estimates)) {
    console.log("Effective capacity estimate (low confidence; not a provider token limit):");
    for (const estimate of capacity.estimates) {
      if (estimate && Number.isFinite(estimate.estimatedTokens) && Number.isSafeInteger(estimate.sampleCount)) {
        console.log(`${estimate.window}\t~${estimate.estimatedTokens} reported tokens / 100%\t${estimate.sampleCount} samples`);
      }
    }
  }
  if (capacity && typeof capacity === "object" && "status" in capacity && capacity.status === "insufficient-evidence") {
    const reason = "reason" in capacity ? parseCapacityReason(capacity.reason) : undefined;
    console.log(`Effective capacity: insufficient evidence${reason ? ` (${reason})` : ""}.`);
  }
  return 0;
}
