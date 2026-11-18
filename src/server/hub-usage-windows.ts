import type { OcxConfig } from "../types";
import { authorizationCredential } from "../lib/authorization-scheme";
import { getCachedProviderAccountQuota, hydrateAccountQuotaCache } from "../providers/quota/account-cache";
import { getAccountSet } from "../oauth/store";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers-destination";
import { isSelectableCodexPoolAccount } from "../codex/account-id";
import { readCodexAccountRecord } from "../codex/account-store";
import { getAccountQuota, getAccountQuotaHistory } from "../codex/quota";
import { resetAtToMs } from "../codex/quota-types";
import { resolveAdmissionModelScope } from "./admission-model-scope";
import { isAllowedRequestOrigin, resolveDataPlaneAdmissionSecret, withCors, type RequestPolicyView } from "./auth-cors";

interface UsageWindow {
  label: string;
  provider: string;
  percent: number;
  limited: boolean;
  /** Epoch milliseconds. */
  resetsAt: number;
}

const LABEL_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const CUSTOM_WINDOW_LABELS = new Map<string, readonly string[]>([
  ["cursor", ["First-party models", "API usage"]],
  ["devin", ["Daily"]],
  ["google-antigravity", ["Gem", "Gem (Weekly)", "Cla", "Cla (Weekly)"]],
]);

function knownCustomLabel(provider: string, label: string): string | undefined {
  const normalized = label.replace(LABEL_CONTROL_CHARS, "").trim();
  return CUSTOM_WINDOW_LABELS.get(provider)?.find(known => known === normalized);
}

function collectWindow(
  windows: Map<string, UsageWindow>,
  provider: string,
  label: string,
  used: number | undefined,
  resetsAt: number | undefined,
  rejected = false,
): void {
  if (typeof used !== "number" || !Number.isFinite(used)) return;
  if (typeof resetsAt !== "number" || resetsAt <= Date.now() || !Number.isFinite(new Date(resetsAt).getTime())) return;
  const percent = Math.min(100, Math.max(0, used));
  const limited = rejected || percent === 100;
  const previous = windows.get(label);
  if (!previous || percent > previous.percent) {
    windows.set(label, { label: `${provider} ${label}`, provider, percent, limited: limited || previous?.limited === true, resetsAt });
  } else if (limited) {
    previous.limited = true;
  }
}

const CODEX_WINDOW_LABELS = [
  ["short", "5-hour"], ["weekly", "Weekly"], ["monthly", "Monthly"],
] as const;

function collectCodexWindows(windows: Map<string, UsageWindow>, id: string): void {
  const quota = getAccountQuota(id);
  if (!quota) return;
  // The display cache carries bars forward across partial updates. Require a
  // matching observation owned by this account's current credential identity.
  const { observations } = getAccountQuotaHistory(id);
  const newestFirst = observations.reverse().flatMap(sample => sample.windows);
  for (const [slot, label] of CODEX_WINDOW_LABELS) {
    const reset = quota[`${slot}ResetAt`];
    const percent = quota[`${slot}Percent`];
    if (reset === undefined || percent === undefined) continue;
    const resetMs = resetAtToMs(reset);
    const observed = newestFirst.find(window => window.family === "account" && window.window === slot);
    if (observed?.usedPercent === percent && observed.resetAtMs === resetMs) {
      collectWindow(windows, "ChatGPT", label, percent, resetMs);
    }
  }
}

/** Project cached quota for a single upstream account selected by the authenticated key's scope. */
export function handleHubUsageWindows(req: Request, config: OcxConfig, policy: RequestPolicyView): Response {
  const reply = (body: unknown, status = 200) => withCors(Response.json(body, {
    status, headers: { "cache-control": "no-store" },
  }), req, policy);
  const error = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const dedicated = req.headers.get("x-opencodex-api-key")?.trim();
  const token = dedicated || authorizationCredential(req.headers) || "";
  const admission = resolveDataPlaneAdmissionSecret(token, config, dedicated ? "dedicated" : "bearer", {
    linkIngress: policy.linkIngress?.allowedKeyIds,
  });
  const scope = admission?.kind === "configured" ? resolveAdmissionModelScope(config, admission) : undefined;
  const [provider] = scope?.providers ?? [];
  if (!provider || scope?.providers.length !== 1 || scope.models.length !== 0 || scope.allOf) {
    return error("usage_windows_unauthorized", "A configured client key scoped to one provider and all its models is required", 401);
  }
  if (!isAllowedRequestOrigin(req, policy)) return error("origin_rejected", "Cross-origin request blocked", 403);
  if (config.runtimeRole !== "hub") return error("usage_windows_not_a_hub", "Usage windows are served only by a hub", 404);
  const matchingProviders = Object.entries(config.providers).filter(([name]) => name.trim().toLowerCase() === provider);
  if (matchingProviders.length !== 1) return reply({ windows: [] });
  const [providerName, providerConfig] = matchingProviders[0]!;
  if (providerConfig.disabled === true) return reply({ windows: [] });

  // Count registered candidates before reading any cache. An empty cache for a
  // second account is no evidence that the key owns just one account.
  const ambiguousAccount = () => error("usage_windows_account_scope_required", "Usage windows require a single upstream account", 403);
  const windows = new Map<string, UsageWindow>();
  if (providerName === OPENAI_CODEX_PROVIDER_ID && isCanonicalOpenAiForwardProvider(providerConfig)) {
    if (providerConfig.codexAccountMode === "direct") return reply({ windows: [] });
    const pool = (config.codexAccounts ?? []).filter(isSelectableCodexPoolAccount);
    if (pool.length > 1) return ambiguousAccount();
    const account = pool[0];
    if (!account) return reply({ windows: [] });
    const record = readCodexAccountRecord(account.id);
    if (!record?.credential || record.deletedAt != null || record.codexValidationPending) return reply({ windows: [] });
    collectCodexWindows(windows, account.id);
  } else {
    const accounts = getAccountSet(providerName)?.accounts ?? [];
    if (accounts.length > 1) return ambiguousAccount();
    const account = accounts[0];
    if (!account) return reply({ windows: [] });
    hydrateAccountQuotaCache();
    const quota = getCachedProviderAccountQuota(providerName, account.id);
    if (!quota) return reply({ windows: [] });
    const name = providerName.charAt(0).toUpperCase() + providerName.slice(1);
    collectWindow(windows, name, "5-hour", quota.fiveHourPercent, quota.fiveHourResetAt);
    collectWindow(windows, name, "Weekly", quota.weeklyPercent, quota.weeklyResetAt);
    collectWindow(windows, name, "Monthly", quota.monthlyPercent, quota.monthlyResetAt);
    const customWindows = (quota.customWindows ?? []).flatMap(custom => {
      if (custom.scope === "model" || custom.modelId !== undefined) return [];
      const label = knownCustomLabel(provider, custom.label);
      return label ? [{ ...custom, label }] : [];
    });
    for (const custom of customWindows.sort((a, b) => a.label.localeCompare(b.label))) {
      collectWindow(windows, name, custom.label, custom.percent, custom.resetAt, custom.rejected);
    }
  }
  return reply({ windows: [...windows.values()] });
}
