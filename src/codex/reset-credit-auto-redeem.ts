import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";
import type { OcxConfig } from "../types";

/**
 * Opt-in auto-redemption of a Codex reset credit shortly before it expires (#822).
 *
 * Default off. When enabled, the nearest unexpired credit for the main Codex account is
 * redeemed `leadTimeMinutes` before its `expires_at`. Every fire re-reads the upstream credit
 * list first and dispatches only when the same credit (granted_at + expires_at) is still
 * present, so a credit the operator already spent by hand is never redeemed twice. The
 * `redeem_request_id` for a credit identity is minted once and journaled to disk before the
 * consume call, so a crash between dispatch and settle replays the same idempotent request
 * instead of spending a second credit. Logs carry a hashed account key only.
 */

export interface ResetCreditAutoRedeemSettings {
  enabled: boolean;
  leadTimeMinutes: number;
}

export const DEFAULT_LEAD_TIME_MINUTES = 10;
export const MIN_LEAD_TIME_MINUTES = 1;
export const MAX_LEAD_TIME_MINUTES = 60;

export function resolveResetCreditAutoRedeemSettings(config: Pick<OcxConfig, "resetCreditAutoRedeem">): ResetCreditAutoRedeemSettings {
  const raw = config.resetCreditAutoRedeem;
  if (!raw || raw.enabled !== true) return { enabled: false, leadTimeMinutes: DEFAULT_LEAD_TIME_MINUTES };
  const lead = typeof raw.leadTimeMinutes === "number" && Number.isInteger(raw.leadTimeMinutes)
    ? Math.min(Math.max(raw.leadTimeMinutes, MIN_LEAD_TIME_MINUTES), MAX_LEAD_TIME_MINUTES)
    : DEFAULT_LEAD_TIME_MINUTES;
  return { enabled: true, leadTimeMinutes: lead };
}

export interface ResetCredit {
  granted_at: string;
  expires_at: string;
}

export interface AutoRedeemPlan {
  /** Stable identity of the credit being protected. */
  grantedAt: string;
  expiresAt: string;
  /** Epoch ms at which the redeem should be attempted. */
  dueAt: number;
}

/** Pick the credit that expires soonest and is still in the future; null when nothing qualifies. */
export function planAutoRedeem(now: number, credits: readonly ResetCredit[], settings: ResetCreditAutoRedeemSettings): AutoRedeemPlan | null {
  if (!settings.enabled) return null;
  let best: AutoRedeemPlan | null = null;
  for (const credit of credits) {
    const expires = Date.parse(credit.expires_at);
    if (!Number.isFinite(expires) || expires <= now) continue;
    const dueAt = expires - settings.leadTimeMinutes * 60_000;
    if (!best || expires < Date.parse(best.expiresAt)) best = { grantedAt: credit.granted_at, expiresAt: credit.expires_at, dueAt };
  }
  return best;
}

export function creditStillPresent(credits: readonly ResetCredit[], plan: Pick<AutoRedeemPlan, "grantedAt" | "expiresAt">): boolean {
  return credits.some(c => c.granted_at === plan.grantedAt && c.expires_at === plan.expiresAt);
}

interface JournalEntry {
  accountKey: string;
  grantedAt: string;
  expiresAt: string;
  redeemRequestId: string;
  state: "dispatched" | "settled";
  updatedAt: number;
}

interface Journal { version: 1; entries: JournalEntry[] }

export function journalPath(): string {
  return join(getConfigDir(), "reset-credit-auto-redeem.json");
}

function readJournal(path: string): Journal {
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Journal;
    return parsed && parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeJournal(path: string, journal: Journal): void {
  // Keep only entries whose credit could still matter: settled ones older than a week are noise.
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  journal.entries = journal.entries.filter(e => e.state !== "settled" || e.updatedAt > cutoff);
  atomicWriteFile(path, JSON.stringify(journal, null, 2));
}

export function hashAccountKey(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex").slice(0, 12);
}

export interface AutoRedeemDeps {
  accountId: string;
  settings: () => ResetCreditAutoRedeemSettings;
  /** Fresh upstream read of the credit list; throws on auth/transport failure. */
  inspect: () => Promise<{ credits: ResetCredit[] }>;
  /** Consume with a caller-owned idempotency key. Returns the upstream code. */
  consume: (redeemRequestId: string) => Promise<{ code: string }>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  journalFile?: string;
  log?: (line: string) => void;
  /** Upper bound on one sleep so a laptop sleep or clock jump re-checks rather than trusting a stale plan. */
  maxSleepMs?: number;
  /** Interval to re-inspect when no credit is due yet (default 30 min). */
  idleRecheckMs?: number;
}

export type AutoRedeemOutcome =
  | { kind: "disabled" }
  | { kind: "nothing-to-protect" }
  | { kind: "scheduled"; dueAt: number }
  | { kind: "skipped"; reason: "credit-gone" | "disabled-before-dispatch" }
  | { kind: "dispatched"; code: string; redeemRequestId: string }
  | { kind: "ambiguous"; redeemRequestId: string }
  | { kind: "error"; message: string };

export interface ResetCreditAutoRedeemer {
  /** Inspect, and either dispatch (if due) or schedule the next check. */
  tick(): Promise<AutoRedeemOutcome>;
  start(): void;
  stop(): void;
}

export function createResetCreditAutoRedeemer(deps: AutoRedeemDeps): ResetCreditAutoRedeemer {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = deps.log ?? ((line: string) => console.log(line));
  const path = deps.journalFile ?? journalPath();
  const accountKey = hashAccountKey(deps.accountId);
  const maxSleepMs = deps.maxSleepMs ?? 15 * 60_000;
  const idleRecheckMs = deps.idleRecheckMs ?? 30 * 60_000;
  let handle: unknown = null;
  let stopped = false;
  let inFlight: Promise<AutoRedeemOutcome> | null = null;

  const schedule = (ms: number): void => {
    if (stopped) return;
    if (handle !== null) clearTimer(handle);
    handle = setTimer(() => { handle = null; void tick(); }, Math.max(0, Math.min(ms, maxSleepMs)));
  };

  const dispatch = async (plan: AutoRedeemPlan): Promise<AutoRedeemOutcome> => {
    const journal = readJournal(path);
    let entry = journal.entries.find(e => e.accountKey === accountKey && e.grantedAt === plan.grantedAt && e.expiresAt === plan.expiresAt);
    if (entry?.state === "settled") return { kind: "skipped", reason: "credit-gone" };
    if (!entry) {
      entry = { accountKey, grantedAt: plan.grantedAt, expiresAt: plan.expiresAt, redeemRequestId: randomUUID(), state: "dispatched", updatedAt: now() };
      journal.entries.push(entry);
      // Journal BEFORE the network call: a crash after this line replays the same request id.
      writeJournal(path, journal);
    }
    log(`[opencodex] reset-credit auto-redeem: dispatching for account ${accountKey} (credit expires ${plan.expiresAt})`);
    let result: { code: string };
    try {
      result = await deps.consume(entry.redeemRequestId);
    } catch (error) {
      log(`[opencodex] reset-credit auto-redeem: consume uncertain for account ${accountKey}; will retry with the same request id`);
      schedule(60_000);
      return { kind: "ambiguous", redeemRequestId: entry.redeemRequestId };
    }
    entry.state = "settled";
    entry.updatedAt = now();
    writeJournal(path, journal);
    log(`[opencodex] reset-credit auto-redeem: upstream answered ${result.code} for account ${accountKey}`);
    schedule(idleRecheckMs);
    return { kind: "dispatched", code: result.code, redeemRequestId: entry.redeemRequestId };
  };

  const tick = async (): Promise<AutoRedeemOutcome> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const settings = deps.settings();
      if (!settings.enabled) return { kind: "disabled" } as AutoRedeemOutcome;
      let credits: ResetCredit[];
      try {
        ({ credits } = await deps.inspect());
      } catch (error) {
        schedule(idleRecheckMs);
        return { kind: "error", message: error instanceof Error ? error.message : "inspect failed" } as AutoRedeemOutcome;
      }
      const plan = planAutoRedeem(now(), credits, settings);
      if (!plan) { schedule(idleRecheckMs); return { kind: "nothing-to-protect" } as AutoRedeemOutcome; }
      if (plan.dueAt > now()) { schedule(plan.dueAt - now()); return { kind: "scheduled", dueAt: plan.dueAt } as AutoRedeemOutcome; }
      // Due: re-read right before spending. The plan above came from this same inspect, but
      // the settings may have flipped and a manual consume may have raced; check both again.
      if (!deps.settings().enabled) return { kind: "skipped", reason: "disabled-before-dispatch" } as AutoRedeemOutcome;
      let fresh: ResetCredit[];
      try { ({ credits: fresh } = await deps.inspect()); } catch (error) {
        schedule(60_000);
        return { kind: "error", message: error instanceof Error ? error.message : "inspect failed" } as AutoRedeemOutcome;
      }
      if (!creditStillPresent(fresh, plan)) { schedule(idleRecheckMs); return { kind: "skipped", reason: "credit-gone" } as AutoRedeemOutcome; }
      return dispatch(plan);
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    tick,
    start() { stopped = false; void tick(); },
    stop() { stopped = true; if (handle !== null) { clearTimer(handle); handle = null; } },
  };
}

/**
 * Composition-root activation. Returns the redeemer only when the opt-in is on; the caller
 * (src/server/index.ts) must not await this and must gate on `enabled` itself so a default
 * install never constructs the timer.
 */
export function activateResetCreditAutoRedeem(
  config: OcxConfig,
  wham: Pick<AutoRedeemDeps, "inspect" | "consume" | "accountId">,
): ResetCreditAutoRedeemer {
  const redeemer = createResetCreditAutoRedeemer({
    ...wham,
    settings: () => resolveResetCreditAutoRedeemSettings(config),
  });
  const unregister = registerOptionalShutdownHook("reset-credit-auto-redeem", () => { redeemer.stop(); unregister(); });
  redeemer.start();
  return redeemer;
}
