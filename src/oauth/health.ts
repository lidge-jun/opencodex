import { getCodexAccountHealthSnapshot, type CodexCooldownSource } from "../codex/routing";
import { getAnthropicAccountHealthSnapshot } from "./anthropic-routing";
import { isAccountNeedsReauth } from "../codex/account-runtime-state";
import { getCodexAccountCredential, listCodexAccountIds } from "../codex/account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/main-account";
import { readRuntimePort } from "../config/process-state";
import { LOCAL_MANAGEMENT_READ_PATHS } from "../lib/local-management-capability";
import { maskAccountId } from "../lib/privacy";
import { findLiveProxy } from "../server/proxy-liveness";
import { fetchBoundLocalManagementRead } from "../server/local-management-read-client";
import { loadAuthStore, peekAuthStore, peekOAuthRefreshIntent, readOAuthRefreshIntent } from "./store";
import type { ProviderAccount } from "./types";

export type OAuthAccountHealth =
  | { status: "healthy" }
  | { status: "cooldown"; until: string; reason: "rate_limit" | "quota" }
  | { status: "reauth_required"; reason: "unauthorized" | "forbidden" | "refresh_failed" }
  | { status: "warning"; reason: "refresh_conflict" | "metadata_mismatch" | "stale_credentials" };

export type OAuthHealthLabel =
  | "Healthy"
  | "Rate limited"
  | "Quota limited"
  | "Reauthentication required"
  | "Refresh failed"
  | "Metadata mismatch"
  | "Credential conflict";

/** Shared masked-id fallback when `maskAccountId` returns nullish. */
export const MASKED_ACCOUNT_FALLBACK = "account-…????";

export type OAuthHealthEntry = {
  provider: string;
  accountId: string;
  health: OAuthAccountHealth;
  action?: string;
};

export type OAuthAccountHealthFields = {
  health: OAuthAccountHealth;
  healthLabel: OAuthHealthLabel;
  healthSummary: string;
  healthAction?: string;
};

export type CollectOAuthHealthOptions = {
  /** Skip chmod/backup side effects when reading credential files (doctor/status). */
  observeOnly?: boolean;
  /**
   * When true (default), include Codex entries from this process's in-memory maps.
   * CLI surfaces should prefer {@link collectOAuthHealthEntriesForCli} which queries the live proxy.
   */
  includeLocalCodex?: boolean;
};

type OAuthWarningReason = "refresh_conflict" | "metadata_mismatch" | "stale_credentials";

export function projectOAuthAccountHealth(input: {
  needsReauth?: boolean;
  reauthReason?: "unauthorized" | "forbidden" | "refresh_failed";
  cooldownUntilMs?: number;
  cooldownReason?: "rate_limit" | "quota";
  warningReason?: OAuthWarningReason;
  now?: number;
}): OAuthAccountHealth {
  const now = input.now ?? Date.now();
  if (input.needsReauth) {
    return { status: "reauth_required", reason: input.reauthReason ?? "refresh_failed" };
  }
  if (
    typeof input.cooldownUntilMs === "number"
    && Number.isFinite(input.cooldownUntilMs)
    && input.cooldownUntilMs > now
  ) {
    return {
      status: "cooldown",
      until: new Date(input.cooldownUntilMs).toISOString(),
      reason: input.cooldownReason ?? "quota",
    };
  }
  if (input.warningReason) {
    return { status: "warning", reason: input.warningReason };
  }
  return { status: "healthy" };
}

/** Codex pool accounts are not a public `ocx login` provider; reauth is dashboard-driven. */
export const CODEX_REAUTH_ACTION = "reauthenticate via the dashboard Codex account pool";

function actionFor(provider: string, health: OAuthAccountHealth): string | undefined {
  if (health.status === "reauth_required") {
    if (provider === "codex") return CODEX_REAUTH_ACTION;
    return `run \`ocx login ${provider}\``;
  }
  if (health.status === "cooldown") {
    // Keep the transported deadline machine-readable (ISO); presentation layers localize/format.
    return `wait until ${health.until} or start a new session with another eligible account`;
  }
  if (health.status === "warning" && health.reason === "refresh_conflict") {
    return "re-run `ocx doctor` after ensuring only one proxy process writes the credential store";
  }
  return undefined;
}

export function oauthHealthLabel(health: OAuthAccountHealth): OAuthHealthLabel {
  switch (health.status) {
    case "healthy":
      return "Healthy";
    case "cooldown":
      return health.reason === "rate_limit" ? "Rate limited" : "Quota limited";
    case "reauth_required":
      return health.reason === "refresh_failed" ? "Refresh failed" : "Reauthentication required";
    case "warning":
      switch (health.reason) {
        case "refresh_conflict":
          return "Credential conflict";
        case "metadata_mismatch":
          return "Metadata mismatch";
        case "stale_credentials":
          return "Refresh failed";
      }
  }
}

function displayAccountForHealth(accountId: string): string {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return "main account";
  return maskAccountId(accountId) ?? MASKED_ACCOUNT_FALLBACK;
}

export function oauthHealthSummary(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
  action?: string,
): string {
  const masked = displayAccountForHealth(accountId);
  let summary: string;
  switch (health.status) {
    case "healthy":
      summary = `${provider} ${masked}: healthy`;
      break;
    case "cooldown": {
      const why = health.reason === "rate_limit" ? "rate limited" : "quota limited";
      summary = `${provider} ${masked}: ${why} until ${health.until}. Routing for this account is paused until then.`;
      break;
    }
    case "reauth_required":
      summary = `${provider} ${masked}: reauthentication required (${health.reason.replaceAll("_", " ")}).`;
      break;
    case "warning":
      summary = `${provider} ${masked}: ${health.reason.replaceAll("_", " ")}.`;
      break;
  }
  if (action && health.status !== "healthy") {
    return `${summary} Next: ${action}`;
  }
  return summary;
}

export function oauthAccountHealthFields(
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): OAuthAccountHealthFields {
  const action = actionFor(provider, health);
  return {
    health,
    healthLabel: oauthHealthLabel(health),
    healthSummary: oauthHealthSummary(provider, accountId, health, action),
    ...(action ? { healthAction: action } : {}),
  };
}

export function projectStoredOAuthAccountHealth(
  provider: string,
  account: ProviderAccount,
  now = Date.now(),
  opts: { observeOnly?: boolean } = {},
): OAuthAccountHealth {
  const anthropicSnap = provider === "anthropic"
    ? getAnthropicAccountHealthSnapshot(account.id, now)
    : null;
  return projectOAuthAccountHealth({
    needsReauth: account.needsReauth === true,
    reauthReason: account.needsReauth === true ? "refresh_failed" : undefined,
    cooldownUntilMs: anthropicSnap?.cooldownUntil,
    cooldownReason: anthropicSnap?.cooldownSource === "retry-after" ? "rate_limit" : anthropicSnap ? "quota" : undefined,
    warningReason: detectOAuthWarning(provider, account, opts.observeOnly === true, now),
    now,
  });
}

export function projectCodexAccountHealth(input: {
  accountId: string;
  needsReauth: boolean;
  now?: number;
}): OAuthAccountHealth {
  const now = input.now ?? Date.now();
  const snap = getCodexAccountHealthSnapshot(input.accountId, now);
  return projectOAuthAccountHealth({
    needsReauth: input.needsReauth,
    reauthReason: input.needsReauth ? "refresh_failed" : undefined,
    cooldownUntilMs: snap?.cooldownUntil,
    cooldownReason: cooldownReasonFromSource(snap?.cooldownSource),
    now,
  });
}

/**
 * Incomplete credentials warning. Kiro may intentionally store an empty refresh
 * when authenticated via KIRO_ACCESS_TOKEN or a pasted access-only token, as long
 * as the access token is still unexpired.
 */
export function detectOAuthWarning(
  provider: string,
  account: ProviderAccount,
  observeOnly = false,
  now = Date.now(),
): OAuthWarningReason | undefined {
  const intent = observeOnly
    ? peekOAuthRefreshIntent(provider, account.id)
    : readOAuthRefreshIntent(provider, account.id);
  if (intent?.uncertain) return "refresh_conflict";
  const cred = account.credential;
  if (!cred?.access) return "stale_credentials";
  if (!cred.refresh) {
    if (
      provider === "kiro"
      && typeof cred.expires === "number"
      && Number.isFinite(cred.expires)
      && cred.expires > now
    ) {
      return undefined;
    }
    return "stale_credentials";
  }
  return undefined;
}

function cooldownReasonFromSource(
  source: CodexCooldownSource | undefined,
): "rate_limit" | "quota" | undefined {
  if (!source) return undefined;
  return source === "retry-after" ? "rate_limit" : "quota";
}

function pushEntry(
  entries: OAuthHealthEntry[],
  provider: string,
  accountId: string,
  health: OAuthAccountHealth,
): void {
  const action = actionFor(provider, health);
  entries.push({
    provider,
    accountId,
    health,
    ...(action ? { action } : {}),
  });
}

function collectLocalCodexEntries(now: number): OAuthHealthEntry[] {
  const entries: OAuthHealthEntry[] = [];
  const codexIds = new Set(listCodexAccountIds());
  codexIds.add(MAIN_CODEX_ACCOUNT_ID);
  for (const accountId of codexIds) {
    const snap = getCodexAccountHealthSnapshot(accountId, now);
    const needsReauth = isAccountNeedsReauth(accountId);
    const hasPoolCredential = accountId !== MAIN_CODEX_ACCOUNT_ID && getCodexAccountCredential(accountId) !== null;
    if (!hasPoolCredential && !needsReauth && !snap) continue;

    const health = projectOAuthAccountHealth({
      needsReauth,
      reauthReason: needsReauth ? "refresh_failed" : undefined,
      cooldownUntilMs: snap?.cooldownUntil,
      cooldownReason: cooldownReasonFromSource(snap?.cooldownSource),
      now,
    });
    pushEntry(entries, "codex", accountId, health);
  }
  return entries;
}

export function collectOAuthHealthEntries(
  now = Date.now(),
  opts: CollectOAuthHealthOptions = {},
): OAuthHealthEntry[] {
  const observeOnly = opts.observeOnly === true;
  const includeLocalCodex = opts.includeLocalCodex !== false;
  const entries: OAuthHealthEntry[] = [];
  const store = observeOnly ? peekAuthStore() : loadAuthStore();

  for (const [provider, set] of Object.entries(store)) {
    for (const account of set.accounts) {
      const health = projectStoredOAuthAccountHealth(provider, account, now, { observeOnly });
      pushEntry(entries, provider, account.id, health);
    }
  }

  if (includeLocalCodex) {
    for (const entry of collectLocalCodexEntries(now)) entries.push(entry);
  }

  return entries;
}

type ProxyCodexAccountHealth = {
  id: string;
  health?: OAuthAccountHealth;
  needsReauth?: boolean;
};

const KNOWN_HEALTH_STATUSES = new Set(["healthy", "cooldown", "reauth_required", "warning"]);

function coerceRemoteAccountHealth(
  account: ProxyCodexAccountHealth,
): OAuthAccountHealth {
  const raw = account.health;
  if (raw && typeof raw === "object" && KNOWN_HEALTH_STATUSES.has((raw as { status?: string }).status ?? "")) {
    return raw;
  }
  return projectOAuthAccountHealth({ needsReauth: account.needsReauth === true });
}

type LiveProxyCodexHealthResult = {
  source: CodexHealthSource;
  entries: OAuthHealthEntry[] | null;
};

async function fetchCodexHealthFromLiveProxy(
  fetchImpl: typeof fetch | undefined = undefined,
  findLiveProxyImpl: typeof findLiveProxy = findLiveProxy,
  readRuntimePortImpl: typeof readRuntimePort = readRuntimePort,
): Promise<LiveProxyCodexHealthResult> {
  const live = await findLiveProxyImpl();
  if (!live) return { source: "unavailable", entries: null };
  try {
    const read = await fetchBoundLocalManagementRead(
      live,
      LOCAL_MANAGEMENT_READ_PATHS.codexAccounts,
      { fetchImpl, readRuntime: readRuntimePortImpl, timeoutMs: 4_000 },
    );
    if (read.kind === "unavailable") {
      return { source: "management-api-unavailable", entries: null };
    }
    const res = read.response;
    if (res.status === 401 || res.status === 403) {
      return { source: "management-auth-failed", entries: null };
    }
    if (!res.ok) return { source: "management-api-unavailable", entries: null };
    const json = await res.json() as { accounts?: ProxyCodexAccountHealth[] };
    if (!Array.isArray(json.accounts)) return { source: "management-api-unavailable", entries: null };
    const entries: OAuthHealthEntry[] = [];
    for (const account of json.accounts) {
      if (!account?.id || typeof account.id !== "string") continue;
      pushEntry(entries, "codex", account.id, coerceRemoteAccountHealth(account));
    }
    return { source: "management-api", entries };
  } catch {
    return { source: "management-api-unavailable", entries: null };
  }
}

/** How CLI/doctor obtained Codex cooldown/reauth (proxy memory only lives in the proxy). */
export type CodexHealthSource =
  | "management-api"
  | "unavailable"
  | "management-auth-failed"
  | "management-api-unavailable";

export type OAuthCliHealthReport = {
  entries: OAuthHealthEntry[];
  codexHealthSource: CodexHealthSource;
};

/** Shown by `ocx status` / `ocx doctor` when the proxy management API is unreachable. */
export const CODEX_HEALTH_UNAVAILABLE_NOTE =
  "Codex health: unavailable (proxy not running; live cooldown/reauth requires the management API)";
export const CODEX_HEALTH_AUTH_FAILED_NOTE =
  "Codex health: unavailable (proxy running; management authentication failed)";
export const CODEX_HEALTH_MANAGEMENT_API_UNAVAILABLE_NOTE =
  "Codex health: unavailable (proxy running; management API did not return account health)";

/**
 * CLI/doctor collector: observe-only OAuth store reads, and Codex health only from the
 * running proxy management API. Never reads proxy process-local maps from the CLI process.
 */
export async function collectOAuthHealthEntriesForCli(
  now = Date.now(),
  deps: {
    fetchImpl?: typeof fetch;
    findLiveProxyImpl?: typeof findLiveProxy;
    readRuntimePortImpl?: typeof readRuntimePort;
  } = {},
): Promise<OAuthCliHealthReport> {
  const entries = collectOAuthHealthEntries(now, { observeOnly: true, includeLocalCodex: false });
  const remote = await fetchCodexHealthFromLiveProxy(
    deps.fetchImpl,
    deps.findLiveProxyImpl,
    deps.readRuntimePortImpl,
  );
  if (remote.entries) {
    for (const entry of remote.entries) entries.push(entry);
    return { entries, codexHealthSource: "management-api" };
  }
  return { entries, codexHealthSource: remote.source };
}
