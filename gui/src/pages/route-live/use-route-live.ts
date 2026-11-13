/** Data for the Live routing tab: recent request rows (3 s poll) and account display names (60 s poll). */
import { useClientResource } from "../../client-resource";
import { ROUTE_LIVE_ROW_CAP, parseRouteRows, type RouteRow } from "./route-rows";
import type { AccountNames } from "./flow-model";

export const ROUTE_LIVE_POLL_MS = 3000;
const NAMES_POLL_MS = 60_000;

export function useRouteRows(apiBase: string, active: boolean) {
  const resource = useClientResource<RouteRow[]>(
    `route-live:rows:${apiBase}`,
    async signal => {
      const res = await fetch(`${apiBase}/api/logs?limit=${ROUTE_LIVE_ROW_CAP}`, { signal });
      if (!res.ok) throw new Error(String(res.status));
      return parseRouteRows(await res.json());
    },
    { enabled: active, pollMs: ROUTE_LIVE_POLL_MS, deadlineMs: 10_000, staleAfterMs: 0 },
  );
  return resource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** logLabel -> the name the Accounts page shows. A failed provider is skipped, never an error. */
async function readProviderNames(apiBase: string, provider: string, signal: AbortSignal): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  try {
    const res = await fetch(`${apiBase}/api/oauth/accounts?provider=${encodeURIComponent(provider)}`, { signal });
    if (!res.ok) return names;
    const body: unknown = await res.json();
    const accounts = isRecord(body) && Array.isArray(body.accounts) ? body.accounts : [];
    for (const account of accounts) {
      if (!isRecord(account) || typeof account.logLabel !== "string") continue;
      const name = [account.accountLabel, account.alias].find((v): v is string => typeof v === "string" && v.trim() !== "");
      if (name) names[account.logLabel] = name;
    }
  } catch {
    // Names are decoration: the hashed label still identifies the account.
  }
  return names;
}

const NO_NAMES: AccountNames = {};

export function useAccountNames(apiBase: string, active: boolean, providers: readonly string[]): AccountNames {
  const sorted = [...new Set(providers)].sort();
  const resource = useClientResource<AccountNames>(
    `route-live:names:${apiBase}:${sorted.join(",")}`,
    async signal => {
      const entries = await Promise.all(sorted.map(async p => [p, await readProviderNames(apiBase, p, signal)] as const));
      return Object.fromEntries(entries);
    },
    { enabled: active && sorted.length > 0, pollMs: NAMES_POLL_MS, deadlineMs: 10_000 },
  );
  return resource.data ?? NO_NAMES;
}
