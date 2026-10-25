import type { ProviderQuotaReportView } from "./provider-workspace/report";

const PROVIDER = "meta-muse";
const MAX_RESET_DELAY_MS = 8 * 24 * 60 * 60_000;

export function formatMuseResetCountdown(resetAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((resetAt - now) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, "0")).join(":");
}

/** A quota refusal names a reset clock but does not identify its window as 5h or weekly. */
export function museLimitReport(value: unknown, accountLabel: string, now = Date.now()): ProviderQuotaReportView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.provider !== PROVIDER || row.accountLogLabel !== accountLabel || row.status !== 429
    || row.errorCode !== "rate_limit_exceeded" || typeof row.timestamp !== "number"
    || !Number.isFinite(row.timestamp) || row.timestamp > now || typeof row.upstreamError !== "string") return null;
  const match = /^Subscription quota exhausted\. Your usage window resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\.$/.exec(row.upstreamError);
  if (!match) return null;
  const resetAt = Date.parse(match[1]!);
  if (!Number.isFinite(resetAt) || resetAt <= now || resetAt <= row.timestamp
    || resetAt - row.timestamp > MAX_RESET_DELAY_MS) return null;
  return {
    label: "Muse Code", source: "meta-muse:rate-limit-observation", observed: true, updatedAt: row.timestamp,
    quota: { customWindows: [{ label: "Muse Code", percent: 100, resetAt }], updatedAt: row.timestamp },
  };
}

/** Read local management evidence only. This must never submit or retry a model request. */
export async function withMuseLimitObservation(
  reports: Record<string, ProviderQuotaReportView>, apiBase: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, ProviderQuotaReportView>> {
  if (reports[PROVIDER]) return reports;
  try {
    const [providerResponse, accountResponse] = await Promise.all([
      fetchImpl(`${apiBase}/api/providers`, { signal }),
      fetchImpl(`${apiBase}/api/oauth/accounts?provider=${PROVIDER}`, { signal }),
    ]);
    if (!providerResponse.ok || !accountResponse.ok) return reports;
    const providers: unknown = await providerResponse.json();
    if (!Array.isArray(providers) || !providers.some(row => row?.name === PROVIDER
      && row.disabled !== true && row.authMode === "oauth" && row.baseUrl === "https://api.meta.ai/v1")) return reports;
    const accounts = await accountResponse.json() as { activeAccountId?: unknown; accounts?: Array<{ id?: unknown; paused?: boolean; needsReauth?: boolean }> };
    if (typeof accounts.activeAccountId !== "string" || !Array.isArray(accounts.accounts)) return reports;
    const active = accounts.accounts.find(row => row.id === accounts.activeAccountId);
    if (!active || active.paused || active.needsReauth) return reports;
    // The same public provider-scoped digest as src/codex/account-label.ts; no credentials.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${PROVIDER}\0${accounts.activeAccountId}`));
    const accountLabel = `o${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 6)}`;
    const response = await fetchImpl(`${apiBase}/api/logs?provider=${PROVIDER}&account=${accountLabel}&limit=1`, { signal });
    if (!response.ok) return reports;
    const body = await response.json() as { logs?: unknown[] };
    // Only the latest matching request can establish exhaustion. A newer successful turn wins.
    const observation = Array.isArray(body.logs) && body.logs.length === 1
      ? museLimitReport(body.logs[0], accountLabel) : null;
    return observation ? { ...reports, [PROVIDER]: observation } : reports;
  } catch {
    return reports;
  }
}
