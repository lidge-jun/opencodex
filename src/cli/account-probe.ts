import { apiError, apiJson, proxyUnreachable, resolveBaseUrl, type AccountDeps } from "./account-api";

const PROBE_USAGE = "Usage: ocx account probe google-antigravity [<account-id|alias>] [--json]";

interface ProbeRow {
  accountId: string;
  maskedLabel?: string;
  active?: boolean;
  paused?: boolean;
  status: string;
  httpStatus: number | null;
  reason: string | null;
  message: string | null;
  quota?: { customWindows?: Array<{ label: string; percent: number }> } | null;
}

function resolveTarget(accounts: unknown, requested: string): { id: string } | { error: string } {
  const rows = (Array.isArray(accounts) ? accounts : []).filter((row): row is { id: string; alias?: unknown } =>
    typeof row === "object" && row !== null && typeof (row as { id?: unknown }).id === "string");
  if (rows.some(row => row.id === requested)) return { id: requested };
  const matches = rows.filter(row => typeof row.alias === "string" && row.alias.toLowerCase() === requested.toLowerCase());
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length > 1) return { error: `alias "${requested}" names ${matches.length} accounts; use the account id` };
  return { error: `Account not found: no OAuth account has the id or alias "${requested}"` };
}

function rowLine(row: ProbeRow): string {
  const flags = [row.active ? "active" : "", row.paused ? "paused" : ""].filter(Boolean).map(flag => `[${flag}]`).join("");
  const evidence = [row.httpStatus !== null ? `HTTP ${row.httpStatus}` : "", row.reason ?? "", row.message ?? ""].filter(Boolean).join(" · ");
  const windows = (row.quota?.customWindows ?? []).map(window => `${window.label} ${Math.round(100 - window.percent)}% left`).join(", ");
  return [`${row.accountId} ${row.maskedLabel ?? ""}${flags ? ` ${flags}` : ""}`.trim(), row.status, evidence, windows].filter(Boolean).join("  |  ");
}

/** Read-only per-account probe through `POST /api/oauth/accounts/probe`. */
export async function cmdAccountProbe(args: string[], deps: AccountDeps): Promise<number> {
  const wantsJson = args.includes("--json");
  const positional = args.filter(arg => arg !== "--json");
  const provider = positional[0]?.trim().toLowerCase() ?? "";
  const requested = positional[1];
  if (!provider || positional.length > 2) {
    console.error(PROBE_USAGE);
    return 1;
  }
  const baseUrl = await resolveBaseUrl(deps);
  if (!baseUrl) return proxyUnreachable();
  let accountId: string | undefined;
  if (requested !== undefined) {
    const list = await apiJson(deps, baseUrl, "GET", `/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
    if (list.status === 0) return proxyUnreachable(list.transportError);
    if (list.status !== 200) return apiError(list.json, `failed to list ${provider} OAuth accounts`, list.status);
    const target = resolveTarget(list.json?.accounts, requested);
    if ("error" in target) {
      console.error(`Error: ${target.error}`);
      return 1;
    }
    accountId = target.id;
  }
  const response = await apiJson(deps, baseUrl, "POST", "/api/oauth/accounts/probe", { provider, ...(accountId ? { accountId } : {}) });
  if (response.status === 0) return proxyUnreachable(response.transportError);
  if (response.status !== 200) return apiError(response.json, `failed to probe ${provider} accounts`, response.status);
  const results = Array.isArray(response.json?.results) ? response.json.results as ProbeRow[] : [];
  if (wantsJson) console.log(JSON.stringify(response.json, null, 2));
  else if (results.length === 0) console.log(`${provider}: no stored accounts`);
  else for (const row of results) console.log(rowLine(row));
  return 0;
}
