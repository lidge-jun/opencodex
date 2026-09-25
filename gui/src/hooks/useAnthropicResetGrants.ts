/**
 * useAnthropicResetGrants — reads and spends Claude usage-limit reset grants for
 * Anthropic OAuth accounts through `GET /api/anthropic/reset-grants` and
 * `POST /api/anthropic/reset-grants/consume`.
 *
 * Same read discipline as useGrokResetCoupons: one read per account, at most
 * three in flight, a roster epoch plus a per-account token so one row's retry
 * never discards a sibling's read.
 *
 * Spend truth is the settled `code` in a 200 body, never the HTTP status alone.
 * Every answer that leaves the outcome open (transport failure, 502
 * `unknown_outcome`, 500 `journal_write_failed`, 409 `in_flight`) is reported as
 * `unknown` so the dialog keeps the operation id and can only retry that same id.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createBoundedFetch } from "../bounded-fetch";

export type AnthropicResetWindow = "five_hour" | "seven_day" | "seven_day_overage_included";

export interface AnthropicResetGrant {
  id: string;
  label: string;
  resetsTotal: number;
  resetsLeft: number;
  startsAt: string | null;
  endsAt: string | null;
  clears: AnthropicResetWindow[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  percentUsed: Partial<Record<AnthropicResetWindow, number>>;
}

export interface AnthropicPendingOperation {
  operationId: string;
  grantId: string;
  retryableUntil: number;
}

export interface AnthropicResetGrantSnapshot {
  eligible: boolean;
  atLimit: boolean;
  grants: AnthropicResetGrant[];
  pendingOperation: AnthropicPendingOperation | null;
  journalAvailable: boolean;
}

export type AnthropicGrantEntry =
  | { status: "loading" }
  | { status: "ready"; snapshot: AnthropicResetGrantSnapshot }
  | { status: "error"; reason: "auth" | "upstream" };

export type AnthropicSpendOutcome =
  | { kind: "settled"; code: string; replayed: boolean; resetsLeft: number | null }
  | { kind: "unknown"; code: string }
  | { kind: "refused"; code: string };

export interface AnthropicResetGrantController {
  entries: Record<string, AnthropicGrantEntry>;
  refresh: (accountId: string) => Promise<void>;
  spend: (accountId: string, request: { grantId: string; operationId: string }) => Promise<AnthropicSpendOutcome>;
}

const READ_TIMEOUT_MS = 20_000;
/** Upstream claim bound (25 s) plus the profile and gate reads in front of it. */
const SPEND_TIMEOUT_MS = 60_000;
const MAX_READS_IN_FLIGHT = 3;
const WINDOWS: readonly AnthropicResetWindow[] = ["five_hour", "seven_day", "seven_day_overage_included"];
const UNKNOWN_CODES = new Set(["unknown_outcome", "journal_write_failed", "in_flight"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function parseGrant(value: unknown): AnthropicResetGrant | null {
  if (!isRecord(value)) return null;
  const { id, label, resetsTotal, resetsLeft, paused, usableNow, useRequiresLimit } = value;
  const startsAt = nullableString(value.startsAt);
  const endsAt = nullableString(value.endsAt);
  if (typeof id !== "string" || id === "" || typeof label !== "string"
    || typeof resetsTotal !== "number" || typeof resetsLeft !== "number"
    || typeof paused !== "boolean" || typeof usableNow !== "boolean" || typeof useRequiresLimit !== "boolean"
    || startsAt === undefined || endsAt === undefined || !Array.isArray(value.clears)) return null;
  const percentUsed: Partial<Record<AnthropicResetWindow, number>> = {};
  if (isRecord(value.percentUsed)) {
    for (const window of WINDOWS) {
      const percent = value.percentUsed[window];
      if (typeof percent === "number") percentUsed[window] = percent;
    }
  }
  return {
    id, label, resetsTotal, resetsLeft, startsAt, endsAt, paused, usableNow, useRequiresLimit, percentUsed,
    clears: WINDOWS.filter(window => (value.clears as unknown[]).includes(window)),
  };
}

/** One malformed grant rejects the snapshot: the dialog spends from this list. */
export function parseAnthropicGrantSnapshot(value: unknown): AnthropicResetGrantSnapshot | null {
  if (!isRecord(value) || typeof value.eligible !== "boolean" || !Array.isArray(value.grants)) return null;
  const grants: AnthropicResetGrant[] = [];
  for (const raw of value.grants) {
    const grant = parseGrant(raw);
    if (!grant) return null;
    grants.push(grant);
  }
  let pendingOperation: AnthropicPendingOperation | null = null;
  const pending = value.pendingOperation;
  if (isRecord(pending) && typeof pending.operationId === "string" && typeof pending.grantId === "string"
    && typeof pending.retryableUntil === "number") {
    pendingOperation = { operationId: pending.operationId, grantId: pending.grantId, retryableUntil: pending.retryableUntil };
  }
  return {
    eligible: value.eligible,
    atLimit: value.atLimit === true,
    grants,
    pendingOperation,
    journalAvailable: value.journalAvailable !== false,
  };
}

/** Resets still unspent across grants; what the badge counts. */
export function unspentResets(snapshot: AnthropicResetGrantSnapshot): number {
  if (!snapshot.eligible) return 0;
  return snapshot.grants.reduce((total, grant) => total + grant.resetsLeft, 0);
}

/** The grant a spend would use: the first one the server's gate would accept now. */
export function spendableGrant(snapshot: AnthropicResetGrantSnapshot): AnthropicResetGrant | undefined {
  if (!snapshot.eligible || !snapshot.journalAvailable) return undefined;
  return snapshot.grants.find(grant => !grant.paused && grant.usableNow && grant.resetsLeft > 0
    && (!grant.useRequiresLimit || snapshot.atLimit));
}

function errorCode(value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" && value.error.code !== "") {
    return value.error.code;
  }
  return "failed";
}

export function useAnthropicResetGrants({ apiBase, accountIds, enabled }: {
  apiBase: string;
  accountIds: string[];
  enabled: boolean;
}): AnthropicResetGrantController {
  const [entries, setEntries] = useState<Record<string, AnthropicGrantEntry>>({});
  const epoch = useRef(0);
  const tokens = useRef(new Map<string, number>());
  const gate = useRef<{ active: number; waiting: Array<() => void> }>({ active: 0, waiting: [] });
  const identity = accountIds.join("\u0000");

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
        `${apiBase}/api/anthropic/reset-grants?accountId=${encodeURIComponent(accountId)}`,
        { signal: bounded.signal },
      );
      const snapshot = response.ok ? parseAnthropicGrantSnapshot(await response.json().catch(() => null)) : null;
      if (!current()) return;
      setEntries(existing => ({
        ...existing,
        [accountId]: snapshot
          ? { status: "ready", snapshot }
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
    void Promise.resolve().then(() => {
      for (const accountId of identity.split("\u0000")) void read(accountId, rosterEpoch);
    });
    return () => { epoch.current += 1; };
  }, [enabled, identity, read]);

  const refresh = useCallback(async (accountId: string) => {
    setEntries(current => ({ ...current, [accountId]: { status: "loading" } }));
    await read(accountId, epoch.current);
  }, [read]);

  const spend = useCallback(async (
    accountId: string,
    request: { grantId: string; operationId: string },
  ): Promise<AnthropicSpendOutcome> => {
    const bounded = createBoundedFetch(SPEND_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase}/api/anthropic/reset-grants/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, grantId: request.grantId, operationId: request.operationId }),
        signal: bounded.signal,
      });
      if (!response.ok) {
        const code = errorCode(await response.json().catch(() => null));
        return UNKNOWN_CODES.has(code) ? { kind: "unknown", code } : { kind: "refused", code };
      }
      const data = await response.json().catch(() => null) as unknown;
      if (!isRecord(data) || typeof data.code !== "string") return { kind: "unknown", code: "unknown_outcome" };
      void read(accountId, epoch.current);
      return {
        kind: "settled",
        code: data.code,
        replayed: data.replayed === true,
        resetsLeft: typeof data.resetsLeft === "number" ? data.resetsLeft : null,
      };
    } catch {
      // Delivery may have happened: the caller keeps the id and may only retry it.
      return { kind: "unknown", code: "aborted" };
    } finally {
      bounded.clear();
    }
  }, [apiBase, read]);

  return { entries, refresh, spend };
}
