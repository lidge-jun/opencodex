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
import { useCallback, useEffect, useRef, useState } from "react";
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
  /** Settled ledger code, or `aborted`/`network` when the request never settled. */
  code: string;
  replayed: boolean;
}

export interface GrokResetCouponController {
  /** Absent id means "not read yet"; consumers render that as loading. */
  entries: Record<string, GrokCouponEntry>;
  refresh: (accountId: string) => Promise<void>;
  redeem: (accountId: string, request: { tokenId: string; operationId: string }) => Promise<GrokRedeemOutcome>;
}

const READ_TIMEOUT_MS = 20_000;
const REDEEM_TIMEOUT_MS = 30_000;
const MAX_READS_IN_FLIGHT = 3;

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
      if (typeof code === "string" && code !== "") return code;
    }
  }
  return "redeem_failed";
}

function settledCode(value: unknown): string {
  if (value && typeof value === "object") {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  return "redeemed";
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

function wasAborted(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

export function useGrokResetCoupons({ apiBase, accountIds, enabled }: {
  apiBase: string;
  accountIds: string[];
  enabled: boolean;
}): GrokResetCouponController {
  const [entries, setEntries] = useState<Record<string, GrokCouponEntry>>({});
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
    const bounded = createBoundedFetch(REDEEM_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/grok/reset-coupons/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, tokenId: request.tokenId, operationId: request.operationId }),
        signal: bounded.signal,
      });
      if (!response.ok) {
        return { ok: false, code: errorCode(await response.json().catch(() => null)), replayed: false };
      }
      const data = await response.json().catch(() => null) as unknown;
      const replayed = Boolean(data && typeof data === "object" && (data as { replayed?: unknown }).replayed === true);
      const code = settledCode(data);
      await read(accountId, epoch.current);
      return { ok: code === "redeemed", code, replayed };
    } catch (error) {
      // An aborted redemption is an unknown outcome, not a failure: the route may
      // still be executing it. The caller must stop posting, not retry.
      return { ok: false, code: wasAborted(error, bounded.signal) ? "aborted" : "network", replayed: false };
    } finally {
      bounded.clear();
    }
  }, [apiBase, read]);

  return { entries, refresh, redeem };
}
