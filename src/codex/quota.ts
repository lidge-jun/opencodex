import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";

export type StoredAccountQuota = {
  weeklyPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  updatedAt: number;
};

/** Disk snapshot under OPENCODEX_HOME — usage percents only (no emails/tokens). */
const QUOTA_CACHE_FILENAME = "codex-quota-cache.json";
/** Keep last-known bars across restarts; WHAM still refreshes on TTL in live/prime paths. */
const QUOTA_DISK_MAX_AGE_MS = 6 * 60 * 60_000;
const QUOTA_PERSIST_DEBOUNCE_MS = 250;

type QuotaDiskFile = {
  version: 1;
  quotas: Record<string, StoredAccountQuota>;
};

let diskHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export type WhamUsageResponse = {
  email?: string | null;
  plan_type?: string | null;
  rate_limit?: {
    // Live WHAM payloads send explicit nulls for absent windows (issue #315 repro).
    primary_window?: WhamUsageWindow | null;
    secondary_window?: WhamUsageWindow | null;
    tertiary_window?: WhamUsageWindow | null;
  };
  rate_limit_reset_credits?: {
    available_count: number;
  } | null;
};

type WhamUsageWindow = {
  used_percent?: number;
  reset_at?: number;
  limit_window_seconds?: number;
};

const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
const MONTHLY_WINDOW_MIN_MINUTES = MONTHLY_WINDOW_MIN_SECONDS / 60;

const accountQuota = new Map<string, StoredAccountQuota>();
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();

function mayCommitAccountQuota(accountId: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountIds.has(accountId);
}

// Valid upstream percentages are normalized to 0..100. Keep "unknown" outside that domain so an
// actually exhausted account is still eligible for threshold rotation.
export const CODEX_UNKNOWN_USAGE_SCORE = 101;
export const CODEX_EXHAUSTED_USAGE_PERCENT = 100;

export function isCodexQuotaExhausted(
  quota: Pick<StoredAccountQuota, "weeklyPercent" | "monthlyPercent"> | null,
  plan?: string | null,
): boolean {
  if (!quota) return false;
  const values = codexQuotaWindowForPlan(plan) === "monthly"
    ? [quota.monthlyPercent]
    : [quota.weeklyPercent, quota.monthlyPercent];
  return values.some(value => typeof value === "number"
    && Number.isFinite(value)
    && value >= CODEX_EXHAUSTED_USAGE_PERCENT);
}

/**
 * Which usage window a plan reports in. This is the SINGLE rule shared by quota
 * parsing, exhaustion, and recovery — they must not diverge.
 *
 * An allowlist of "known" plans was tried here and was wrong: the upstream model
 * snapshot alone carries 21 distinct plan strings (`edu_plus`, `finserv`, `k12`,
 * `quorum`, `self_serve_business_usage_based`, ...), and `CodexAccount.plan` is an
 * unrestricted string, so any list is a list of the plans someone remembered.
 * Twelve real plans would have been refused recovery and stayed cooled forever —
 * the very defect this unit exists to fix, reintroduced as a typo-shaped hole.
 *
 * The honest rule is the parser's own: Go and Free report a 30-day window,
 * everything else (including an absent plan) reports weekly. Recovery reads the
 * window the parser actually wrote rather than second-guessing it.
 */
export function codexQuotaWindowForPlan(plan?: string | null): "monthly" | "weekly" {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free" ? "monthly" : "weekly";
}

export function isCompleteCodexQuotaRecoverySnapshot(
  quota: Pick<StoredAccountQuota, "weeklyPercent" | "monthlyPercent"> | null,
  plan?: string | null,
): boolean {
  if (!quota || isCodexQuotaExhausted(quota, plan)) return false;
  // Recovery still fails closed on MISSING EVIDENCE — a credits-only or windowless payload
  // carries no usage reading at all and must never clear a cooldown. What it does not do is
  // fail closed on an unfamiliar plan NAME, which only ever meant "cooled forever".
  //
  // The parser classifies windows by DURATION, not by plan name: a Team response whose
  // primary window is explicitly monthly parses to monthlyPercent only (no secondary
  // window exists), so requiring weeklyPercent because the plan is not go/free would
  // strand exactly those accounts until their predicted expiry. Accept whichever window(s)
  // the parser actually wrote; Go/Free never carry a weekly value, so monthly-only is
  // required there.
  if (codexQuotaWindowForPlan(plan) === "monthly") {
    return typeof quota.monthlyPercent === "number" && Number.isFinite(quota.monthlyPercent);
  }
  return hasKnownQuotaValue(quota);
}

export function normalizeUsagePercent(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(100, numeric));
}

function normalizeResetAt(value: unknown): number | undefined {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  if (typeof numeric !== "number" || !Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric;
}

function hasKnownQuotaValue(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return [quota.weeklyPercent, quota.monthlyPercent]
    .some(value => typeof value === "number" && Number.isFinite(value));
}

function isExplicitMonthlyWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number"
    && Number.isFinite(seconds)
    && seconds >= MONTHLY_WINDOW_MIN_SECONDS;
}

function isExplicitMonthlyWindowMinutes(windowMinutes: unknown): boolean {
  const minutes = typeof windowMinutes === "number"
    ? windowMinutes
    : typeof windowMinutes === "string" && windowMinutes.trim() !== ""
      ? Number(windowMinutes)
      : undefined;
  return typeof minutes === "number"
    && Number.isFinite(minutes)
    && minutes >= MONTHLY_WINDOW_MIN_MINUTES;
}


function snapshotHasWeekly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
}

function snapshotHasMonthly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined;
}

function snapshotHasUsage(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return snapshotHasWeekly(quota) || snapshotHasMonthly(quota);
}
export function setAccountQuotaFromParsed(
  accountId: string,
  quota: Omit<StoredAccountQuota, "updatedAt"> | null,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!quota) return;
  if (!mayCommitAccountQuota(accountId, writerGeneration)) return;
  const existing = accountQuota.get(accountId);
  const next: StoredAccountQuota = { updatedAt: Date.now() };
  const creditsOnly = quota.resetCredits !== undefined && !snapshotHasUsage(quota);

  if (creditsOnly) {
    if (existing?.weeklyPercent !== undefined) next.weeklyPercent = existing.weeklyPercent;
    if (existing?.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
    if (existing?.monthlyPercent !== undefined) next.monthlyPercent = existing.monthlyPercent;
    if (existing?.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
    next.resetCredits = quota.resetCredits;
    accountQuota.set(accountId, next);
    schedulePersistAccountQuotas();
    return;
  }

  if (snapshotHasWeekly(quota)) {
    if (quota.weeklyPercent !== undefined) next.weeklyPercent = quota.weeklyPercent;
    if (quota.weeklyResetAt !== undefined) next.weeklyResetAt = quota.weeklyResetAt;
  } else if (snapshotHasMonthly(quota) && !snapshotHasWeekly(quota)) {
    // Monthly-only snapshots intentionally clear stale weekly values (issue #382).
  } else if (existing?.weeklyPercent !== undefined) {
    next.weeklyPercent = existing.weeklyPercent;
    if (existing.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
  }

  if (snapshotHasMonthly(quota)) {
    if (quota.monthlyPercent !== undefined) next.monthlyPercent = quota.monthlyPercent;
    if (quota.monthlyResetAt !== undefined) next.monthlyResetAt = quota.monthlyResetAt;
  } else if (snapshotHasWeekly(quota) && existing?.monthlyPercent !== undefined) {
    next.monthlyPercent = existing.monthlyPercent;
    if (existing.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
  }

  if (quota.resetCredits !== undefined) next.resetCredits = quota.resetCredits;
  else if (existing?.resetCredits !== undefined) next.resetCredits = existing.resetCredits;

  accountQuota.set(accountId, next);
  schedulePersistAccountQuotas();
}

export function parseUpstreamQuotaHeaders(headers: Headers): Omit<StoredAccountQuota, "updatedAt"> | null {
  const primaryRaw = headers.get("x-codex-primary-used-percent");
  const secondaryRaw = headers.get("x-codex-secondary-used-percent");
  const tertiaryRaw = headers.get("x-codex-tertiary-used-percent");
  const primaryResetRaw = headers.get("x-codex-primary-reset-at");
  const secondaryResetRaw = headers.get("x-codex-secondary-reset-at");
  const tertiaryResetRaw = headers.get("x-codex-tertiary-reset-at");
  const primaryWindowMinutes = headers.get("x-codex-primary-window-minutes");
  const secondaryWindowMinutes = headers.get("x-codex-secondary-window-minutes");

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const primaryPercent = normalizeUsagePercent(primaryRaw);
  const secondaryPercent = normalizeUsagePercent(secondaryRaw);
  const tertiaryPercent = normalizeUsagePercent(tertiaryRaw);
  const primaryResetAt = normalizeResetAt(primaryResetRaw);
  const secondaryResetAt = normalizeResetAt(secondaryResetRaw);
  const tertiaryResetAt = normalizeResetAt(tertiaryResetRaw);
  const primaryIsMonthly = primaryRaw !== null && isExplicitMonthlyWindowMinutes(primaryWindowMinutes);

  if (primaryIsMonthly) {
    if (primaryPercent !== undefined) {
      quota.monthlyPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.monthlyResetAt = primaryResetAt;
    }
    if (secondaryPercent !== undefined) {
      quota.weeklyPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
    }
  } else {
    const weeklyPercent = primaryPercent ?? secondaryPercent;
    const weeklyResetAt = primaryPercent !== undefined
      ? primaryResetAt
      : secondaryResetAt;
    if (weeklyPercent !== undefined) {
      quota.weeklyPercent = weeklyPercent;
      if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
    }
  }

  if (tertiaryPercent !== undefined && quota.monthlyPercent === undefined) {
    quota.monthlyPercent = tertiaryPercent;
    if (tertiaryResetAt !== undefined) quota.monthlyResetAt = tertiaryResetAt;
  }

  return hasKnownQuotaValue(quota) ? quota : null;
}

export function applyAccountQuotaFromUpstreamHeaders(
  accountId: string,
  headers: Headers,
  writerGeneration = captureConfigGeneration(),
): void {
  const quota = parseUpstreamQuotaHeaders(headers);
  if (!quota) return;
  setAccountQuotaFromParsed(accountId, quota, writerGeneration);
}

export function updateAccountQuota(
  accountId: string,
  weekly: unknown,
  weeklyResetAt?: unknown,
  monthly?: unknown,
  monthlyResetAt?: unknown,
  resetCredits?: number,
  writerGeneration = captureConfigGeneration(),
): void {
  if (!mayCommitAccountQuota(accountId, writerGeneration)) return;
  const existing = accountQuota.get(accountId);
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextMonthly === undefined && resetCredits === undefined) return;

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.resetCredits !== undefined ? { resetCredits: existing.resetCredits } : {}),
    updatedAt: Date.now(),
  };

  const nextWeeklyResetAt = normalizeResetAt(weeklyResetAt);
  const nextMonthlyResetAt = normalizeResetAt(monthlyResetAt);
  if (nextWeekly !== undefined) {
    quota.weeklyPercent = nextWeekly;
    if (nextWeeklyResetAt !== undefined) quota.weeklyResetAt = nextWeeklyResetAt;
  }
  if (nextMonthly !== undefined) {
    quota.monthlyPercent = nextMonthly;
    if (nextMonthlyResetAt !== undefined) quota.monthlyResetAt = nextMonthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  accountQuota.set(accountId, quota);
  schedulePersistAccountQuotas();
}

function hydrateAccountQuotasFromDisk(): void {
  if (diskHydrated) return;
  diskHydrated = true;
  try {
    const path = join(getConfigDir(), QUOTA_CACHE_FILENAME);
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as QuotaDiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.quotas || typeof parsed.quotas !== "object") return;
    const now = Date.now();
    for (const [accountId, quota] of Object.entries(parsed.quotas)) {
      if (!quota || typeof quota !== "object" || typeof quota.updatedAt !== "number") continue;
      if (now - quota.updatedAt > QUOTA_DISK_MAX_AGE_MS) continue;
      if (!accountQuota.has(accountId)) accountQuota.set(accountId, quota);
    }
  } catch {
    // Corrupt/missing cache must never block routing or the dashboard.
  }
}

function schedulePersistAccountQuotas(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const quotas: Record<string, StoredAccountQuota> = {};
      for (const [accountId, quota] of accountQuota.entries()) {
        quotas[accountId] = quota;
      }
      const body: QuotaDiskFile = { version: 1, quotas };
      atomicWriteFile(join(getConfigDir(), QUOTA_CACHE_FILENAME), `${JSON.stringify(body)}\n`);
    } catch {
      // Best-effort persistence only.
    }
  }, QUOTA_PERSIST_DEBOUNCE_MS);
}

export function getAccountQuota(accountId: string): StoredAccountQuota | null {
  hydrateAccountQuotasFromDisk();
  return accountQuota.get(accountId) ?? null;
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  hydrateAccountQuotasFromDisk();
  return accountQuota.entries();
}

export function clearAccountQuota(accountId?: string): void {
  if (accountId) {
    accountQuota.delete(accountId);
    schedulePersistAccountQuotas();
    return;
  }
  accountQuota.clear();
  diskHydrated = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    const path = join(getConfigDir(), QUOTA_CACHE_FILENAME);
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort; memory is already cleared.
  }
}

export function reconcileCodexQuotaAccounts(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  hydrateAccountQuotasFromDisk();
  let removed = 0;
  for (const accountId of accountQuota.keys()) {
    if (context.codexAccountIds.has(accountId)) continue;
    accountQuota.delete(accountId);
    removed += 1;
  }
  liveAccountIds = new Set(context.codexAccountIds);
  lastReconciledGeneration = context.generation;
  if (removed > 0) schedulePersistAccountQuotas();
  return removed;
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    return resetCredits !== undefined ? { resetCredits } : null;
  }

  const quota: Omit<StoredAccountQuota, "updatedAt"> = {};
  const thirtyDayOnly = codexQuotaWindowForPlan(data.plan_type) === "monthly";
  const primaryWindow = data.rate_limit.primary_window;
  const secondaryWindow = data.rate_limit.secondary_window;
  const tertiaryWindow = data.rate_limit.tertiary_window;
  const primaryPercent = normalizeUsagePercent(primaryWindow?.used_percent);
  const secondaryPercent = normalizeUsagePercent(secondaryWindow?.used_percent);
  const tertiaryPercent = normalizeUsagePercent(tertiaryWindow?.used_percent);
  const primaryResetAt = normalizeResetAt(primaryWindow?.reset_at);
  const secondaryResetAt = normalizeResetAt(secondaryWindow?.reset_at);
  const tertiaryResetAt = normalizeResetAt(tertiaryWindow?.reset_at);
  const primaryIsMonthly = isExplicitMonthlyWindow(primaryWindow);

  // [Decision Log]
  // - 목적과 의도: distinguish weekly and roughly monthly WHAM primary windows without plan-name guesses.
  // - 기존 구현 및 제약 조건: primary meant weekly, and older responses omit limit_window_seconds.
  // - 검토한 주요 대안: exact-duration matching, plan-specific mapping, and a duration lower bound.
  // - 선택한 방식: only an explicit primary duration of at least 28 days changes it to monthly.
  // - 다른 대안 대신 이 방식을 선택한 이유: it accepts calendar-month variance and preserves legacy payloads.
  // - 장점, 단점 및 영향: Team monthly quotas classify correctly; unknown durations remain weekly by design.
  const weeklyPercent = primaryIsMonthly ? secondaryPercent : primaryPercent ?? secondaryPercent;
  const weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : primaryPercent !== undefined ? primaryResetAt : secondaryResetAt;
  const monthlyPercent = primaryIsMonthly ? primaryPercent ?? tertiaryPercent : tertiaryPercent;
  const monthlyResetAt = primaryIsMonthly && primaryPercent !== undefined ? primaryResetAt : tertiaryResetAt;
  if (thirtyDayOnly) {
    if (monthlyPercent !== undefined) {
      quota.monthlyPercent = monthlyPercent;
      if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
    }
  } else if (weeklyPercent !== undefined) {
    quota.weeklyPercent = weeklyPercent;
    if (weeklyResetAt !== undefined) quota.weeklyResetAt = weeklyResetAt;
  }
  if (!thirtyDayOnly && monthlyPercent !== undefined) {
    quota.monthlyPercent = monthlyPercent;
    if (monthlyResetAt !== undefined) quota.monthlyResetAt = monthlyResetAt;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
