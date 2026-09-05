import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import { captureConfigGeneration, type GenerationContext } from "../lib/state-store-sweeper";
import { isThirtyDayOnlyCodexPlan } from "./plan";
import { MAIN_CODEX_ACCOUNT_ID } from "./account-id";
import { getObservedMainQuotaIdentityKey, isMainQuotaWriterLive, type MainQuotaWriter } from "./main-account-cache";

import type { StoredAccountQuota, WhamUsageResponse, WhamUsageWindow } from "./quota-types";
export type { StoredAccountQuota, WhamUsageResponse } from "./quota-types";

/** Disk snapshot under OPENCODEX_HOME — quota and policy identity only, never credential tags. */
const QUOTA_CACHE_FILENAME = "codex-quota-cache.json";
/** Keep last-known bars across restarts; WHAM still refreshes on TTL in live/prime paths. */
const QUOTA_DISK_MAX_AGE_MS = 6 * 60 * 60_000;
const QUOTA_PERSIST_DEBOUNCE_MS = 250;

type QuotaDiskFile = {
  version: 1;
  quotas: Record<string, StoredAccountQuota>;
  mainPolicyQuota?: MainPolicyQuota;
};

type MainPolicyQuota = { identityKey: string; quota: StoredAccountQuota };
let mainPolicyQuota: MainPolicyQuota | null = null;
let diskHydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const MONTHLY_WINDOW_MIN_SECONDS = 28 * 24 * 60 * 60;
/**
 * Shortest window still plausibly the WEEKLY quota (#1791).
 *
 * K12 and similar plans send a 5-hour primary window plus a 7-day secondary. Folding the
 * primary into `weeklyPercent` reported the 5-hour bar as the weekly one and discarded the
 * real weekly reading entirely, so the dashboard showed a window that reset every few hours
 * and routing never saw the limit that actually gates the account.
 *
 * 24h is the discriminator: anything shorter is a burst window, not a weekly one. A window
 * with no declared duration is unchanged, because older payloads omit `limit_window_seconds`
 * and guessing there would break every legacy account.
 */
const WEEKLY_WINDOW_MIN_SECONDS = 24 * 60 * 60;
const MONTHLY_WINDOW_MIN_MINUTES = MONTHLY_WINDOW_MIN_SECONDS / 60;
// Derived, never written as a literal: the header parser and the WHAM parser must not be able
// to drift to different thresholds, which is the class of defect this pair exists to prevent.
const WEEKLY_WINDOW_MIN_MINUTES = WEEKLY_WINDOW_MIN_SECONDS / 60;

const accountQuota = new Map<string, StoredAccountQuota>();
let lastReconciledGeneration = 0;
let liveAccountIds = new Set<string>();

function mayCommitAccountQuota(accountId: string, writerGeneration: number): boolean {
  return writerGeneration >= lastReconciledGeneration || liveAccountIds.has(accountId);
}

// Valid upstream percentages are normalized to 0..100. Keep "unknown" outside that domain so an
// actually exhausted account is still eligible for threshold rotation.
export const CODEX_UNKNOWN_USAGE_SCORE = 101;
/**
 * A window reading at or above this is a measured refusal, not a position on a scale.
 *
 * Separate from `CODEX_UNKNOWN_USAGE_SCORE` because they mean opposite things: unknown is
 * "we have not observed this account", 100 is "we observed it and it is full".
 */
export const CODEX_EXHAUSTED_USAGE_PERCENT = 100;

export function isCodexQuotaExhausted(
  quota: Pick<StoredAccountQuota, "weeklyPercent" | "monthlyPercent" | "shortPercent"> | null,
  plan?: unknown,
): boolean {
  if (!quota) return false;
  // The burst window counts on EVERY plan. It is upstream-enforced independently, so an
  // account at 100% there is blocked regardless of which longer window governs its plan;
  // omitting it would route traffic straight into a 429 (#1791).
  const values = codexQuotaWindowForPlan(plan) === "monthly"
    ? [quota.monthlyPercent, quota.shortPercent]
    : [quota.weeklyPercent, quota.monthlyPercent, quota.shortPercent];
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
export function codexQuotaWindowForPlan(plan?: unknown): "monthly" | "weekly" {
  return isThirtyDayOnlyCodexPlan(plan) ? "monthly" : "weekly";
}

export function isCompleteCodexQuotaRecoverySnapshot(
  quota: Pick<StoredAccountQuota, "weeklyPercent" | "monthlyPercent" | "monthlyIsPrimaryWindow" | "shortPercent"> | null,
  plan?: unknown,
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
  //
  // Audit correction: "the parser wrote monthlyPercent" is NOT by itself evidence for a
  // weekly-quota plan. A tertiary-only response also writes monthlyPercent, and it says
  // nothing about the weekly quota that actually gates a Team/Plus account — accepting it
  // would clear the cooldown on a reading of a different window. Only an explicitly-monthly
  // PRIMARY window is the governing reading, which is what `monthlyIsPrimaryWindow` records.
  if (codexQuotaWindowForPlan(plan) === "monthly") {
    return finitePercent(quota.monthlyPercent);
  }
  if (finitePercent(quota.weeklyPercent)) return true;
  return quota.monthlyIsPrimaryWindow === true && finitePercent(quota.monthlyPercent);
}

function finitePercent(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
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

/** Reject numeric policy evidence before legacy clamping can fabricate a valid reading. */
function isInvalidPolicyUsagePercent(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value) || value < 0 || value > 100;
  if (typeof value !== "string" || value.trim() === "") return false;
  const numeric = Number(value);
  // Non-numeric metadata stays unknown; explicit nonfinite spellings are invalid evidence.
  if (Number.isNaN(numeric)) return /^[+-]?(?:nan|infinity)$/i.test(value.trim());
  return !Number.isFinite(numeric) || numeric < 0 || numeric > 100;
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
  return [quota.weeklyPercent, quota.monthlyPercent, quota.shortPercent]
    .some(value => typeof value === "number" && Number.isFinite(value))
    // Known short-window shape with unknown usage still selects that window for policy.
    || snapshotHasShort(quota)
    || !!quota.customWindows?.some(window => Number.isFinite(window.percent));
}

/** True only for a window that DECLARES a duration shorter than a day. */
function isExplicitShortWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number"
    && Number.isFinite(seconds)
    && seconds > 0
    && seconds < WEEKLY_WINDOW_MIN_SECONDS;
}

function isExplicitMonthlyWindow(window: WhamUsageWindow | null | undefined): boolean {
  const seconds = window?.limit_window_seconds;
  return typeof seconds === "number"
    && Number.isFinite(seconds)
    && seconds >= MONTHLY_WINDOW_MIN_SECONDS;
}

function isExplicitMonthlyWindowMinutes(windowMinutes: unknown): boolean {
  const minutes = windowMinutes_(windowMinutes);
  return minutes !== undefined && minutes >= MONTHLY_WINDOW_MIN_MINUTES;
}

/** The header wire reports a window duration in MINUTES; WHAM reports it in seconds. */
function windowMinutes_(value: unknown): number | undefined {
  const minutes = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : undefined;
  return typeof minutes === "number" && Number.isFinite(minutes) ? minutes : undefined;
}

/** Minutes-domain twin of isExplicitShortWindow. Same strict `<`, same 24h discriminator. */
function isExplicitShortWindowMinutes(value: unknown): boolean {
  const minutes = windowMinutes_(value);
  return minutes !== undefined && minutes > 0 && minutes < WEEKLY_WINDOW_MIN_MINUTES;
}


function snapshotHasWeekly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.weeklyPercent !== undefined || quota.weeklyResetAt !== undefined;
}

function snapshotHasMonthly(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.monthlyPercent !== undefined || quota.monthlyResetAt !== undefined;
}

function snapshotHasShort(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.shortPercent !== undefined
    || quota.shortResetAt !== undefined
    || quota.shortWindowSeconds !== undefined;
}

function snapshotHasCustom(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return quota.customWindows !== undefined;
}

function snapshotHasUsage(quota: Omit<StoredAccountQuota, "updatedAt">): boolean {
  return snapshotHasWeekly(quota) || snapshotHasMonthly(quota) || snapshotHasShort(quota) || snapshotHasCustom(quota);
}
export function setAccountQuotaFromParsed(
  accountId: string,
  quota: Omit<StoredAccountQuota, "updatedAt"> | null,
  writerGeneration = captureConfigGeneration(),
  mainWriter?: MainQuotaWriter,
  policyQuota: Omit<StoredAccountQuota, "updatedAt"> | null = quota,
): void {
  if (!quota) return;
  if (!mayCommitAccountQuota(accountId, writerGeneration)) return;
  const isMain = accountId === MAIN_CODEX_ACCOUNT_ID;
  if (isMain && mainWriter && !isMainQuotaWriterLive(mainWriter)) return;
  hydrateAccountQuotasFromDisk();
  const legacyExisting = accountQuota.get(accountId);
  const updatedAt = Date.now();
  // Legacy rotation keeps its existing carry behavior, but never inherits policy-only
  // evidence that outlived its disk TTL. Policy has a separate, identity-checked base.
  const next = mergeAccountQuota(quota, legacyExisting, updatedAt);
  accountQuota.set(accountId, next);
  if (isMain) {
    const policyExisting = mainWriter && mainPolicyQuota?.identityKey === mainWriter.identityKey
      ? mainPolicyQuota.quota
      : undefined;
    mainPolicyQuota = mainWriter && (policyQuota || policyExisting)
      ? {
        identityKey: mainWriter.identityKey,
        quota: policyQuota
          ? structuredClone(mergeAccountQuota(policyQuota, policyExisting, updatedAt, true))
          : policyExisting!,
      }
      : null;
  }
  schedulePersistAccountQuotas();
  // Credits carry the previous usage tuple; they must not refresh its observation clock.
  if (!(quota.resetCredits !== undefined && !snapshotHasUsage(quota))) {
    notifyCodexQuotaSnapshot(accountId, next);
  }
}

/** One partial-window merge contract for legacy quota and identity-bound policy evidence. */
function mergeAccountQuota(
  quota: Omit<StoredAccountQuota, "updatedAt">,
  existing: StoredAccountQuota | undefined,
  updatedAt: number,
  policyEvidence = false,
): StoredAccountQuota {
  const next: StoredAccountQuota = { updatedAt };
  const creditsOnly = quota.resetCredits !== undefined && !snapshotHasUsage(quota);

  if (creditsOnly) {
    if (existing?.weeklyPercent !== undefined) next.weeklyPercent = existing.weeklyPercent;
    if (existing?.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
    if (existing?.monthlyPercent !== undefined) next.monthlyPercent = existing.monthlyPercent;
    if (existing?.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
    if (existing?.monthlyIsPrimaryWindow === true) next.monthlyIsPrimaryWindow = true;
    if (existing?.shortPercent !== undefined) next.shortPercent = existing.shortPercent;
    if (existing?.shortObservedAt !== undefined) next.shortObservedAt = existing.shortObservedAt;
    if (existing?.shortResetAt !== undefined) next.shortResetAt = existing.shortResetAt;
    if (existing?.shortWindowSeconds !== undefined) next.shortWindowSeconds = existing.shortWindowSeconds;
    if (existing?.customWindows !== undefined) next.customWindows = existing.customWindows;
    next.resetCredits = quota.resetCredits;
    return next;
  }

  if (snapshotHasWeekly(quota)) {
    if (quota.weeklyPercent !== undefined) next.weeklyPercent = quota.weeklyPercent;
    if (quota.weeklyResetAt !== undefined) next.weeklyResetAt = quota.weeklyResetAt;
  } else if (snapshotHasMonthly(quota)
    && (!policyEvidence || quota.monthlyIsPrimaryWindow === true)) {
    // Legacy monthly-only clearing is unchanged (#382). Policy needs a governing
    // monthly-primary observation: a tertiary-only header cannot retract weekly99.
  } else if (existing?.weeklyPercent !== undefined) {
    next.weeklyPercent = existing.weeklyPercent;
    if (existing.weeklyResetAt !== undefined) next.weeklyResetAt = existing.weeklyResetAt;
  }

  if (snapshotHasMonthly(quota)) {
    if (quota.monthlyPercent !== undefined) next.monthlyPercent = quota.monthlyPercent;
    if (quota.monthlyResetAt !== undefined) next.monthlyResetAt = quota.monthlyResetAt;
    // Carry the provenance with the value it describes. Recovery reads `freshQuota` directly,
    // so this is not on its path today — but a cached snapshot that kept `monthlyPercent`
    // while silently dropping `monthlyIsPrimaryWindow` would look like tertiary-only data to
    // any future reader, and that failure would be invisible.
    if (quota.monthlyIsPrimaryWindow === true) next.monthlyIsPrimaryWindow = true;
  } else if ((snapshotHasWeekly(quota) || snapshotHasShort(quota) || snapshotHasCustom(quota))
      && existing?.monthlyPercent !== undefined) {
    next.monthlyPercent = existing.monthlyPercent;
    if (existing.monthlyResetAt !== undefined) next.monthlyResetAt = existing.monthlyResetAt;
    if (existing.monthlyIsPrimaryWindow === true) next.monthlyIsPrimaryWindow = true;
  }

  const preserveKnownShort = policyEvidence && quota.shortPercent === undefined && finitePercent(existing?.shortPercent);
  if (snapshotHasShort(quota) && !preserveKnownShort) {
    if (quota.shortPercent !== undefined) {
      next.shortPercent = quota.shortPercent;
      if (Number.isFinite(quota.shortPercent)) next.shortObservedAt = next.updatedAt;
    }
    if (quota.shortResetAt !== undefined) next.shortResetAt = quota.shortResetAt;
    if (quota.shortWindowSeconds !== undefined) next.shortWindowSeconds = quota.shortWindowSeconds;
  } else {
    // Unknown usage is not a lower reading. Retain the entire known tuple: pairing
    // its percentage with new metadata would silently extend or shorten its reset.
    if (existing?.shortPercent !== undefined) next.shortPercent = existing.shortPercent;
    if (existing?.shortObservedAt !== undefined) next.shortObservedAt = existing.shortObservedAt;
    if (existing?.shortResetAt !== undefined) next.shortResetAt = existing.shortResetAt;
    if (existing?.shortWindowSeconds !== undefined) next.shortWindowSeconds = existing.shortWindowSeconds;
  }

  if (snapshotHasCustom(quota)) next.customWindows = quota.customWindows;

  if (quota.resetCredits !== undefined) next.resetCredits = quota.resetCredits;
  else if (existing?.resetCredits !== undefined) next.resetCredits = existing.resetCredits;

  return next;
}

/**
 * Hand a committed snapshot to the optional quota-reset observer.
 *
 * Lazy import on purpose. This file is statically reachable from
 * src/server/responses/core.ts (via codex/auth-context.ts), and
 * applyAccountQuotaFromUpstreamHeaders runs it once per pooled response. A static import
 * would load the observer, its config resolution, and its sink registry into every install,
 * including installs that never enable the feature — the same failure mode
 * tests/core-lab-boundary.test.ts exists to prevent for src/lab/.
 *
 * The previous snapshot is deliberately NOT passed. The observer keeps its own persisted
 * baseline (see swapLastObservedWindows), so every committed write must reach it — including
 * the first one, which is what establishes that baseline. An earlier version of this
 * function skipped the call when the in-map `existing` was undefined; that left the observer
 * with no baseline to compare against, so the write AFTER a rollover was silently treated as
 * the first observation and no reset ever fired.
 *
 * The snapshot is COPIED synchronously, before the import resolves. `next` is the live map
 * value and the next write mutates it, so an observation that read it after awaiting could
 * see a later snapshot than the one it was called for.
 *
 * Observations are SERIALIZED through a module-level promise chain, because the baseline
 * swap must happen in call order. An earlier version awaited two imports and then swapped,
 * and Bun does not resolve concurrent import() calls in call order: a burst of 21
 * rising-usage writes (10% -> 90%, no reset at all) arrived reordered and fired a false
 * "surprise" reset on every run. Worse, the false event CLAIMED the durable idempotence
 * key, so the genuine reset on that window was then permanently suppressed.
 *
 * `pendingObservation` is reassigned SYNCHRONOUSLY here, so each link is queued in call
 * order and only starts once the previous one has committed its baseline. A FIFO queue
 * entered after the await would not have fixed it — the enqueue itself would race.
 */
let pendingObservation: Promise<void> = Promise.resolve();

function notifyCodexQuotaSnapshot(accountId: string, next: StoredAccountQuota): void {
  // Copy before the boundary: `next` is the live map value and the following write mutates
  // it, so an observation that read it after awaiting could see a later snapshot than the
  // one it was called for.
  const snapshot = { ...next };
  pendingObservation = pendingObservation
    .then(async () => {
      const observer = await import("../quota/reset-observer");
      if (!observer.hasQuotaResetSink()) return;
      const { codexWindowObservations } = await import("../quota/window-mapping");
      observer.observeQuotaSnapshot({
        scope: "codex",
        accountKey: accountId,
        windows: codexWindowObservations(snapshot),
      });
    })
    .catch(() => {
      // Detection is best-effort: a quota write must never fail because of it. Swallowing
      // here also keeps the chain alive — a rejected link would poison every later one.
    });
}

/** Await the observation chain. Tests only: production never needs to join it. */
export function flushQuotaObservationsForTests(): Promise<void> {
  return pendingObservation;
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
  // Codex removed the 5-hour window and has now restored it for Plus and Team (Pro stays
  // weekly-only). A primary window that DECLARES a sub-day duration is a burst window: folding
  // it into weeklyPercent both discards the real weekly reading and leaves the account looking
  // exhausted long after the burst window resets. Duration decides, exactly as parseUsageQuota
  // already does for the WHAM payload — the two parsers must not disagree about the same data.
  const primaryIsShort = isExplicitShortWindowMinutes(primaryWindowMinutes);

  if (primaryIsMonthly) {
    if (primaryPercent !== undefined) {
      quota.monthlyPercent = primaryPercent;
      if (primaryResetAt !== undefined) quota.monthlyResetAt = primaryResetAt;
      // Same provenance rule as parseUsageQuota(): this monthly value is the governing
      // primary window, not a supplementary tertiary one. Not on the recovery path today,
      // but the two parsers must agree on what a bare monthlyPercent means.
      quota.monthlyIsPrimaryWindow = true;
    }
    if (secondaryPercent !== undefined) {
      quota.weeklyPercent = secondaryPercent;
      if (secondaryResetAt !== undefined) quota.weeklyResetAt = secondaryResetAt;
    }
  } else if (primaryIsShort) {
    if (primaryPercent !== undefined) quota.shortPercent = primaryPercent;
    if (primaryResetAt !== undefined) quota.shortResetAt = primaryResetAt;
    const minutes = windowMinutes_(primaryWindowMinutes);
    if (minutes !== undefined) quota.shortWindowSeconds = Math.round(minutes * 60);
    // The burst window vacates the primary slot, so the weekly reading is the secondary — which
    // is where it was all along. Without this the true weekly value is silently dropped.
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
  mainWriter?: MainQuotaWriter,
): void {
  const quota = parseUpstreamQuotaHeaders(headers);
  if (!quota) return;
  const policyQuota = [
    "x-codex-primary-used-percent", "x-codex-secondary-used-percent", "x-codex-tertiary-used-percent",
  ].some(name => isInvalidPolicyUsagePercent(headers.get(name))) ? null : filterMainPolicyMonthlyQuota(quota);
  setAccountQuotaFromParsed(accountId, quota, writerGeneration, mainWriter, policyQuota);
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
  const nextWeekly = normalizeUsagePercent(weekly);
  const nextMonthly = normalizeUsagePercent(monthly);
  if (nextWeekly === undefined && nextMonthly === undefined && resetCredits === undefined) return;
  hydrateAccountQuotasFromDisk();
  const existing = accountQuota.get(accountId);

  const quota: StoredAccountQuota = {
    ...(existing?.weeklyPercent !== undefined ? { weeklyPercent: existing.weeklyPercent } : {}),
    ...(existing?.monthlyPercent !== undefined ? { monthlyPercent: existing.monthlyPercent } : {}),
    // Carry provenance with the value it describes. Dropping it here would downgrade a proven
    // explicit-primary reading to "unproven" on the next unrelated weekly update.
    ...(existing?.monthlyPercent !== undefined && existing.monthlyIsPrimaryWindow === true
      ? { monthlyIsPrimaryWindow: true }
      : {}),
    ...(existing?.weeklyResetAt !== undefined ? { weeklyResetAt: existing.weeklyResetAt } : {}),
    ...(existing?.monthlyResetAt !== undefined ? { monthlyResetAt: existing.monthlyResetAt } : {}),
    ...(existing?.shortPercent !== undefined ? { shortPercent: existing.shortPercent } : {}),
    ...(existing?.shortObservedAt !== undefined ? { shortObservedAt: existing.shortObservedAt } : {}),
    ...(existing?.shortResetAt !== undefined ? { shortResetAt: existing.shortResetAt } : {}),
    ...(existing?.shortWindowSeconds !== undefined ? { shortWindowSeconds: existing.shortWindowSeconds } : {}),
    ...(existing?.customWindows !== undefined ? { customWindows: existing.customWindows } : {}),
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
    // A caller-supplied monthly value arrives without window provenance, so it REPLACES the
    // proven reading and must not inherit its flag — otherwise an unproven number would be
    // treated as governing evidence.
    delete quota.monthlyIsPrimaryWindow;
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  accountQuota.set(accountId, quota);
  // This legacy writer has no physical credential provenance.
  if (accountId === MAIN_CODEX_ACCOUNT_ID) mainPolicyQuota = null;
  schedulePersistAccountQuotas();
  // Observed like the other committed write. This function has no in-repo caller today, but it
  // is re-exported as public API through src/codex/auth-api.ts, so a future caller would
  // otherwise bypass detection AND leave a stale baseline that corrupts the next real diff.
  // The credits-only path at setAccountQuotaFromParsed deliberately does not notify; this one
  // writes window percentages and deadlines, so it must.
  notifyCodexQuotaSnapshot(accountId, quota);
}

/** Bounded, known policy fields only: disk input cannot extend a DTO or retain credentials. */
function readMainPolicyQuota(value: unknown): MainPolicyQuota | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.identityKey !== "string" || !/^[a-f0-9]{64}$/.test(entry.identityKey)) return null;
  if (!entry.quota || typeof entry.quota !== "object" || Array.isArray(entry.quota)) return null;
  const raw = entry.quota as Record<string, unknown>;
  if (typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return null;
  const quota: StoredAccountQuota = { updatedAt: raw.updatedAt };
  for (const field of ["weeklyPercent", "monthlyPercent", "shortPercent"] as const) {
    const number = raw[field];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 100) {
      quota[field] = number;
    }
  }
  for (const field of [
    "weeklyResetAt", "monthlyResetAt", "shortResetAt", "shortObservedAt", "shortWindowSeconds", "resetCredits",
  ] as const) {
    const number = raw[field];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) quota[field] = number;
  }
  if (quota.monthlyPercent !== undefined && raw.monthlyIsPrimaryWindow === true) quota.monthlyIsPrimaryWindow = true;
  return { identityKey: entry.identityKey, quota };
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
    // Policy evidence deliberately outlives the legacy six-hour rotation-cache TTL.
    mainPolicyQuota = readMainPolicyQuota(parsed.mainPolicyQuota);
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
      const body: QuotaDiskFile = {
        version: 1,
        quotas,
        ...(mainPolicyQuota ? { mainPolicyQuota } : {}),
      };
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

/** No physical-auth reads; unrelated legacy quota consumers cannot mutate this evidence. */
export function getMainPolicyQuota(): StoredAccountQuota | null {
  hydrateAccountQuotasFromDisk();
  if (!mainPolicyQuota || mainPolicyQuota.identityKey !== getObservedMainQuotaIdentityKey()) return null;
  return structuredClone(mainPolicyQuota.quota);
}

export function listAccountQuotas(): IterableIterator<[string, StoredAccountQuota]> {
  hydrateAccountQuotasFromDisk();
  return accountQuota.entries();
}

/**
 * Tell the observer to drop the baseline for a row that was deliberately cleared.
 *
 * Queued on the same chain as observations so it cannot overtake an in-flight one and be
 * immediately re-established by it. Without this, reauth of a used account left the observer
 * holding the pre-clear percentages and the first fresh write fired a false surprise reset
 * (measured 91% -> 0%).
 */
function forgetCodexQuotaBaseline(accountId?: string): void {
  pendingObservation = pendingObservation
    .then(async () => {
      const observer = await import("../quota/reset-observer");
      observer.forgetQuotaBaseline({
        scope: "codex",
        ...(accountId !== undefined ? { accountKey: accountId } : {}),
      });
    })
    .catch(() => {
      // Best-effort; a failure can only cost a re-baseline.
    });
}

export function clearAccountQuota(accountId?: string): void {
  if (accountId) {
    hydrateAccountQuotasFromDisk();
    accountQuota.delete(accountId);
    if (accountId === MAIN_CODEX_ACCOUNT_ID) mainPolicyQuota = null;
    schedulePersistAccountQuotas();
    forgetCodexQuotaBaseline(accountId);
    return;
  }
  accountQuota.clear();
  forgetCodexQuotaBaseline();
  mainPolicyQuota = null;
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

/** Supplementary monthly bars are not governing policy evidence without plan/primary proof. */
function filterMainPolicyMonthlyQuota(
  quota: Omit<StoredAccountQuota, "updatedAt"> | null,
  monthlyOnlyPlan = false,
): Omit<StoredAccountQuota, "updatedAt"> | null {
  if (!quota || monthlyOnlyPlan || quota.monthlyIsPrimaryWindow === true) return quota;
  const filtered = { ...quota };
  delete filtered.monthlyPercent;
  delete filtered.monthlyResetAt;
  delete filtered.monthlyIsPrimaryWindow;
  // Null retains the matching prior observation; an empty object would merge away evidence.
  return hasKnownQuotaValue(filtered) || filtered.resetCredits !== undefined ? filtered : null;
}

/** Ordinary main policy rejects an entire message containing any invalid numeric window. */
export function parseMainPolicyUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const windows = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window, data.rate_limit?.tertiary_window];
  if (windows.some(window => isInvalidPolicyUsagePercent(window?.used_percent))) return null;
  return filterMainPolicyMonthlyQuota(parseUsageQuota(data), isThirtyDayOnlyCodexPlan(data.plan_type));
}

export function parseUsageQuota(data: WhamUsageResponse): Omit<StoredAccountQuota, "updatedAt"> | null {
  const resetCredits = typeof data.rate_limit_reset_credits?.available_count === "number"
    ? data.rate_limit_reset_credits.available_count
    : undefined;

  if (!data.rate_limit) {
    if (data.additional_rate_limits?.length) {
      return parseUsageQuota({ ...data, rate_limit: {} });
    }
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
  // #1791: a primary window that declares a sub-day duration is a burst window, not the
  // weekly one. Skip it so the secondary (the real 7-day window) is what lands in
  // `weeklyPercent`; without this the 5-hour bar was reported as weekly and the actual
  // weekly reading was dropped on the floor.
  const primaryIsShort = isExplicitShortWindow(primaryWindow);
  const weeklyCandidatePercent = primaryIsShort ? undefined : primaryPercent;
  const weeklyCandidateResetAt = primaryIsShort ? undefined : primaryResetAt;
  // Retain the declared burst tuple even when its usage is unknown. Its shape selects
  // the short-window policy; a missing reading is not permission to fall back to weekly.
  if (primaryIsShort) {
    if (primaryPercent !== undefined) quota.shortPercent = primaryPercent;
    if (primaryResetAt !== undefined) quota.shortResetAt = primaryResetAt;
    const seconds = primaryWindow?.limit_window_seconds;
    if (typeof seconds === "number" && Number.isFinite(seconds)) quota.shortWindowSeconds = seconds;
  }
  const weeklyPercent = primaryIsMonthly ? secondaryPercent : weeklyCandidatePercent ?? secondaryPercent;
  const weeklyResetAt = primaryIsMonthly
    ? secondaryResetAt
    : weeklyCandidatePercent !== undefined ? weeklyCandidateResetAt : secondaryResetAt;
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
  // Provenance depends on the observed window, not the plan name. Go/Free need it
  // too so a real monthly-primary replacement can retire an earlier weekly policy tuple.
  // A supplementary value (including fallback from an unreadable primary) is not proof.
  if (primaryIsMonthly && primaryPercent !== undefined) quota.monthlyIsPrimaryWindow = true;

  const spark = data.additional_rate_limits?.find(additional => {
    const name = String(additional.limit_name ?? "").toLowerCase();
    const feature = String(additional.metered_feature ?? "").toLowerCase();
    return feature === "codex_bengalfox" || name.includes("gpt-5.3-codex-spark");
  });
  const sparkWindows = [spark?.rate_limit?.primary_window, spark?.rate_limit?.secondary_window]
    .filter((window): window is WhamUsageWindow => !!window);
  const sparkWeekly = sparkWindows.find(window => {
    const percent = normalizeUsagePercent(window.used_percent);
    const seconds = window.limit_window_seconds;
    return percent !== undefined
      && !isExplicitShortWindow(window)
      && !isExplicitMonthlyWindow(window)
      && (seconds === undefined || seconds >= WEEKLY_WINDOW_MIN_SECONDS);
  });
  const sparkPercent = normalizeUsagePercent(sparkWeekly?.used_percent);
  if (sparkPercent !== undefined) {
    const sparkWindow: { label: string; percent: number; resetAt?: number } = {
      label: "GPT-5.3-Codex-Spark Weekly",
      percent: sparkPercent,
    };
    const resetAt = normalizeResetAt(sparkWeekly?.reset_at);
    if (resetAt !== undefined) sparkWindow.resetAt = resetAt;
    quota.customWindows = [sparkWindow];
  }
  if (resetCredits !== undefined) quota.resetCredits = resetCredits;

  return hasKnownQuotaValue(quota) || resetCredits !== undefined ? quota : null;
}
