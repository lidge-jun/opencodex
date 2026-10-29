import { accountQuotaFromReport, type ProviderQuotaReportView } from "./provider-workspace/report";

const PROVIDER = "meta-muse";
const OBSERVATION_SOURCE = "meta-muse:rate-limit-observation";
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

/** Reset time of a locally observed Muse refusal; native Muse reports are never treated as observations. */
export function museObservationResetAt(reports: Record<string, ProviderQuotaReportView>): number | undefined {
  const report = reports[PROVIDER];
  if (report?.source !== OBSERVATION_SOURCE) return undefined;
  const resetAt = accountQuotaFromReport(report)?.customWindows?.[0]?.resetAt;
  return typeof resetAt === "number" && Number.isFinite(resetAt) ? resetAt : undefined;
}

/** An observed refusal only describes the window it named; once that window resets it is no longer evidence. */
export function withoutExpiredMuseObservation(
  reports: Record<string, ProviderQuotaReportView>, now = Date.now(),
): Record<string, ProviderQuotaReportView> {
  const resetAt = museObservationResetAt(reports);
  if (resetAt === undefined || resetAt > now) return reports;
  const { [PROVIDER]: _expired, ...rest } = reports;
  return rest;
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
    // The server bounds retained history; a tail limit can hide a later-started request that finalized earlier.
    const response = await fetchImpl(`${apiBase}/api/logs?provider=${PROVIDER}&account=${accountLabel}`, { signal });
    if (!response.ok) return reports;
    const body = await response.json() as { logs?: unknown[] };
    // Select by request start time, not finalization order. Attempts on another final account are not evidence.
    let latest: unknown;
    let latestTimestamp = -Infinity;
    for (const value of Array.isArray(body.logs) ? body.logs : []) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, unknown>;
      if (row.provider !== PROVIDER || row.accountLogLabel !== accountLabel
        || typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp)) continue;
      if (row.timestamp >= latestTimestamp) { latest = row; latestTimestamp = row.timestamp; }
    }
    const observation = museLimitReport(latest, accountLabel);
    return observation ? { ...reports, [PROVIDER]: observation } : reports;
  } catch {
    return reports;
  }
}
