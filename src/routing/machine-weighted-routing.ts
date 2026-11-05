/**
 * purpose: Compute new-session account weights from OCX quota snapshots.
 * tags: ocx, routing, quota, weighted-round-robin
 * usage: Copied into OpenCodex src/routing by ocx_weighted_route_patch.py.
 */

export interface MachineQuota {
  weeklyPercent?: number;
  weeklyResetAt?: number;
  fiveHourPercent?: number;
  shortPercent?: number;
  shortObservedAt?: number;
  updatedAt?: number;
  customWindows?: Array<{ label: string; percent?: number; resetAt?: number }>;
}

export interface MachineWeights {
  eligible: string[];
  weights: ReadonlyMap<string, number>;
  mode: "round-robin" | "weighted";
}

const RESET_WINDOW_MS = 48 * 60 * 60_000;
const MAX_QUOTA_AGE_MS = 15 * 60_000;

function asMs(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function percent(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : null;
}

function quotaWindow(provider: string, quota: MachineQuota, family?: "gem" | "cla") {
  if (provider !== "google-antigravity") {
    return { weekly: percent(quota.weeklyPercent), resetAt: asMs(quota.weeklyResetAt) };
  }
  // Antigravity publishes separate weekly budgets for Gemini and Claude.
  const prefix = family === "gem" ? /^gem(?:ini)?\b/i : family === "cla" ? /^cla(?:ude)?\b/i : null;
  const weekly = (quota.customWindows ?? []).find(window =>
    /weekly/i.test(window.label) && (prefix === null || prefix.test(window.label)));
  return { weekly: percent(weekly?.percent), resetAt: asMs(weekly?.resetAt) };
}

export function machineRoutingWeights(
  provider: string,
  accountIds: readonly string[],
  quotaOf: (accountId: string) => MachineQuota | null | undefined,
  planOf: (accountId: string) => string | null | undefined = () => undefined,
  now = Date.now(),
  family?: "gem" | "cla",
): MachineWeights {
  const eligible = [...new Set(accountIds)];
  const ordinary = (): MachineWeights => ({
    eligible,
    weights: new Map(eligible.map(id => [id, 1])),
    mode: "round-robin",
  });
  if (eligible.length < 2) return ordinary();
  // R-11: the LaunchDaemon pin controls the pre-window state.
  // After the install window removes the pin, GPT uses the Claude rule.
  if (provider === "anthropic" || provider === "openai") {
    const fresh = (at: number | undefined) => {
      const ms = asMs(at);
      return ms !== null && ms <= now && now - ms <= MAX_QUOTA_AGE_MS;
    };
    const target = eligible.flatMap(id => {
      const quota = quotaOf(id);
      if (!quota || !fresh(quota.updatedAt)) return [];
      const weekly = percent(quota.weeklyPercent);
      const resetAt = asMs(quota.weeklyResetAt);
      const fiveHour = percent(provider === "openai" ? quota.shortPercent : quota.fiveHourPercent);
      if (weekly === null || weekly >= 98 || resetAt === null
        || resetAt <= now || resetAt - now > 24 * 60 * 60_000
        || fiveHour === null || fiveHour >= 60) return [];
      // A refreshed credits-only payload must not revive an old five-hour usage bar.
      if (provider === "openai" && quota.shortObservedAt !== undefined && !fresh(quota.shortObservedAt)) return [];
      return [{ id, resetAt }];
    }).sort((a, b) => a.resetAt - b.resetAt || a.id.localeCompare(b.id))[0];
    if (!target) return ordinary();
    return {
      eligible,
      weights: new Map(eligible.map(id => [id, id === target.id ? eligible.length - 1 : 1])),
      mode: "weighted",
    };
  }

  const upcoming = eligible.flatMap(id => {
    const quota = quotaOf(id);
    if (!quota) return [];
    const plan = (planOf(id) ?? "").toLowerCase();
    const updatedAt = asMs(quota.updatedAt);
    if (updatedAt !== null && (updatedAt > now || now - updatedAt > MAX_QUOTA_AGE_MS)) return [];
    const { weekly, resetAt } = quotaWindow(provider, quota, family);
    if (weekly === null || resetAt === null || weekly >= 100
      || resetAt <= now || resetAt - now > RESET_WINDOW_MS) return [];
    return [{ id, quota, weekly, resetAt, plan }];
  }).sort((a, b) => a.resetAt - b.resetAt || a.id.localeCompare(b.id));
  if (upcoming.length === 0) return ordinary();

  const targets = upcoming.slice(0, 2);
  // Inherited policy for providers other than GPT/Claude, which returned above.
  // Antigravity publishes only family weekly windows, so the five-hour check is skipped.
  const overFiveHour = targets.some(row => {
    if (provider === "google-antigravity") return false;
    const fiveHour = percent(row.quota.fiveHourPercent);
    return fiveHour === null || fiveHour > 60;
  });
  if (overFiveHour) return ordinary();
  const weighted = new Set(targets.map(row => row.id));
  return {
    eligible,
    weights: new Map(eligible.map(id => [id, weighted.has(id) ? 3 : 1])),
    mode: "weighted",
  };
}
