import { useCallback, useState } from "react";

/** Mirrors `AccountProbeStatus` in src/providers/quota/antigravity-account-probe.ts. */
export const ACCOUNT_PROBE_STATUSES = [
  "ok", "paused", "token_expired", "suspended", "verification_required", "rate_limited", "permission_denied", "error",
] as const;
export type AccountProbeStatus = typeof ACCOUNT_PROBE_STATUSES[number];

export interface AccountProbeResultDto {
  accountId: string;
  status: AccountProbeStatus;
  httpStatus: number | null;
  reason: string | null;
  message: string | null;
  latencyMs?: number;
  quota?: { customWindows?: Array<{ label: string; percent: number }> } | null;
}

/** Providers whose management API implements `POST /api/oauth/accounts/probe`. */
export const ACCOUNT_PROBE_PROVIDERS: ReadonlySet<string> = new Set(["google-antigravity"]);

export type AccountProbeEntry = { result: AccountProbeResultDto; at: number } | { failed: true; at: number };

function isProbeResult(value: unknown): value is AccountProbeResultDto {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<AccountProbeResultDto>;
  return typeof row.accountId === "string" && typeof row.status === "string"
    && (ACCOUNT_PROBE_STATUSES as readonly string[]).includes(row.status);
}

/** Probe state for one provider's account list; results stay in memory for this view only. */
export function useAccountProbe(apiBase: string, provider: string) {
  const [entries, setEntries] = useState<Record<string, AccountProbeEntry>>({});
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [allPending, setAllPending] = useState(false);

  const probe = useCallback(async (accountIds: readonly string[], all: boolean) => {
    setPending(previous => new Set([...previous, ...accountIds]));
    if (all) setAllPending(true);
    const at = Date.now();
    try {
      const response = await fetch(`${apiBase}/api/oauth/accounts/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, ...(all ? {} : { accountId: accountIds[0] }) }),
      });
      const json = response.ok ? await response.json().catch(() => null) as { results?: unknown } | null : null;
      const results = Array.isArray(json?.results) ? json.results.filter(isProbeResult) : [];
      setEntries(previous => {
        const next = { ...previous };
        for (const id of accountIds) next[id] = { failed: true, at };
        for (const result of results) next[result.accountId] = { result, at };
        return next;
      });
    } catch {
      setEntries(previous => {
        const next = { ...previous };
        for (const id of accountIds) next[id] = { failed: true, at };
        return next;
      });
    } finally {
      setPending(previous => {
        const next = new Set(previous);
        for (const id of accountIds) next.delete(id);
        return next;
      });
      if (all) setAllPending(false);
    }
  }, [apiBase, provider]);

  return {
    entries,
    isPending: (accountId: string) => pending.has(accountId),
    allPending,
    probeOne: (accountId: string) => probe([accountId], false),
    probeAll: (accountIds: readonly string[]) => probe(accountIds, true),
  };
}

export type AccountProbeController = ReturnType<typeof useAccountProbe>;

