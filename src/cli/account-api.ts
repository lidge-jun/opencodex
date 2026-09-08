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
import { projectCodexQuotaRefreshOutcome, type CodexQuotaRefreshOutcome } from "../codex/quota-refresh-outcome";

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
  /** Codex pool selection order, higher used earlier. Absent where ordering does not apply. */
  priority?: number;
  quota?: CodexQuotaDto | null;
  quotaRefresh?: CodexQuotaRefreshOutcome;
  /**
   * Whether the pool is holding this account out of rotation.
   *
   * The server has always sent it (auth-api.ts:286 for pool accounts, :1315 for main) and the
   * CLI dropped it, so a paused account was indistinguishable from an available one in every
   * human listing (#2703).
   */
  paused?: boolean;
}

export type ClassifyResult = { type: AccountType } | { error: string };

export type AccountStdin = NodeJS.ReadableStream & { isTTY?: boolean };

export interface NativeMainLoginChild {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface StageLeaseClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface AccountDeps {
  /** Test injection: skip findLiveProxy and call the API at this base URL. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  loadConfigImpl?: () => OcxConfig;
  stdinImpl?: AccountStdin;
  stdinTimeoutMs?: number;
  /** Internal test seam for the account-import POST; production is capped at ten minutes. */
  importTimeoutMs?: number;
  /** Test/platform injection for the official Codex login in a restricted staging home. */
  spawnCodexLoginImpl?: (codexHome: string) => NativeMainLoginChild;
  /** Legacy test seam. Production always uses the spawned child handle above. */
  runCodexLoginImpl?: (codexHome: string) => Promise<number>;
  /** Test-only heartbeat cadence floor. Production keeps the five-second floor. */
  stageHeartbeatIntervalMinMs?: number;
  /** Test-only clock for deterministic native-profile lease deadline coverage. */
  stageLeaseClock?: StageLeaseClock;
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
  /**
   * Message from the thrown transport error when `status` is 0. Previously the
   * error was swallowed by a catch block with an empty body, so an unreachable proxy, a DNS
   * failure and a TLS error were indistinguishable (#2698).
   */
  transportError?: string;
}

export async function apiJson(
  deps: AccountDeps,
  baseUrl: string,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  options: { signal?: AbortSignal } = {},
): Promise<ApiResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: runningProxyUpdateHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  } catch (error) {
    // status 0 stays the transport sentinel, but keep the cause: callers can now
    // tell the operator why the request never reached the proxy (#2698).
    return {
      status: 0,
      json: {},
      transportError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resolveBaseUrl(deps: AccountDeps): Promise<string | null> {
  if (deps.baseUrl) return deps.baseUrl;
  const live = await findLiveProxy();
  if (!live) return null;
  return `http://${probeHostname(live.hostname)}:${live.port}`;
}

export function proxyUnreachable(transportError?: string): number {
  console.error("Proxy not reachable. Start it with 'ocx start' or 'ocx ensure'.");
  // Naming the transport cause distinguishes "nothing is listening" from a refused
  // or reset connection, which is what made #2696-class breakage undiagnosable.
  if (transportError) console.error(`reason: ${transportError}`);
  return 1;
}

function accountStringField(json: Record<string, unknown>, key: string): string | undefined {
  const value = json[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Report a failed management call from the account family.
 *
 * `reason` and `hint` are the actionable fields on a refusal — the management plane
 * sets both on a 503, and several routes return `reason` with no `error` key at all,
 * which used to print only the generic fallback (#2698).
 *
 * `status` selects the exit code so the account client speaks the same vocabulary as
 * runtime-api.ts: 4 for not-found, 5 for conflict, 1 otherwise. Previously every
 * failure exited 1, so a script could not distinguish a missing account from a
 * concurrent mutation.
 */
export function apiError(json: Record<string, unknown>, fallback: string, status: number): number {
  const primary = accountStringField(json, "error") ?? fallback;
  const lines = [`Error: ${primary}`];
  const reason = accountStringField(json, "reason");
  if (reason && reason !== primary) lines.push(`reason: ${reason}`);
  const hint = accountStringField(json, "hint");
  if (hint && hint !== primary) lines.push(`hint: ${hint}`);
  for (const line of lines) console.error(line);
  if (json.cleanupRequired === true) {
    console.error("Warning: native-login staging cleanup is still required; run 'ocx account main doctor'.");
  }
  return status === 404 ? 4 : status === 409 ? 5 : 1;
}

export interface FamilyRows {
  rows: AccountRow[];
  activeId: string | null;
  autoSwitchThreshold?: number;
  /** HTTP status for a completed family read, including failures. */
  status: number;
  /** Set when the family endpoint returned an error. */
  errorJson?: Record<string, unknown>;
  networkDown?: boolean;
  /** Transport cause when `networkDown` is set. Callers must forward this to `proxyUnreachable`. */
  transportError?: string;
}

export interface CodexQuotaDto {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  /**
   * Five-hour window, as the per-account provider probe reports it
   * (`/api/oauth/accounts?quota=1`). Distinct from `shortPercent`, which is the Codex pool's
   * self-declared burst window; the two surfaces name the same idea differently and both reach
   * this DTO.
   */
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  /** Sub-day burst window, when upstream declares one (#1791). */
  shortPercent?: number;
  shortResetAt?: number;
  shortWindowSeconds?: number;
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
  alias?: string;
  email?: string;
  plan?: string;
  isMain?: boolean;
  needsReauth?: boolean;
  priority?: number;
  quota?: CodexQuotaDto | null;
  quotaRefresh?: unknown;
  paused?: boolean;
}

function projectQuota(quota: CodexQuotaDto | null | undefined): CodexQuotaDto | null {
  if (!quota) return null;
  const projected: CodexQuotaDto = {};
  // `fiveHourPercent`/`fiveHourResetAt` were declared on the DTO and read by two renderers
  // -- `quotaText`'s `quota.fiveHourPercent ?? quota.shortPercent` (account.ts:89) and
  // `quotaParts` (account-extended.ts:275) -- but omitted from this whitelist, so the first
  // operand was unreachable and a 5h-only account rendered as unknown (#2703). A projection
  // that silently drops a field its own type declares is worse than one that never had it:
  // the type checks, the renderer looks correct, and only the output is wrong.
  for (const key of ["fiveHourPercent", "fiveHourResetAt", "weeklyPercent", "monthlyPercent", "weeklyResetAt", "monthlyResetAt", "shortPercent", "shortResetAt", "shortWindowSeconds"] as const) {
    if (typeof quota[key] === "number" && Number.isFinite(quota[key])) projected[key] = quota[key];
  }
  return projected;
}

export async function fetchCodexRows(
  deps: AccountDeps,
  baseUrl: string,
  forceRefresh = false,
  includeQuota = forceRefresh,
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
    return {
      rows: [],
      activeId: null,
      status: 0,
      networkDown: true,
      transportError: accountsRes.transportError ?? activeRes.transportError,
    };
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
    label: a.alias ?? a.plan ?? a.email,
    email: a.email,
    plan: a.plan,
    active: a.id === activeId,
    needsReauth: a.needsReauth,
    priority: typeof a.priority === "number" ? a.priority : 0,
    paused: a.paused === true,
    ...(includeQuota ? {
      quota: projectQuota(a.quota),
      quotaRefresh: projectCodexQuotaRefreshOutcome(a.quotaRefresh),
    } : {}),
  }));
  return { rows, activeId, autoSwitchThreshold, status: 200 };
}

interface OAuthAccountDto {
  id: string;
  alias?: string;
  email?: string;
  active?: boolean;
  needsReauth?: boolean;
  quota?: CodexQuotaDto | null;
  quotaUnavailable?: boolean;
}

async function fetchOAuthRows(
  deps: AccountDeps,
  baseUrl: string,
  name: string,
  quota?: { refresh?: boolean },
): Promise<FamilyRows> {
  // Quota is opt-in: the server probes the upstream once per stored credential when `quota=1`
  // is present, so the default listing must stay a cheap local read (#2566).
  const query = quota
    ? `?provider=${encodeURIComponent(name)}&quota=1${quota.refresh ? "&refresh=1" : ""}`
    : `?provider=${encodeURIComponent(name)}`;
  const res = await apiJson(deps, baseUrl, "GET", `/api/oauth/accounts${query}`);
  if (res.status === 0) {
    return { rows: [], activeId: null, status: 0, networkDown: true, transportError: res.transportError };
  }
  if (res.status !== 200) return { rows: [], activeId: null, status: res.status, errorJson: res.json };
  const activeId = typeof res.json.activeAccountId === "string" ? res.json.activeAccountId : null;
  const accounts = Array.isArray(res.json.accounts) ? res.json.accounts as OAuthAccountDto[] : [];
  const rows = accounts.map((a, i) => ({
    provider: name,
    type: "oauth" as const,
    id: a.id,
    label: a.alias ?? a.email ?? `Account ${i + 1}`,
    email: a.email,
    active: a.active ?? a.id === activeId,
    needsReauth: a.needsReauth,
    ...(a.quota !== undefined ? { quota: a.quota } : {}),
    ...(a.quotaUnavailable !== undefined ? { quotaUnavailable: a.quotaUnavailable } : {}),
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
  if (res.status === 0) {
    return { rows: [], activeId: null, status: 0, networkDown: true, transportError: res.transportError };
  }
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

export function fetchRows(
  deps: AccountDeps,
  baseUrl: string,
  name: string,
  type: AccountType,
  quota?: { refresh?: boolean },
): Promise<FamilyRows> {
  if (type === "codex") return fetchCodexRows(deps, baseUrl, Boolean(quota?.refresh), quota !== undefined);
  if (type === "oauth") return fetchOAuthRows(deps, baseUrl, name, quota);
  return fetchKeyRows(deps, baseUrl, name);
}

export async function fetchProviderQuotaReport(
  deps: AccountDeps,
  baseUrl: string,
  name: string,
): Promise<{ status: number; report: ProviderQuotaReportDto | null; errorJson?: Record<string, unknown>; transportError?: string }> {
  const res = await apiJson(deps, baseUrl, "GET", "/api/provider-quotas?refresh=1");
  if (res.status === 0) {
    return { status: 0, report: null, errorJson: res.json, transportError: res.transportError };
  }
  if (res.status !== 200) return { status: res.status, report: null, errorJson: res.json };
  const reports = Array.isArray(res.json.reports) ? res.json.reports as ProviderQuotaReportDto[] : [];
  return { status: 200, report: reports.find(report => report?.provider === name) ?? null };
}
