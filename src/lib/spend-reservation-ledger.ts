/**
 * Durable token spend reservation, above the send-count workflow guard (#4546).
 *
 * The count cap treats a 1k-token send and a 150k-token send as the same unit, and the
 * in-memory ledger forgets everything on restart: an exhausted root came back with a fresh
 * allowance after every relaunch, and a second process never saw the first one's spend at
 * all. This ledger reserves TOKENS before dispatch and rebuilds its state from a journal
 * under the opencodex home directory, so an exhausted scope is still exhausted after a
 * restart.
 *
 * A reservation is always the request's whole input plus its ENFORCEABLE output ceiling --
 * the caller's max_output_tokens, or the model's documented cap when the caller sent none.
 * Never an optimistic estimate, and never shrunk by a cache-hit expectation: a prefix that
 * misses is billed in full, so the safety figure reserves as if it misses. Cache
 * expectations may inform efficiency reporting; they do not move this number.
 *
 * Admission requires, at every scope that applies at once -- root workflow, authenticated
 * identity, and account pool:
 *
 *   settled spend + in-flight reservations + unresolved spend + this reservation <= limit
 *
 * Unresolved spend is the conservative residue of a send whose usage frame was lost: the
 * tokens may have been billed, so the reservation is moved to unresolved rather than
 * released. Minting a new root id mints no new budget because the identity and pool scopes
 * still hold the spend.
 *
 * SUPPORTED TOPOLOGY: this guarantees a single proxy process against its own journal. The
 * file is append-friendly, but nothing here serializes two live processes writing it, so a
 * second proxy sharing the same OPENCODEX_HOME is explicitly outside the guarantee -- that
 * needs a shared store with cross-process atomicity and is declared out of scope rather
 * than implied.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Definition-site import, not the ../config barrel -- same reasoning as
// src/quota/reset-seen-store.ts: the barrel pulls ~154 modules into a hot path.
import { getConfigDir } from "../config/paths";
import { assertNotRealHomeUnderTest } from "./test-home-guard";

export const SPEND_LEDGER_JOURNAL_FILENAME = "spend-ledger.jsonl";

export type SpendScope = "root" | "identity" | "pool";

export interface SpendScopeLimit {
  /**
   * Approved token ceiling for the scope. Undefined means OBSERVE ONLY: spend is still
   * accounted and reported, but nothing is refused. That is the unconfigured default --
   * an install that never opted in keeps the count caps and is not newly refused.
   */
  readonly maxTokens?: number;
}

export interface SpendReservationPolicy {
  readonly root: SpendScopeLimit;
  readonly identity: SpendScopeLimit;
  readonly pool: SpendScopeLimit;
  /**
   * How long a dormant scope's accounting is retained. A scope may be dropped only when it
   * is BOTH inactive (no open reservation) AND not exhausted inside this window; dropping
   * an exhausted scope would hand it a fresh allowance on next use.
   */
  readonly retentionMs: number;
}

/**
 * Unconfigured default: every limit undefined, so token accounting runs in observe-only
 * mode and the count caps remain the only enforcement. Real numbers belong behind
 * explicit operator configuration.
 */
export const DEFAULT_SPEND_RESERVATION_POLICY: SpendReservationPolicy = {
  root: {},
  identity: {},
  pool: {},
  retentionMs: 7 * 24 * 60 * 60_000,
};

export interface SpendScopes {
  readonly rootId?: string;
  readonly identityId?: string;
  readonly poolId?: string;
}

export interface SpendUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface SpendReservationRequest {
  /** Stable id of the physical send. Settlement is idempotent on this key. */
  readonly sendId: string;
  readonly scopes: SpendScopes;
  readonly inputTokens: number;
  /** Enforceable output ceiling -- max_output_tokens or the model's documented cap. */
  readonly outputCeilingTokens: number;
  readonly at?: number;
}

export type SpendDenial = {
  readonly reason: "spend-limit-exceeded";
  readonly scope: SpendScope;
  readonly scopeId: string;
  readonly limit: number;
  readonly projected: number;
};

export type SpendReservationDecision =
  | { readonly reserved: true; readonly sendId: string; readonly tokens: number }
  | { readonly reserved: false; readonly denial: SpendDenial };

interface ScopeState {
  settled: number;
  reserved: number;
  unresolved: number;
  lastSeenAt: number;
}

interface Reservation {
  readonly scopes: SpendScopes;
  readonly tokens: number;
  status: "open" | "settled" | "lost";
  readonly at: number;
}

type JournalRecord =
  | { v: 1; kind: "reserve"; sendId: string; scopes: SpendScopes; tokens: number; at: number }
  | { v: 1; kind: "settle"; sendId: string; tokens: number; at: number }
  | { v: 1; kind: "lost"; sendId: string; at: number };

/**
 * Append-only persistence. `read` returns raw lines so replay tolerates a torn tail write:
 * an unparseable final line is skipped, which loses at most the record that never made it
 * to disk intact.
 */
export interface SpendJournal {
  read(): string[];
  append(line: string): void;
}

export function createFileSpendJournal(path: string): SpendJournal {
  return {
    read(): string[] {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    },
    append(line: string): void {
      const dir = dirname(path);
      // The guard runs before any mutation so a rejected write leaves nothing behind.
      assertNotRealHomeUnderTest(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(path, line + "\n", { encoding: "utf8", mode: 0o600 });
    },
  };
}

export interface ScopeSpendSnapshot {
  readonly settled: number;
  readonly reserved: number;
  readonly unresolved: number;
  readonly exhausted: boolean;
}

export interface SpendReservationLedger {
  reserve(request: SpendReservationRequest): SpendReservationDecision;
  /**
   * Settle with real usage. Returns false when the send is unknown or already resolved --
   * double settlement is as wrong as none, so a repeat call changes nothing.
   */
  settle(sendId: string, usage: SpendUsage): boolean;
  /**
   * Usage never arrived. The reservation moves to unresolved spend -- it may have been
   * billed -- rather than being released. Idempotent on the same key as settle.
   */
  markLost(sendId: string): boolean;
  snapshot(scope: SpendScope, scopeId: string): ScopeSpendSnapshot | undefined;
  exhausted(scope: SpendScope, scopeId: string): boolean;
  /** Drop dormant scopes per the retention rule in SpendReservationPolicy. */
  prune(now?: number): void;
  /** Journal writes that failed; a nonzero count means durability is degraded. */
  readonly persistFailures: number;
}

const scopeKey = (scope: SpendScope, id: string): string => scope + "\0" + id;

const sanitizeTokens = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

export function createSpendReservationLedger(options: {
  readonly journal?: SpendJournal;
  readonly policy?: SpendReservationPolicy;
  readonly now?: () => number;
} = {}): SpendReservationLedger {
  const policy = options.policy ?? DEFAULT_SPEND_RESERVATION_POLICY;
  const journal = options.journal;
  const now = options.now ?? (() => Date.now());
  const scopes = new Map<string, ScopeState>();
  const reservations = new Map<string, Reservation>();
  let persistFailures = 0;

  const scopeState = (scope: SpendScope, id: string): ScopeState => {
    const key = scopeKey(scope, id);
    let state = scopes.get(key);
    if (!state) {
      state = { settled: 0, reserved: 0, unresolved: 0, lastSeenAt: 0 };
      scopes.set(key, state);
    }
    return state;
  };

  const limitFor = (scope: SpendScope): number | undefined => policy[scope].maxTokens;

  const isExhausted = (scope: SpendScope, state: ScopeState): boolean => {
    const limit = limitFor(scope);
    return limit !== undefined && state.settled + state.reserved + state.unresolved >= limit;
  };

  const eachScope = (targets: SpendScopes, fn: (scope: SpendScope, id: string, state: ScopeState) => void): void => {
    if (targets.rootId !== undefined) fn("root", targets.rootId, scopeState("root", targets.rootId));
    if (targets.identityId !== undefined) fn("identity", targets.identityId, scopeState("identity", targets.identityId));
    if (targets.poolId !== undefined) fn("pool", targets.poolId, scopeState("pool", targets.poolId));
  };

  const append = (record: JournalRecord): void => {
    if (!journal) return;
    try {
      journal.append(JSON.stringify(record));
    } catch {
      // In-memory state still bounds this process; the counter is how a caller learns the
      // restart guarantee degraded instead of discovering it after the fact.
      persistFailures += 1;
    }
  };

  const applyReserve = (sendId: string, targets: SpendScopes, tokens: number, at: number): void => {
    if (reservations.has(sendId)) return;
    reservations.set(sendId, { scopes: targets, tokens, status: "open", at });
    eachScope(targets, (_scope, _id, state) => {
      state.reserved += tokens;
      state.lastSeenAt = Math.max(state.lastSeenAt, at);
    });
  };

  const applySettle = (sendId: string, tokens: number, at: number, lost: boolean): void => {
    const reservation = reservations.get(sendId);
    if (!reservation || reservation.status !== "open") return;
    reservation.status = lost ? "lost" : "settled";
    eachScope(reservation.scopes, (_scope, _id, state) => {
      state.reserved = Math.max(0, state.reserved - reservation.tokens);
      // A lost send keeps its whole reservation as unresolved spend; a settled one books
      // the real figure, which may be lower OR higher than the ceiling that was reserved.
      if (lost) state.unresolved += reservation.tokens;
      else state.settled += tokens;
      state.lastSeenAt = Math.max(state.lastSeenAt, at);
    });
  };

  // Rebuild from the journal before serving: an exhausted scope must still be exhausted
  // after a restart, which is the whole reason this store exists.
  if (journal) {
    for (const line of journal.read()) {
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        continue;
      }
      if (record.v !== 1) continue;
      if (record.kind === "reserve") applyReserve(record.sendId, record.scopes, sanitizeTokens(record.tokens), record.at);
      else if (record.kind === "settle") applySettle(record.sendId, sanitizeTokens(record.tokens), record.at, false);
      else if (record.kind === "lost") applySettle(record.sendId, 0, record.at, true);
    }
  }

  return {
    get persistFailures() { return persistFailures; },

    reserve(request: SpendReservationRequest): SpendReservationDecision {
      const tokens = sanitizeTokens(request.inputTokens) + sanitizeTokens(request.outputCeilingTokens);
      const at = request.at ?? now();
      // Check every scope before mutating any: a refusal must not leave a partial
      // reservation booked on the scopes that would have passed.
      const checks: { scope: SpendScope; id: string; state: ScopeState }[] = [];
      eachScope(request.scopes, (scope, id, state) => checks.push({ scope, id, state }));
      for (const { scope, id, state } of checks) {
        const limit = limitFor(scope);
        if (limit === undefined) continue;
        const projected = state.settled + state.reserved + state.unresolved + tokens;
        if (projected > limit) {
          return { reserved: false, denial: { reason: "spend-limit-exceeded", scope, scopeId: id, limit, projected } };
        }
      }
      applyReserve(request.sendId, request.scopes, tokens, at);
      append({ v: 1, kind: "reserve", sendId: request.sendId, scopes: request.scopes, tokens, at });
      return { reserved: true, sendId: request.sendId, tokens };
    },

    settle(sendId: string, usage: SpendUsage): boolean {
      const reservation = reservations.get(sendId);
      if (!reservation || reservation.status !== "open") return false;
      const tokens = sanitizeTokens(usage.inputTokens) + sanitizeTokens(usage.outputTokens);
      applySettle(sendId, tokens, now(), false);
      append({ v: 1, kind: "settle", sendId, tokens, at: now() });
      return true;
    },

    markLost(sendId: string): boolean {
      const reservation = reservations.get(sendId);
      if (!reservation || reservation.status !== "open") return false;
      applySettle(sendId, 0, now(), true);
      append({ v: 1, kind: "lost", sendId, at: now() });
      return true;
    },

    snapshot(scope: SpendScope, scopeId: string): ScopeSpendSnapshot | undefined {
      const state = scopes.get(scopeKey(scope, scopeId));
      if (!state) return undefined;
      return {
        settled: state.settled,
        reserved: state.reserved,
        unresolved: state.unresolved,
        exhausted: isExhausted(scope, state),
      };
    },

    exhausted(scope: SpendScope, scopeId: string): boolean {
      const state = scopes.get(scopeKey(scope, scopeId));
      return state !== undefined && isExhausted(scope, state);
    },

    prune(at: number = now()): void {
      const cutoff = at - policy.retentionMs;
      for (const [key, state] of scopes) {
        const scope = key.slice(0, key.indexOf("\0")) as SpendScope;
        // Removal requires BOTH inactive and not exhausted inside the window. An
        // exhausted-but-idle scope that was dropped would be recreated fresh under the
        // same id -- the exact laundering the ceiling exists to stop.
        if (state.reserved > 0 || state.lastSeenAt >= cutoff) continue;
        if (isExhausted(scope, state)) continue;
        scopes.delete(key);
      }
      for (const [sendId, reservation] of reservations) {
        if (reservation.status === "open" || reservation.at >= cutoff) continue;
        reservations.delete(sendId);
      }
    },
  };
}

let sharedLedger: SpendReservationLedger | undefined;

/**
 * Process-wide ledger backed by the journal under OPENCODEX_HOME. Created lazily so
 * importing the module -- or running a request path that never reserves -- touches no
 * disk.
 */
export function sharedSpendLedger(): SpendReservationLedger {
  if (!sharedLedger) {
    sharedLedger = createSpendReservationLedger({
      journal: createFileSpendJournal(join(getConfigDir(), SPEND_LEDGER_JOURNAL_FILENAME)),
    });
  }
  return sharedLedger;
}

/** Test seam. Production never discards the ledger: that would reset a spent budget. */
export function resetSharedSpendLedgerForTest(): void {
  sharedLedger = undefined;
}
