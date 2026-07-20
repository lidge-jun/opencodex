/**
 * Data-access layer for `ocx account` (issue #180) — live-proxy HTTP client and
 * per-family account readers. Kept separate from account.ts (command handlers)
 * per the 400-line module budget.
 */
import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";
import { isPublicOAuthProvider } from "../oauth/index";
import { getProviderRegistryEntry, providerCodexAccountMode } from "../providers/registry";
import type { OcxConfig } from "../types";

export type AccountType = "codex" | "oauth" | "api-key";

export interface AccountRow {
  provider: string;
  type: AccountType;
  id: string;
  label?: string;
  email?: string;
  plan?: string;
  masked?: string;
  active: boolean;
  needsReauth?: boolean;
  quota?: CodexQuotaDto | null;
}

export type ClassifyResult = { type: AccountType } | { error: string };

export type AccountStdin = NodeJS.ReadableStream & { isTTY?: boolean };

export interface AccountDeps {
  /** Test injection: skip findLiveProxy and call the API at this base URL. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  loadConfigImpl?: () => OcxConfig;
  stdinImpl?: AccountStdin;
  stdinTimeoutMs?: number;
}

export function classifyAccount(config: OcxConfig, name: string): ClassifyResult {
  const provider = config.providers?.[name];
  if (providerCodexAccountMode(name, provider)) return { type: "codex" };
  const entry = getProviderRegistryEntry(name);
  if (entry?.authKind === "local") {
    return { error: `provider "${name}" is a local provider and has no credentials` };
  }
  if (provider?.authMode === "forward") {
    return { error: `provider "${name}" uses forward auth and has no switchable credentials` };
  }
  if (provider?.authMode === "key") return { type: "api-key" };
  if (provider && !provider.authMode && (provider.apiKey || (provider.apiKeyPool?.length ?? 0) > 0)) {
    return { type: "api-key" };
  }
  if (isPublicOAuthProvider(name)) return { type: "oauth" };
  if (provider) return { type: "api-key" };
  return { error: `unknown provider "${name}"` };
}

export interface ApiResult {
  /** 0 = network-level failure (proxy unreachable). */
  status: number;
  json: Record<string, unknown>;
}

export async function apiJson(
  deps: AccountDeps,
  baseUrl: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: runningProxyUpdateHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  } catch {
    return { status: 0, json: {} };
  }
}

export async function resolveBaseUrl(deps: AccountDeps): Promise<string | null> {
  if (deps.baseUrl) return deps.baseUrl;
  const live = await findLiveProxy();
  if (!live) return null;
  return `http://${probeHostname(live.hostname)}:${live.port}`;
}

export function proxyUnreachable(): number {
  console.error("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  return 1;
}

export function apiError(json: Record<string, unknown>, fallback: string): number {
  const message = typeof json.error === "string" ? json.error : fallback;
  console.error(`Error: ${message}`);
  return 1;
}

export interface FamilyRows {
  rows: AccountRow[];
  activeId: string | null;
  autoSwitchThreshold?: number;
  /** HTTP status for a completed family read, including failures. */
  status?: number;
  /** Set when the family endpoint returned an error. */
  errorJson?: Record<string, unknown>;
  networkDown?: boolean;
}

export interface CodexQuotaDto {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
}

export interface ProviderQuotaWindowDto {
  label: string;
  percent: number;
  resetAt?: number;
}

export interface ProviderQuotaDto extends CodexQuotaDto {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  customWindows?: ProviderQuotaWindowDto[];
  updatedAt?: number;
}

export interface ProviderQuotaReportDto {
  provider: string;
  label?: string;
  source?: string;
  quota: ProviderQuotaDto;
  updatedAt?: number;
  reverseEngineered?: boolean;
}

interface CodexAccountDto {
  id: string;
  email?: string;
  plan?: string;
  isMain?: boolean;
  needsReauth?: boolean;
  quota?: CodexQuotaDto | null;
}

function projectQuota(quota: CodexQuotaDto | null | undefined): CodexQuotaDto | null {
  if (!quota) return null;
  const projected: CodexQuotaDto = {};
  for (const key of ["weeklyPercent", "monthlyPercent", "weeklyResetAt", "monthlyResetAt"] as const) {
    if (typeof quota[key] === "number" && Number.isFinite(quota[key])) projected[key] = quota[key];
  }
  return projected;
}

export async function fetchCodexRows(
  deps: AccountDeps,
  baseUrl: string,
  forceRefresh = false,
): Promise<FamilyRows> {
  const accountsPath = `/api/codex-auth/accounts${forceRefresh ? "?refresh=1" : ""}`;
  const [accountsRes, activeRes] = await Promise.all([
    apiJson(deps, baseUrl, "GET", accountsPath),
    apiJson(deps, baseUrl, "GET", "/api/codex-auth/active"),
  ]);
  if (accountsRes.status !== 0 && accountsRes.status !== 200) {
    return { rows: [], activeId: null, status: accountsRes.status, errorJson: accountsRes.json };
  }
  if (activeRes.status !== 0 && activeRes.status !== 200) {
    return { rows: [], activeId: null, status: activeRes.status, errorJson: activeRes.json };
  }
  if (accountsRes.status === 0 || activeRes.status === 0) {
    return { rows: [], activeId: null, status: 0, networkDown: true };
  }
  const activeId = typeof activeRes.json.activeCodexAccountId === "string"
    ? activeRes.json.activeCodexAccountId
    : null;
  const autoSwitchThreshold = typeof activeRes.json.autoSwitchThreshold === "number"
    ? activeRes.json.autoSwitchThreshold
    : undefined;
  const accounts = Array.isArray(accountsRes.json.accounts) ? accountsRes.json.accounts as CodexAccountDto[] : [];
  const rows = accounts.map(a => ({
    provider: "openai",
    type: "codex" as const,
    id: a.id,
    label: a.plan ?? a.email,
    email: a.email,
    plan: a.plan,
    active: a.id === activeId,
    needsReauth: a.needsReauth,
    ...(forceRefresh ? { quota: projectQuota(a.quota) } : {}),
  }));
  return { rows, activeId, autoSwitchThreshold, status: 200 };
}

interface OAuthAccountDto {
  id: string;
  email?: string;
  active?: boolean;
  needsReauth?: boolean;
}

async function fetchOAuthRows(deps: AccountDeps, baseUrl: string, name: string): Promise<FamilyRows> {
  const res = await apiJson(deps, baseUrl, "GET", `/api/oauth/accounts?provider=${encodeURIComponent(name)}`);
  if (res.status === 0) return { rows: [], activeId: null, status: 0, networkDown: true };
  if (res.status !== 200) return { rows: [], activeId: null, status: res.status, errorJson: res.json };
  const activeId = typeof res.json.activeAccountId === "string" ? res.json.activeAccountId : null;
  const accounts = Array.isArray(res.json.accounts) ? res.json.accounts as OAuthAccountDto[] : [];
  const rows = accounts.map((a, i) => ({
    provider: name,
    type: "oauth" as const,
    id: a.id,
    label: a.email ?? `Account ${i + 1}`,
    email: a.email,
    active: a.active ?? a.id === activeId,
    needsReauth: a.needsReauth,
  }));
  return { rows, activeId, status: 200 };
}

interface ApiKeyDto {
  id: string;
  label?: string;
  masked?: string;
  active?: boolean;
}

async function fetchKeyRows(deps: AccountDeps, baseUrl: string, name: string): Promise<FamilyRows> {
  const res = await apiJson(deps, baseUrl, "GET", `/api/providers/keys?name=${encodeURIComponent(name)}`);
  if (res.status === 0) return { rows: [], activeId: null, status: 0, networkDown: true };
  if (res.status !== 200) return { rows: [], activeId: null, status: res.status, errorJson: res.json };
  const activeId = typeof res.json.activeId === "string" ? res.json.activeId : null;
  const keys = Array.isArray(res.json.keys) ? res.json.keys as ApiKeyDto[] : [];
  const rows = keys.map(k => ({
    provider: name,
    type: "api-key" as const,
    id: k.id,
    label: k.label ?? k.masked,
    masked: k.masked,
    active: k.active ?? k.id === activeId,
  }));
  return { rows, activeId, status: 200 };
}

export function fetchRows(deps: AccountDeps, baseUrl: string, name: string, type: AccountType): Promise<FamilyRows> {
  if (type === "codex") return fetchCodexRows(deps, baseUrl);
  if (type === "oauth") return fetchOAuthRows(deps, baseUrl, name);
  return fetchKeyRows(deps, baseUrl, name);
}

export async function fetchProviderQuotaReport(
  deps: AccountDeps,
  baseUrl: string,
  name: string,
): Promise<{ status: number; report: ProviderQuotaReportDto | null; errorJson?: Record<string, unknown> }> {
  const res = await apiJson(deps, baseUrl, "GET", "/api/provider-quotas?refresh=1");
  if (res.status !== 200) return { status: res.status, report: null, errorJson: res.json };
  const reports = Array.isArray(res.json.reports) ? res.json.reports as ProviderQuotaReportDto[] : [];
  return { status: 200, report: reports.find(report => report?.provider === name) ?? null };
}
