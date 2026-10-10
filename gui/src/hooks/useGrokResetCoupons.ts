/**
 * useGrokResetCoupons — reads and redeems Grok billing reset coupons for xAI
 * OAuth accounts through the management API (`GET /api/grok/reset-coupons`,
 * `POST /api/grok/reset-coupons/consume`).
 *
 * Codex reset credits ride the quota payload, so its badge costs nothing. Grok
 * coupons come from a separate billing RPC with no server cache, so this hook
 * owns the reads and keeps at most three in flight.
 *
 * Two things here are load-bearing rather than stylistic:
 *
 * - The roster epoch and the per-account request token are separate. A single
 *   counter would let one row's retry discard every sibling read still in
 *   flight, stranding those badges on the placeholder with no way back.
 * - Redemption reports the settled `code`, not HTTP 200. The route replays a
 *   settled *failure* as 200 with `replayed: true` and the original code, so a
 *   client that reads only `replayed` tells the user a failed redemption
 *   succeeded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createBoundedFetch } from "../bounded-fetch";

export interface GrokResetCoupon {
  tokenId: string;
  /** ISO timestamp, or "" when upstream omitted the bound. */
  validityStart: string;
  validityEnd: string;
}

export type GrokCouponEntry =
  | { status: "loading" }
  | { status: "ready"; coupons: GrokResetCoupon[] }
  | { status: "error"; reason: "auth" | "upstream" };

export interface GrokRedeemOutcome {
  ok: boolean;
  /** Settled ledger code, or `aborted` when delivery may have succeeded. */
  code: string;
  replayed: boolean;
  operationId?: string;
  uncertain?: boolean;
}

export interface GrokCouponAttempt { tokenId: string; operationId: string }

export interface GrokResetCouponController {
  /** Absent id means "not read yet"; consumers render that as loading. */
  entries: Record<string, GrokCouponEntry>;
  /** Shared for the browser session so remounting cannot mint a new spend. */
  uncertain: Record<string, GrokCouponAttempt>;
  refresh: (accountId: string) => Promise<void>;
  redeem: (accountId: string, request: { tokenId: string; operationId: string }) => Promise<GrokRedeemOutcome>;
}

const READ_TIMEOUT_MS = 20_000;
const REDEEM_TIMEOUT_MS = 30_000;
const MAX_READS_IN_FLIGHT = 3;
const HOLD_STORAGE_KEY = "ocx.grok-coupon-holds.v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNRESOLVED_COUPON_CODES = new Set([
  "attempt_unresolved", "attempt_in_progress", "attempt_reconcile_failed",
  "operation_state_changed", "redeem_failed", "attempt_mark_failed", "operation_token_mismatch",
]);
const LEDGER_REFUSAL_CODES = new Set(["ledger_unavailable", "capacity"]);

// The Map is the admission authority even if sessionStorage is denied. Snapshot
// identity changes only on a write, allowing old controllers to notify new ones.
let couponHolds = new Map<string, GrokCouponAttempt>();
const holdListeners = new Set<() => void>();
let lastStoredHolds: string | null | undefined;

function validHold(value: unknown): value is GrokCouponAttempt {
  if (!value || typeof value !== "object") return false;
  const { tokenId, operationId } = value as Record<string, unknown>;
  return typeof tokenId === "string" && tokenId.trim() !== ""
    && typeof operationId === "string" && UUID_V4.test(operationId);
}

function holdSnapshot(): ReadonlyMap<string, GrokCouponAttempt> {
  try {
    const stored = window.sessionStorage.getItem(HOLD_STORAGE_KEY);
    if (stored !== lastStoredHolds) {
      lastStoredHolds = stored;
      const parsed: unknown = stored === null ? null : JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (!key.includes("\u0000") || !validHold(value)) continue;
          // Storage only restores holds this page has lost; it never replaces a live hold.
          if (couponHolds.has(key)) continue;
          couponHolds = new Map(couponHolds).set(key, { tokenId: value.tokenId, operationId: value.operationId });
        }
      }
    }
  } catch { /* Storage access or invalid JSON cannot erase an in-memory hold. */ }
  return couponHolds;
}

function subscribeHolds(listener: () => void): () => void {
  holdListeners.add(listener);
  return () => { holdListeners.delete(listener); };
}

function publishHolds(): void {
  try {
    const stored = JSON.stringify(Object.fromEntries(couponHolds));
    window.sessionStorage.setItem(HOLD_STORAGE_KEY, stored);
    lastStoredHolds = stored;
  } catch { /* The Map remains authoritative when persistence is unavailable. */ }
  for (const listener of holdListeners) listener();
}

function writeHold(key: string, attempt: GrokCouponAttempt): void {
  couponHolds = new Map(couponHolds).set(key, { ...attempt });
  publishHolds();
}

function clearHold(key: string, operationId: string): void {
  if (holdSnapshot().get(key)?.operationId !== operationId) return;
  couponHolds = new Map(couponHolds);
  couponHolds.delete(key);
  publishHolds();
}

function unresolvedCode(code: string, body: unknown): boolean {
  return UNRESOLVED_COUPON_CODES.has(code) || (LEDGER_REFUSAL_CODES.has(code)
    && Boolean(body && typeof body === "object" && "operationId" in body));
}

function parseCoupons(value: unknown): GrokResetCoupon[] | null {
  if (!value || typeof value !== "object") return null;
  const tokens = (value as { tokens?: unknown }).tokens;
  if (!Array.isArray(tokens)) return null;
  const coupons: GrokResetCoupon[] = [];
  for (const token of tokens) {
    if (!token || typeof token !== "object") return null;
    const { tokenId, validityStart, validityEnd } = token as Record<string, unknown>;
    // One malformed entry rejects the list: a partially parsed set of coupons is
    // worse than an error badge, because the dialog would spend from it.
    if (typeof tokenId !== "string" || tokenId === "") return null;
    coupons.push({
      tokenId,
      validityStart: typeof validityStart === "string" ? validityStart : "",
      validityEnd: typeof validityEnd === "string" ? validityEnd : "",
    });
  }
  return coupons;
}

function errorCode(value: unknown): string {
  if (value && typeof value === "object") {
    const error = (value as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.trim() !== "") return code;
    }
  }
  return "redeem_failed";
}

function settledCode(value: unknown): string | null {
  if (value && typeof value === "object") {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && code.trim() !== "") return code;
  }
  return null;
}

function expiryRank(coupon: GrokResetCoupon): number {
  if (!coupon.validityEnd) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(coupon.validityEnd);
  // An unparsable bound sorts last rather than collapsing the comparator, so a
  // malformed timestamp cannot present itself as the nearest expiry.
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function byExpiry(coupons: GrokResetCoupon[]): GrokResetCoupon[] {
  return coupons.toSorted((a, b) => expiryRank(a) - expiryRank(b));
}

export function useGrokResetCoupons({ apiBase, accountIds, enabled }: {
  apiBase: string;
  accountIds: string[];
  enabled: boolean;
}): GrokResetCouponController {
  const [entries, setEntries] = useState<Record<string, GrokCouponEntry>>({});
  const holds = useSyncExternalStore(subscribeHolds, holdSnapshot, holdSnapshot);
  const uncertain = useMemo(() => {
    const prefix = `${apiBase}\u0000`;
    return Object.fromEntries([...holds].filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]));
  }, [apiBase, holds]);
  /** Roster epoch: bumped only by the effect and its cleanup. */
  const epoch = useRef(0);
  /** Per-account request token, so one row's retry cannot cancel another row's read. */
  const tokens = useRef(new Map<string, number>());
  const gate = useRef<{ active: number; waiting: Array<() => void> }>({ active: 0, waiting: [] });
  const identity = accountIds.join("\u0000");

  // No synchronous setState here: the effect below calls this directly, and a
  // state write before the first await is what react-compiler's EffectSetState
  // rule forbids. `refresh` owns the visible loading state instead.
  const read = useCallback(async (accountId: string, rosterEpoch: number) => {
    const token = (tokens.current.get(accountId) ?? 0) + 1;
    tokens.current.set(accountId, token);

    const queue = gate.current;
    if (queue.active >= MAX_READS_IN_FLIGHT) {
      await new Promise<void>(resolve => queue.waiting.push(resolve));
    }
    queue.active += 1;

    const current = () => epoch.current === rosterEpoch && tokens.current.get(accountId) === token;
    const bounded = createBoundedFetch(READ_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${apiBase}/api/grok/reset-coupons?accountId=${encodeURIComponent(accountId)}`,
        { signal: bounded.signal },
      );
      const coupons = response.ok ? parseCoupons(await response.json().catch(() => null)) : null;
      if (!current()) return;
      setEntries(existing => ({
        ...existing,
        [accountId]: coupons
          ? { status: "ready", coupons: byExpiry(coupons) }
          : { status: "error", reason: response.status === 401 ? "auth" : "upstream" },
      }));
    } catch {
      if (!current()) return;
      setEntries(existing => ({ ...existing, [accountId]: { status: "error", reason: "upstream" } }));
    } finally {
      bounded.clear();
      queue.active -= 1;
      queue.waiting.shift()?.();
    }
  }, [apiBase]);

  useEffect(() => {
    if (!enabled || identity === "") return;
    const rosterEpoch = ++epoch.current;
    // Deferred to a microtask, the same shape the account-pool hook uses: the
    // reads write state, and starting them inside the effect body is what the
    // react-compiler lint refuses.
    void Promise.resolve().then(() => {
      for (const accountId of identity.split("\u0000")) void read(accountId, rosterEpoch);
    });
    // A later roster or unmount retires in-flight reads instead of writing stale
    // coupon counts onto whatever account now occupies that row.
    return () => { epoch.current += 1; };
  }, [enabled, identity, read]);

  const refresh = useCallback(async (accountId: string) => {
    setEntries(current => ({ ...current, [accountId]: { status: "loading" } }));
    await read(accountId, epoch.current);
  }, [read]);

  const redeem = useCallback(async (
    accountId: string,
    request: { tokenId: string; operationId: string },
  ): Promise<GrokRedeemOutcome> => {
    const key = `${apiBase}\u0000${accountId}`;
    const hold = (attempt: GrokCouponAttempt, code = "attempt_unresolved"): GrokRedeemOutcome => (
      { ok: false, code, replayed: false, operationId: attempt.operationId, uncertain: true }
    );
    const held = holdSnapshot().get(key);
    if (held) return hold(held);
    // Record intent before dispatch. Uncertain completions leave this entry in
    // place; they never reinsert an older attempt over a newer operation.
    writeHold(key, request);
    const clearMatchingHold = () => clearHold(key, request.operationId);
    const bounded = createBoundedFetch(REDEEM_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/grok/reset-coupons/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, tokenId: request.tokenId, operationId: request.operationId }),
        signal: bounded.signal,
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = errorCode(data);
        if (unresolvedCode(code, data)) return hold(request, code);
        clearMatchingHold();
        return { ok: false, code, replayed: false };
      }
      const replayed = Boolean(data && typeof data === "object" && (data as { replayed?: unknown }).replayed === true);
      const code = settledCode(data);
      // A settled body never legitimately carries a ledger refusal code.
      if (code === null || unresolvedCode(code, data) || LEDGER_REFUSAL_CODES.has(code)) return hold(request, code ?? "attempt_unresolved");
      clearMatchingHold();
      await read(accountId, epoch.current);
      return { ok: code === "redeemed", code, replayed };
    } catch {
      // Any transport rejection after dispatch has an unknown outcome: the route
      // may still be executing it. The caller must stop posting, not retry.
      return hold(request, "aborted");
    } finally {
      bounded.clear();
    }
  }, [apiBase, read]);

  return { entries, uncertain, refresh, redeem };
}
