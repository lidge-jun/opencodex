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
 * SUPPORTED TOPOLOGY: one live writer owns one OPENCODEX_HOME journal. Every server and
 * direct shared-ledger caller must hold the state-directory SQLite lease before replay,
 * append or compaction. Independent homes remain independent; multi-host shared storage
 * still needs a distributed transaction boundary and is outside this local lease.
 *
 * Five properties this file owes its callers. Each one was absent in the first draft, and a
 * budget that can be bypassed is worse than no budget because it looks like protection:
 *
 * 1. IDENTITY OF A SEND. A send id is either KNOWN -- and then reserving it again is refused
 *    rather than waved through booking nothing -- or FULLY forgotten, and then it books a
 *    fresh reservation. There is no third state where the ledger recognises an id and
 *    charges nothing for it, which is what let one id authorise unlimited physical sends.
 * 2. DURABILITY BEFORE ADMISSION. Under a configured limit the reserve record must be on
 *    disk before the request is admitted. Failing open on a disk-full or permission error
 *    forgets the request across a restart, which is the exact case durability exists for.
 *    Observe-only mode still admits, and says so through `durable: false`.
 * 3. REPLAY VALIDATES. Every journal record is checked field by field before it moves a
 *    counter. A corrupt record in the MIDDLE of the file would silently undercount, so it
 *    fails accounting closed instead; only an unparseable FINAL line -- a torn tail write --
 *    is dropped quietly.
 * 4. BOUNDED RETENTION. Cleanup runs automatically, writes durable tombstones so replay
 *    cannot resurrect what it removed, and compacts the journal to a checkpoint. When
 *    nothing can be evicted safely, admission is refused rather than made room for by
 *    forgetting an exhausted scope -- forgetting one is the laundering this layer prevents.
 * 5. NOTHING IDENTIFYING ON DISK. Root ids come from a client header and identity ids are
 *    credential ids, so the journal stores salted aliases only, under owner-only permissions
 *    that are re-applied to an EXISTING file rather than trusted from its creation.
 */

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
// Definition-site import, not the ../config barrel -- same reasoning as
// src/quota/reset-seen-store.ts: the barrel pulls ~154 modules into a hot path.
import { getConfigDir } from "../config/paths";
// Type-only, so it is erased before this module has a runtime import graph at all. The
// config SHAPE is what this file needs; the config loader is what the note above keeps out.
import type { OcxSpendConfig, OcxSpendScopeConfig } from "../types/config";
import { assertNotRealHomeUnderTest } from "./test-home-guard";
// Windows chmod does not remove inherited ACEs; this is the repository's icacls path.
import { hardenSecretPath } from "./windows-secret-acl";
import { assertSpendLedgerOwnerHeld, assertStorageOwned, bindSpendLedgerOwnerHome, mintSpendLedgerStorage, onSpendLedgerOwnerReleased, resetSpendLedgerOwnerBindingForTest, SpendLedgerOwnerError, spendLedgerOwnerSnapshot, spendLedgerStoragePath, type SpendLedgerStorage } from "./spend-ledger-owner";

// The singleton belongs to the state directory it was built for. Releasing ownership hands that
// directory to whoever comes next, so the in-memory copy goes with it and the next construction
// replays the journal.
onSpendLedgerOwnerReleased(() => { sharedLedger = undefined; });

export const SPEND_LEDGER_JOURNAL_FILENAME = "spend-ledger.jsonl";
/**
 * Per-install alias salt, beside the journal. Losing it is exactly as bad as losing the
 * journal -- both reset accounting, both live in the same 0700 directory -- so it is not a
 * new weakness, and keeping it out of the journal stops a copied or attached journal from
 * being reversible by dictionary attack on guessable pool and identity ids.
 */
export const SPEND_LEDGER_SALT_FILENAME = "spend-ledger.salt";

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
  /**
   * Hard ceiling on tracked scopes. Retention alone bounds nothing: a caller minting a fresh
   * root id per request fills the map long before the window elapses. At the ceiling the
   * ledger evicts the oldest scope that is safe to forget -- idle, under its limit, past
   * retention -- and if there is none it REFUSES the new scope. Refusing is the only answer
   * left: the alternative is evicting an exhausted scope, which hands it a fresh allowance.
   */
  readonly maxTrackedScopes?: number;
  /** Hard ceiling on remembered send ids, with the same evict-or-refuse rule. */
  readonly maxTrackedSends?: number;
  /**
   * Journal records after which the file is compacted into a single checkpoint. Without
   * this the file grows forever even while the in-memory maps stay bounded, and replay
   * resurrects every entry cleanup removed.
   */
  readonly compactAfterRecords?: number;
}

const DEFAULT_MAX_TRACKED_SCOPES = 4_096;
const DEFAULT_MAX_TRACKED_SENDS = 16_384;
const DEFAULT_COMPACT_AFTER_RECORDS = 8_192;

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
  /**
   * This send has ALREADY left for upstream and is being recorded rather than admitted.
   *
   * Some transports report their physical sends after the fact -- the passthrough ladder
   * reports through `onSendsConsumed`, and an adapter's inner retries are counted when they
   * finish. For those, a ceiling cannot refuse anything: the tokens are spent. Refusing to
   * BOOK them is the worse answer, and it is not hypothetical -- it is a fixpoint. The send
   * that would cross the ceiling gets dropped from the total, the total stays just under the
   * limit forever, the scope never reads as exhausted, and the ceiling never fires again for
   * any request. So a recorded send skips the limit check and takes the scope over its
   * ceiling, which is what makes the NEXT request refusable.
   *
   * It skips the durability refusal for the same reason: a journal that could not be written
   * is a reason to report degradation, never a reason to forget spend that really happened.
   * Identity, capacity and journal-integrity denials still apply -- those say the ledger
   * cannot account for the send at all, which no flag here can change.
   */
  readonly alreadySent?: boolean;
}

/**
 * Why a reservation was refused. Every member refuses a DISPATCH: none of them is an
 * "already fine, carry on" answer, because that is precisely how a duplicate send id used
 * to buy an unlimited number of physical sends while the scope totals never moved.
 */
export type SpendDenial =
  | {
      readonly reason: "spend-limit-exceeded";
      readonly scope: SpendScope;
      readonly scopeId: string;
      readonly limit: number;
      readonly projected: number;
    }
  /** This send id is already known -- open, settled, lost or abandoned. */
  | { readonly reason: "duplicate-send-id"; readonly sendId: string }
  /** The reserve record could not be written, and a configured limit needs it to survive. */
  | { readonly reason: "reserve-not-durable"; readonly sendId: string }
  /** Replay rejected records mid-file, so no scope total can be proven complete. */
  | { readonly reason: "journal-corrupt"; readonly corruptRecords: number }
  /** Tracking is full and nothing may be forgotten safely. */
  | { readonly reason: "tracking-capacity-exhausted"; readonly scope?: SpendScope };

export type SpendReservationDecision =
  | {
      readonly reserved: true;
      readonly sendId: string;
      readonly tokens: number;
      /**
       * False only in observe-only mode, where the reservation was admitted although its
       * journal record did not reach disk. A restart will not remember this spend; the flag
       * is how a caller learns that instead of discovering it after the fact.
       */
      readonly durable: boolean;
    }
  | { readonly reserved: false; readonly denial: SpendDenial };

interface ScopeState {
  settled: number;
  reserved: number;
  unresolved: number;
  lastSeenAt: number;
}

/**
 * `open` means admitted but not yet handed to a transport: it may still be abandoned for
 * free. `dispatched` means bytes left for upstream, so from there a missing usage frame is
 * unresolved SPEND rather than a release -- it may have been billed. Only a dispatched send
 * can become `lost`; only an undispatched one can become `abandoned`.
 */
type ReservationStatus = "open" | "dispatched" | "settled" | "lost" | "abandoned";

interface ScopeRef {
  readonly scope: SpendScope;
  readonly alias: string;
}

interface Reservation {
  readonly targets: readonly ScopeRef[];
  readonly tokens: number;
  status: ReservationStatus;
  readonly at: number;
  /** When the status last changed; drives eviction of resolved entries. */
  resolvedAt: number;
}

/**
 * Journal shape. Every id on disk is a salted alias, never a root header value, credential
 * id or pool name. `forget` and `drop` are the tombstones that make bounded cleanup
 * durable -- without them replay rebuilds exactly what cleanup removed -- and `checkpoint`
 * is a whole-state snapshot that lets the file be compacted instead of growing forever.
 */
type JournalRecord =
  | { v: 1; kind: "reserve"; send: string; targets: ScopeRef[]; tokens: number; at: number }
  | { v: 1; kind: "dispatch"; send: string; at: number }
  | { v: 1; kind: "settle"; send: string; tokens: number; at: number }
  | { v: 1; kind: "lost"; send: string; at: number }
  | { v: 1; kind: "abandon"; send: string; at: number }
  | { v: 1; kind: "forget"; send: string; at: number }
  | { v: 1; kind: "drop"; scope: SpendScope; alias: string; at: number }
  | {
      v: 1;
      kind: "checkpoint";
      at: number;
      scopes: { scope: SpendScope; alias: string; settled: number; unresolved: number; seenAt: number }[];
      sends: { send: string; status: ReservationStatus; targets: ScopeRef[]; tokens: number; at: number; resolvedAt: number }[];
    };

const isCountable = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isAlias = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

const isScopeName = (value: unknown): value is SpendScope =>
  value === "root" || value === "identity" || value === "pool";

const isStatus = (value: unknown): value is ReservationStatus =>
  value === "open" || value === "dispatched" || value === "settled"
  || value === "lost" || value === "abandoned";

const parseTargets = (value: unknown): ScopeRef[] | undefined => {
  if (!Array.isArray(value) || value.length > 3) return undefined;
  const targets: ScopeRef[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { scope, alias } = entry as { scope?: unknown; alias?: unknown };
    if (!isScopeName(scope) || !isAlias(alias)) return undefined;
    targets.push({ scope, alias });
  }
  return targets;
};

/**
 * Validate one journal line into a record, or reject it.
 *
 * Exported because this is the boundary where a hostile or damaged file meets the accounting:
 * `JSON.parse(line) as JournalRecord` type-asserts a lie, and a bare `null` line or a
 * `{"v":1,"kind":"reserve"}` with no fields crashed the rebuild rather than being rejected.
 * Every field is checked, including that numbers are finite and non-negative.
 */
export function parseSpendJournalRecord(line: string): JournalRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  if (!isCountable(record.at)) return undefined;
  const at = record.at;
  switch (record.kind) {
    case "reserve": {
      const targets = parseTargets(record.targets);
      if (!isAlias(record.send) || targets === undefined || !isCountable(record.tokens)) return undefined;
      return { v: 1, kind: "reserve", send: record.send, targets, tokens: record.tokens, at };
    }
    case "settle":
      if (!isAlias(record.send) || !isCountable(record.tokens)) return undefined;
      return { v: 1, kind: "settle", send: record.send, tokens: record.tokens, at };
    case "dispatch":
      if (!isAlias(record.send)) return undefined;
      return { v: 1, kind: "dispatch", send: record.send, at };
    case "lost":
      if (!isAlias(record.send)) return undefined;
      return { v: 1, kind: "lost", send: record.send, at };
    case "abandon":
      if (!isAlias(record.send)) return undefined;
      return { v: 1, kind: "abandon", send: record.send, at };
    case "forget":
      if (!isAlias(record.send)) return undefined;
      return { v: 1, kind: "forget", send: record.send, at };
    case "drop":
      if (!isScopeName(record.scope) || !isAlias(record.alias)) return undefined;
      return { v: 1, kind: "drop", scope: record.scope, alias: record.alias, at };
    case "checkpoint": {
      if (!Array.isArray(record.scopes) || !Array.isArray(record.sends)) return undefined;
      const scopes: { scope: SpendScope; alias: string; settled: number; unresolved: number; seenAt: number }[] = [];
      for (const entry of record.scopes) {
        if (typeof entry !== "object" || entry === null) return undefined;
        const e = entry as Record<string, unknown>;
        if (!isScopeName(e.scope) || !isAlias(e.alias)) return undefined;
        if (!isCountable(e.settled) || !isCountable(e.unresolved) || !isCountable(e.seenAt)) return undefined;
        scopes.push({ scope: e.scope, alias: e.alias, settled: e.settled, unresolved: e.unresolved, seenAt: e.seenAt });
      }
      const sends: { send: string; status: ReservationStatus; targets: ScopeRef[]; tokens: number; at: number; resolvedAt: number }[] = [];
      for (const entry of record.sends) {
        if (typeof entry !== "object" || entry === null) return undefined;
        const e = entry as Record<string, unknown>;
        const targets = parseTargets(e.targets);
        if (!isAlias(e.send) || !isStatus(e.status) || targets === undefined) return undefined;
        if (!isCountable(e.tokens) || !isCountable(e.at) || !isCountable(e.resolvedAt)) return undefined;
        sends.push({ send: e.send, status: e.status, targets, tokens: e.tokens, at: e.at, resolvedAt: e.resolvedAt });
      }
      return { v: 1, kind: "checkpoint", at, scopes, sends };
    }
    default:
      return undefined;
  }
}

/**
 * Append-mostly persistence. `read` returns raw lines so replay can tell a torn TAIL write
 * from corruption earlier in the file; only the former is safe to drop quietly. `append`
 * THROWS when the record did not reach storage -- that signal is what lets admission refuse
 * rather than admit a request a restart would forget. `rewrite` is optional: a store that
 * cannot replace its contents atomically simply never compacts.
 */
export interface SpendJournal {
  read(): string[];
  append(line: string): void;
  rewrite?(lines: string[]): void;
}

/**
 * Re-apply owner-only permissions to a file that already exists.
 *
 * `mode` in a write option is honoured only when the file is CREATED, so a journal that was
 * created loose -- by an older build, a restored backup, or a lax umask -- would keep its
 * mode forever. Best-effort by design: a non-owner cannot chmod, and failing every append
 * over it would be worse than the loose mode it is fixing.
 *
 * `force` marks the points where the WINDOWS ACL can actually be wrong: creation, compaction,
 * and each process's replay. Windows chmod cannot drop inherited ACEs, so icacls is the real
 * boundary there, and its memo keys on the file's ctime -- which every append changes. Running
 * it per reservation would therefore spawn a process per send while protecting nothing an
 * append can alter. On POSIX the mode is checked on every write and repaired the moment it
 * drifts, which costs one stat.
 */
function hardenLedgerFile(path: string, options: { readonly force?: boolean } = {}): void {
  if (process.platform === "win32") {
    if (options.force) hardenSecretPath(path, { required: false });
    return;
  }
  try {
    if ((statSync(path).mode & 0o777) === 0o600) return;
    chmodSync(path, 0o600);
  } catch { /* best-effort: a non-owner cannot chmod */ }
}

/**
 * Does a directory entry exist here, whatever it points at?
 *
 * `existsSync` follows the link, so a symlink whose target is absent reads as "no file" and an
 * append then creates that target somewhere else entirely. The entry itself is what decides
 * whether the safety check runs.
 */
function ledgerEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertSafeLedgerFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (process.platform !== "win32" && stat.uid !== process.getuid!())) {
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger storage could not be opened safely.",
    );
  }
}

/**
 * The production journal. Its location comes from the owned state directory and every touch
 * proves that ownership, so there is no entrypoint here that writes a caller-chosen path.
 */
export function createOwnedFileSpendJournal(storage: SpendLedgerStorage): SpendJournal {
  assertStorageOwned(storage);
  const path = spendLedgerStoragePath(storage);
  const ensureDir = (): string => {
    const dir = dirname(path);
    // The guard runs before any mutation so a rejected write leaves nothing behind.
    assertNotRealHomeUnderTest(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  return {
    read(): string[] {
      assertStorageOwned(storage);
      if (!ledgerEntryExists(path)) return [];
      assertSafeLedgerFile(path);
      // Replay is once per process and is the moment a journal inherited from an older build
      // or a restored backup first passes through here.
      hardenLedgerFile(path, { force: true });
      return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    },
    append(line: string): void {
      assertStorageOwned(storage);
      ensureDir();
      const created = !ledgerEntryExists(path);
      if (!created) assertSafeLedgerFile(path);
      appendFileSync(path, line + "\n", { encoding: "utf8", mode: 0o600 });
      assertSafeLedgerFile(path);
      hardenLedgerFile(path, { force: created });
    },
    rewrite(lines: string[]): void {
      assertStorageOwned(storage);
      ensureDir();
      // Same directory, so the rename is atomic on the same filesystem: a crash mid-compaction
      // leaves either the old journal or the new one, never a half-written ledger.
      if (ledgerEntryExists(path)) assertSafeLedgerFile(path);
      const temp = `${path}.compact-${process.pid}-${randomBytes(6).toString("hex")}`;
      writeFileSync(temp, lines.map((line) => line + "\n").join(""), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      assertSafeLedgerFile(temp);
      hardenLedgerFile(temp, { force: true });
      renameSync(temp, path);
      assertSafeLedgerFile(path);
      hardenLedgerFile(path, { force: true });
    },
  };
}

/**
 * Load the per-install alias salt, minting it on first use.
 *
 * The salt must be STABLE across restarts or replay cannot match a live request to its own
 * recorded spend, which would hand every scope a fresh allowance -- so it is a file, not a
 * per-process value.
 */
export function loadOrCreateSpendLedgerSalt(storage: SpendLedgerStorage): string {
  assertStorageOwned(storage);
  const path = spendLedgerStoragePath(storage);
  if (ledgerEntryExists(path)) {
    assertSafeLedgerFile(path);
    hardenLedgerFile(path, { force: true });
    const existing = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(existing)) return existing;
    throw new SpendLedgerOwnerError(
      "SPEND_LEDGER_OWNER_UNAVAILABLE",
      "Spend-ledger storage could not be opened safely.",
    );
  }
  const dir = dirname(path);
  assertStorageOwned(storage);
  assertNotRealHomeUnderTest(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const salt = randomBytes(32).toString("hex");
  writeFileSync(path, salt + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  assertSafeLedgerFile(path);
  hardenLedgerFile(path, { force: true });
  return salt;
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
   * The send left for upstream. Until this is called the reservation may be abandoned for
   * free; after it, a missing usage frame becomes unresolved spend. Returns false when the
   * send is unknown or no longer open.
   */
  markDispatched(sendId: string): boolean;
  /**
   * The send never happened -- local validation, routing, or a refusal before any byte left
   * this process. The reservation is RELEASED and books nothing, because inventing debt the
   * account never incurred is its own way of breaking the budget. Refused once the send is
   * dispatched: from there only settle or markLost is honest.
   */
  abandon(sendId: string): boolean;
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
  /**
   * Drop dormant scopes per the retention rule in SpendReservationPolicy. Cleanup also runs
   * automatically on every reservation, so nothing depends on a caller remembering this.
   */
  prune(now?: number): void;
  /** Whether this send id is already known, and therefore refused. */
  knows(sendId: string): boolean;
  /**
   * Replace the live policy.
   *
   * Every figure already accounted survives: raising, lowering or clearing a ceiling changes
   * what is REFUSED from here on and never what was spent. Rebuilding the ledger instead
   * would replay the journal into a second set of maps while the first still holds this
   * process's open reservations, and the two would then disagree about what is in flight.
   */
  reconfigure(next: SpendReservationPolicy): void;
  /**
   * The policy in force. A live read, not a copy: a caller that formats a refusal has to name
   * the ceiling this ledger would enforce on the NEXT request, not the one it was built with.
   */
  readonly policy: SpendReservationPolicy;
  /** Journal writes that failed; a nonzero count means durability is degraded. */
  readonly persistFailures: number;
  /**
   * Records replay rejected in the MIDDLE of the journal. Nonzero means no scope total can
   * be proven complete, so configured limits refuse rather than undercount.
   */
  readonly corruptRecords: number;
  /** True when durability is degraded in either direction: failed writes or a corrupt file. */
  readonly degraded: boolean;
}

const scopeKey = (scope: SpendScope, alias: string): string => scope + "\0" + alias;

const sanitizeTokens = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

export function createSpendReservationLedger(options: {
  readonly journal?: SpendJournal;
  readonly policy?: SpendReservationPolicy;
  readonly now?: () => number;
  /**
   * Per-install alias salt. Production passes the file-backed value from
   * `loadOrCreateSpendLedgerSalt`; an empty default is for in-memory journals, which have
   * no file anyone could correlate.
   */
  readonly salt?: string;
  /**
   * Shared production ledgers prove their exact ownership before reading or changing
   * accounting. Identity, not just the directory name: a handle kept across a release and a
   * reacquire describes a journal another writer may have changed in between.
   */
  readonly assertOwnedAccounting?: () => void;
} = {}): SpendReservationLedger {
  // Mutable because the ceilings are operator configuration, and configuration is reloadable.
  // The three bounds below are read through functions for the same reason: a value captured
  // at construction would answer for the policy this ledger was BUILT with, and an operator
  // who raised a bound would keep the old one until the process restarted.
  let policy = options.policy ?? DEFAULT_SPEND_RESERVATION_POLICY;
  const journal = options.journal;
  const now = options.now ?? (() => Date.now());
  const salt = options.salt ?? "";
  const assertOwnedAccounting = options.assertOwnedAccounting;
  const maxTrackedScopes = (): number => policy.maxTrackedScopes ?? DEFAULT_MAX_TRACKED_SCOPES;
  const maxTrackedSends = (): number => policy.maxTrackedSends ?? DEFAULT_MAX_TRACKED_SENDS;
  const compactAfterRecords = (): number => policy.compactAfterRecords ?? DEFAULT_COMPACT_AFTER_RECORDS;
  const scopes = new Map<string, ScopeState>();
  const reservations = new Map<string, Reservation>();
  let persistFailures = 0;
  let corruptRecords = 0;
  let recordsOnDisk = 0;

  /**
   * Salted alias for one identifier. The raw value -- a client-supplied root header, a
   * credential id, a pool name -- never leaves this function, so nothing identifying is
   * written to disk or held in a map key.
   */
  const aliasFor = (kind: SpendScope | "send", id: string): string =>
    createHash("sha256").update(salt).update("\u0000").update(kind).update("\u0000").update(id)
      .digest("hex").slice(0, 32);

  const scopeState = (scope: SpendScope, alias: string): ScopeState => {
    const key = scopeKey(scope, alias);
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

  /** The scopes a request touches, as aliases. Creates no state: a refusal must leave none. */
  const refsFor = (targets: SpendScopes): ScopeRef[] => {
    const refs: ScopeRef[] = [];
    if (targets.rootId !== undefined) refs.push({ scope: "root", alias: aliasFor("root", targets.rootId) });
    if (targets.identityId !== undefined) refs.push({ scope: "identity", alias: aliasFor("identity", targets.identityId) });
    if (targets.poolId !== undefined) refs.push({ scope: "pool", alias: aliasFor("pool", targets.poolId) });
    return refs;
  };

  /**
   * Returns whether the record reached storage. With no journal there is nothing to fail,
   * and the caller's durability question is vacuously satisfied.
   */
  const append = (record: JournalRecord): boolean => {
    if (!journal) return true;
    try {
      journal.append(JSON.stringify(record));
      recordsOnDisk += 1;
      return true;
    } catch (error) {
      if (error instanceof SpendLedgerOwnerError) throw error;
      // In-memory state still bounds this process; the counter is how a caller learns the
      // restart guarantee degraded instead of discovering it after the fact.
      persistFailures += 1;
      return false;
    }
  };

  const applyReserve = (send: string, targets: readonly ScopeRef[], tokens: number, at: number): void => {
    if (reservations.has(send)) return;
    reservations.set(send, { targets, tokens, status: "open", at, resolvedAt: at });
    for (const ref of targets) {
      const state = scopeState(ref.scope, ref.alias);
      state.reserved += tokens;
      state.lastSeenAt = Math.max(state.lastSeenAt, at);
    }
  };

  const isLive = (status: ReservationStatus): boolean => status === "open" || status === "dispatched";

  /**
   * Resolve a live reservation. `settled` books the real figure, `lost` keeps the whole
   * reservation as unresolved spend because it may have been billed, and `abandoned`
   * releases it because no byte ever left this process.
   */
  const applyResolve = (send: string, outcome: "settled" | "lost" | "abandoned", tokens: number, at: number): void => {
    const reservation = reservations.get(send);
    if (!reservation || !isLive(reservation.status)) return;
    reservation.status = outcome;
    reservation.resolvedAt = at;
    for (const ref of reservation.targets) {
      const state = scopeState(ref.scope, ref.alias);
      state.reserved = Math.max(0, state.reserved - reservation.tokens);
      if (outcome === "lost") state.unresolved += reservation.tokens;
      else if (outcome === "settled") state.settled += tokens;
      state.lastSeenAt = Math.max(state.lastSeenAt, at);
    }
  };

  const applyDispatch = (send: string, at: number): void => {
    const reservation = reservations.get(send);
    if (!reservation || reservation.status !== "open") return;
    reservation.status = "dispatched";
    reservation.resolvedAt = at;
  };

  /** Tombstone replay: the entry is gone, so a later reuse of the id books a fresh charge. */
  const applyForget = (send: string): void => {
    const reservation = reservations.get(send);
    if (!reservation || isLive(reservation.status)) return;
    reservations.delete(send);
  };

  const applyDrop = (scope: SpendScope, alias: string): void => {
    const state = scopes.get(scopeKey(scope, alias));
    if (!state || state.reserved > 0) return;
    scopes.delete(scopeKey(scope, alias));
  };

  const applyCheckpoint = (record: Extract<JournalRecord, { kind: "checkpoint" }>): void => {
    scopes.clear();
    reservations.clear();
    for (const entry of record.scopes) {
      scopes.set(scopeKey(entry.scope, entry.alias), {
        settled: entry.settled,
        reserved: 0,
        unresolved: entry.unresolved,
        lastSeenAt: entry.seenAt,
      });
    }
    for (const entry of record.sends) {
      // `reserved` is rebuilt from the live entries rather than trusted from the snapshot,
      // so the two can never disagree about the same tokens.
      if (isLive(entry.status)) {
        applyReserve(entry.send, entry.targets, entry.tokens, entry.at);
        if (entry.status === "dispatched") applyDispatch(entry.send, entry.resolvedAt);
        continue;
      }
      reservations.set(entry.send, {
        targets: entry.targets,
        tokens: entry.tokens,
        status: entry.status,
        at: entry.at,
        resolvedAt: entry.resolvedAt,
      });
    }
  };

  // Rebuild from the journal before serving: an exhausted scope must still be exhausted
  // after a restart, which is the whole reason this store exists.
  if (journal) {
    const lines = journal.read();
    recordsOnDisk = lines.length;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] as string;
      const record = parseSpendJournalRecord(line);
      if (!record) {
        // A rejected FINAL line is a torn tail write -- the process died between the write
        // and its newline -- and is dropped quietly, because that record never completed and
        // therefore never authorised anything. A rejected line ANYWHERE ELSE is different:
        // the records after it did complete, so skipping it silently undercounts a scope and
        // hands back budget. It is counted, and a configured limit refuses on it below.
        if (index < lines.length - 1) corruptRecords += 1;
        continue;
      }
      switch (record.kind) {
        case "reserve": applyReserve(record.send, record.targets, sanitizeTokens(record.tokens), record.at); break;
        case "dispatch": applyDispatch(record.send, record.at); break;
        case "settle": applyResolve(record.send, "settled", sanitizeTokens(record.tokens), record.at); break;
        case "lost": applyResolve(record.send, "lost", 0, record.at); break;
        case "abandon": applyResolve(record.send, "abandoned", 0, record.at); break;
        case "forget": applyForget(record.send); break;
        case "drop": applyDrop(record.scope, record.alias); break;
        case "checkpoint": applyCheckpoint(record); break;
      }
    }
    // A reservation that survived replay has no owner left. The process that made it is gone,
    // so nothing in this one can ever settle it, and leaving it live means the send stays
    // pending forever against a scope that can never resolve it. Deleting the entry is not the
    // alternative either: that would hand the same send id a second reservation.
    //
    // Both live states resolve to UNRESOLVED, including an undispatched one. The tempting
    // distinction -- open never reached the wire, so give its tokens back -- assumes the
    // journal is complete up to the crash, and the torn-tail handling above says it is not: a
    // send can dispatch and die before its dispatch record lands. Abandoning that reservation
    // returns tokens for a send that may have been billed, and worse, it RESETS a ceiling that
    // had already fired. An exhausted scope staying exhausted across a restart is the whole
    // reason this store is on disk.
    const reconciledAt = now();
    for (const [send, reservation] of reservations) {
      if (!isLive(reservation.status)) continue;
      applyResolve(send, "lost", 0, reconciledAt);
      append({ v: 1, kind: "lost", send, at: reconciledAt });
    }
  }

  /**
   * Bounded cleanup. It runs before every admission, so nothing depends on a caller
   * remembering `prune()` -- the first draft exported one and no production path called it.
   * Every removal writes a tombstone: without one, replay rebuilds precisely what cleanup
   * removed and the file keeps growing while the maps look bounded.
   *
   * `force` is the at-capacity pass. It ignores the retention window but never the safety
   * rule: an ACTIVE or EXHAUSTED scope is not a candidate at any pressure, because dropping
   * one hands it a fresh allowance under the same id. When that leaves nothing to remove,
   * the caller refuses admission rather than making room by forgetting a spent scope.
   */
  const evictScopes = (at: number, force: boolean): number => {
    const cutoff = at - policy.retentionMs;
    const candidates: { key: string; scope: SpendScope; alias: string; seenAt: number }[] = [];
    for (const [key, state] of scopes) {
      const separator = key.indexOf("\0");
      const scope = key.slice(0, separator) as SpendScope;
      if (state.reserved > 0) continue;
      if (isExhausted(scope, state)) continue;
      if (!force && state.lastSeenAt >= cutoff) continue;
      candidates.push({ key, scope, alias: key.slice(separator + 1), seenAt: state.lastSeenAt });
    }
    if (force) {
      candidates.sort((a, b) => a.seenAt - b.seenAt);
      candidates.length = Math.min(candidates.length, 1);
    }
    for (const candidate of candidates) {
      scopes.delete(candidate.key);
      append({ v: 1, kind: "drop", scope: candidate.scope, alias: candidate.alias, at });
    }
    return candidates.length;
  };

  /**
   * Forget resolved send ids. A forgotten id is forgotten COMPLETELY: reusing it later books
   * a fresh reservation against every scope, which is conservative. The state this must never
   * produce is the middle one -- an id the ledger recognises but charges nothing for.
   */
  const evictSends = (at: number, force: boolean): number => {
    const cutoff = at - policy.retentionMs;
    const candidates: { send: string; resolvedAt: number }[] = [];
    for (const [send, reservation] of reservations) {
      if (isLive(reservation.status)) continue;
      if (!force && reservation.resolvedAt >= cutoff) continue;
      candidates.push({ send, resolvedAt: reservation.resolvedAt });
    }
    if (force) {
      candidates.sort((a, b) => a.resolvedAt - b.resolvedAt);
      candidates.length = Math.min(candidates.length, 1);
    }
    for (const candidate of candidates) {
      reservations.delete(candidate.send);
      append({ v: 1, kind: "forget", send: candidate.send, at });
    }
    return candidates.length;
  };

  /**
   * Replace the journal with a single checkpoint once it has grown past its record budget.
   * Bounded maps are not enough on their own: the file behind them is what replay reads, and
   * an uncompacted file grows forever on unique root and send ids.
   */
  const compact = (at: number): void => {
    const rewrite = journal?.rewrite;
    if (!journal || !rewrite || recordsOnDisk < compactAfterRecords()) return;
    const checkpoint: JournalRecord = {
      v: 1,
      kind: "checkpoint",
      at,
      scopes: [...scopes].map(([key, state]) => {
        const separator = key.indexOf("\0");
        return {
          scope: key.slice(0, separator) as SpendScope,
          alias: key.slice(separator + 1),
          settled: state.settled,
          unresolved: state.unresolved,
          seenAt: state.lastSeenAt,
        };
      }),
      sends: [...reservations].map(([send, reservation]) => ({
        send,
        status: reservation.status,
        targets: [...reservation.targets],
        tokens: reservation.tokens,
        at: reservation.at,
        resolvedAt: reservation.resolvedAt,
      })),
    };
    try {
      rewrite.call(journal, [JSON.stringify(checkpoint)]);
      recordsOnDisk = 1;
    } catch (error) {
      if (error instanceof SpendLedgerOwnerError) throw error;
      // Compaction is maintenance, not accounting: a failed rewrite leaves the previous
      // journal intact and every figure in it still replayable.
      persistFailures += 1;
    }
  };

  /** The denial when tracking cannot fit this request, or undefined when it can. */
  const makeRoom = (refs: readonly ScopeRef[], at: number): SpendDenial | undefined => {
    evictSends(at, false);
    evictScopes(at, false);
    while (reservations.size >= maxTrackedSends()) {
      if (evictSends(at, true) === 0) return { reason: "tracking-capacity-exhausted" };
    }
    let fresh = 0;
    for (const ref of refs) if (!scopes.has(scopeKey(ref.scope, ref.alias))) fresh += 1;
    while (scopes.size + fresh > maxTrackedScopes()) {
      if (evictScopes(at, true) === 0) {
        return { reason: "tracking-capacity-exhausted", scope: refs[0]?.scope };
      }
    }
    return undefined;
  };

  return {
    // Every figure this ledger reports describes a journal it must still own. Reporting one
    // after ownership ended is the same error as writing then, with a quieter symptom.
    get persistFailures() { assertOwnedAccounting?.(); return persistFailures; },
    get corruptRecords() { assertOwnedAccounting?.(); return corruptRecords; },
    get degraded() { assertOwnedAccounting?.(); return persistFailures > 0 || corruptRecords > 0; },
    get policy() { assertOwnedAccounting?.(); return policy; },

    reserve(request: SpendReservationRequest): SpendReservationDecision {
      assertOwnedAccounting?.();
      const tokens = sanitizeTokens(request.inputTokens) + sanitizeTokens(request.outputCeilingTokens);
      const at = request.at ?? now();
      const send = aliasFor("send", request.sendId);
      const refs = refsFor(request.scopes);
      const enforced = refs.some((ref) => limitFor(ref.scope) !== undefined);

      // A send id this ledger already knows is REFUSED. Returning success while booking
      // nothing -- the old behaviour -- let one id authorise an unlimited number of physical
      // sends with the scope totals never moving.
      if (reservations.has(send)) {
        return { reserved: false, denial: { reason: "duplicate-send-id", sendId: request.sendId } };
      }
      // Replay could not prove these totals are complete, so a configured ceiling cannot be
      // enforced on them. Observe-only accounting continues and reports the degradation.
      if (enforced && corruptRecords > 0) {
        return { reserved: false, denial: { reason: "journal-corrupt", corruptRecords } };
      }
      const capacity = makeRoom(refs, at);
      if (capacity) return { reserved: false, denial: capacity };

      // Check every scope before mutating any: a refusal must not leave a partial
      // reservation booked on the scopes that would have passed. Reading state without
      // creating it matters here -- a denied request must not leave a tracked scope behind.
      for (const ref of refs) {
        // A recorded send has no limit to fail: it already happened, and the point of booking
        // it is to let the total go OVER the ceiling so the next request can be refused.
        const limit = request.alreadySent === true ? undefined : limitFor(ref.scope);
        if (limit === undefined) continue;
        const state = scopes.get(scopeKey(ref.scope, ref.alias));
        const projected = (state ? state.settled + state.reserved + state.unresolved : 0) + tokens;
        if (projected > limit) {
          const scopeId = ref.scope === "root"
            ? request.scopes.rootId
            : ref.scope === "identity" ? request.scopes.identityId : request.scopes.poolId;
          return {
            reserved: false,
            denial: { reason: "spend-limit-exceeded", scope: ref.scope, scopeId: scopeId ?? "", limit, projected },
          };
        }
      }

      // Durability BEFORE admission. The record goes to disk first, and under a configured
      // limit a failed write refuses the request rather than admitting one that a restart
      // would forget -- which is exactly the disk-full and permission case durability is for.
      const durable = append({ v: 1, kind: "reserve", send, targets: refs, tokens, at });
      if (!durable && enforced && request.alreadySent !== true) {
        return { reserved: false, denial: { reason: "reserve-not-durable", sendId: request.sendId } };
      }
      applyReserve(send, refs, tokens, at);
      compact(at);
      return { reserved: true, sendId: request.sendId, tokens, durable };
    },

    markDispatched(sendId: string): boolean {
      assertOwnedAccounting?.();
      const send = aliasFor("send", sendId);
      const reservation = reservations.get(send);
      if (!reservation || reservation.status !== "open") return false;
      const at = now();
      applyDispatch(send, at);
      append({ v: 1, kind: "dispatch", send, at });
      return true;
    },

    abandon(sendId: string): boolean {
      assertOwnedAccounting?.();
      const send = aliasFor("send", sendId);
      const reservation = reservations.get(send);
      // Only an UNDISPATCHED reservation may be released for free. Once bytes have left for
      // upstream the tokens may already be billed, so the caller owes settle or markLost.
      if (!reservation || reservation.status !== "open") return false;
      const at = now();
      applyResolve(send, "abandoned", 0, at);
      append({ v: 1, kind: "abandon", send, at });
      return true;
    },

    settle(sendId: string, usage: SpendUsage): boolean {
      assertOwnedAccounting?.();
      const send = aliasFor("send", sendId);
      const reservation = reservations.get(send);
      if (!reservation || !isLive(reservation.status)) return false;
      const tokens = sanitizeTokens(usage.inputTokens) + sanitizeTokens(usage.outputTokens);
      const at = now();
      applyResolve(send, "settled", tokens, at);
      append({ v: 1, kind: "settle", send, tokens, at });
      return true;
    },

    markLost(sendId: string): boolean {
      assertOwnedAccounting?.();
      const send = aliasFor("send", sendId);
      const reservation = reservations.get(send);
      if (!reservation || !isLive(reservation.status)) return false;
      const at = now();
      applyResolve(send, "lost", 0, at);
      append({ v: 1, kind: "lost", send, at });
      return true;
    },

    knows(sendId: string): boolean {
      assertOwnedAccounting?.();
      return reservations.has(aliasFor("send", sendId));
    },

    snapshot(scope: SpendScope, scopeId: string): ScopeSpendSnapshot | undefined {
      // Reading accounting from a handle whose ownership has ended is as wrong as writing it:
      // the figures describe a journal this process no longer owns.
      assertOwnedAccounting?.();
      const state = scopes.get(scopeKey(scope, aliasFor(scope, scopeId)));
      if (!state) return undefined;
      return {
        settled: state.settled,
        reserved: state.reserved,
        unresolved: state.unresolved,
        exhausted: isExhausted(scope, state),
      };
    },

    exhausted(scope: SpendScope, scopeId: string): boolean {
      assertOwnedAccounting?.();
      const state = scopes.get(scopeKey(scope, aliasFor(scope, scopeId)));
      return state !== undefined && isExhausted(scope, state);
    },

    prune(at: number = now()): void {
      assertOwnedAccounting?.();
      // Removal requires BOTH inactive and not exhausted inside the window. An
      // exhausted-but-idle scope that was dropped would be recreated fresh under the
      // same id -- the exact laundering the ceiling exists to stop.
      evictSends(at, false);
      evictScopes(at, false);
    },

    reconfigure(next: SpendReservationPolicy): void {
      assertOwnedAccounting?.();
      policy = next;
    },
  };
}

let sharedLedger: SpendReservationLedger | undefined;
/**
 * The operator policy in effect. Held beside the ledger rather than inside it because the
 * ledger is built lazily: a configured ceiling has to be remembered from startup until the
 * first request that actually reserves, and an install that configures nothing must still
 * open no journal.
 */
let sharedPolicy: SpendReservationPolicy = DEFAULT_SPEND_RESERVATION_POLICY;

/** Whether any scope carries a ceiling -- that is, whether anything at all can be refused. */
export function spendCeilingsConfigured(policy: SpendReservationPolicy = sharedPolicy): boolean {
  return policy.root.maxTokens !== undefined
    || policy.identity.maxTokens !== undefined
    || policy.pool.maxTokens !== undefined;
}

/** The policy the process-wide ledger enforces right now. */
export function sharedSpendPolicy(): SpendReservationPolicy {
  return sharedPolicy;
}

const spendScopeLimitFromConfig = (scope: OcxSpendScopeConfig | undefined): SpendScopeLimit =>
  scope?.maxTokens !== undefined && Number.isFinite(scope.maxTokens) && scope.maxTokens > 0
    ? { maxTokens: Math.trunc(scope.maxTokens) }
    : {};

/**
 * The ledger policy an operator's `spend` section asks for.
 *
 * An absent section, an empty one, and one whose every ceiling is absent all produce the
 * unconfigured default: observe-only accounting that refuses nothing. That equivalence is the
 * load-bearing part. This ledger is on and journaling by default, so shipping a default
 * ceiling would start refusing real traffic on the first upgrade that ran this code, against
 * a number nobody chose. There is deliberately no default figure here at all.
 */
export function spendPolicyFromConfig(spend: OcxSpendConfig | undefined): SpendReservationPolicy {
  const retentionDays = spend?.retentionDays;
  return {
    root: spendScopeLimitFromConfig(spend?.root),
    identity: spendScopeLimitFromConfig(spend?.identity),
    pool: spendScopeLimitFromConfig(spend?.pool),
    retentionMs: retentionDays !== undefined && Number.isFinite(retentionDays) && retentionDays > 0
      ? Math.trunc(retentionDays) * 24 * 60 * 60_000
      : DEFAULT_SPEND_RESERVATION_POLICY.retentionMs,
  };
}

/**
 * Apply an operator policy to the process-wide ledger.
 *
 * Startup calls this with the loaded config, and a reload may call it again: the ledger keeps
 * every figure it has already accounted, so changing a ceiling changes what is refused from
 * here on and never what was spent. It does not CREATE the ledger -- an install that
 * configures no ceiling must not open a journal merely because the server started.
 */
export function configureSharedSpendLedger(policy: SpendReservationPolicy): void {
  assertSpendLedgerOwnerHeld();
  if (sharedLedger) bindSpendLedgerOwnerHome();
  sharedPolicy = policy;
  sharedLedger?.reconfigure(policy);
}

/**
 * Process-wide ledger backed by the journal under OPENCODEX_HOME. Created lazily so
 * importing the module -- or running a request path that never reserves -- touches no
 * disk. One directory at a time, not one directory for the life of the process: the singleton
 * is discarded when its ownership ends, so a later directory replays its own journal rather
 * than inheriting figures from the previous one.
 */
export function sharedSpendLedger(): SpendReservationLedger {
  assertSpendLedgerOwnerHeld();
  bindSpendLedgerOwnerHome();
  if (!sharedLedger) {
    // Minted by the owner module from the directory it actually owns, and carrying the exact
    // ownership they were minted under. Nothing here chooses a path or supplies its own guard.
    const journalStorage = mintSpendLedgerStorage(SPEND_LEDGER_JOURNAL_FILENAME);
    const saltStorage = mintSpendLedgerStorage(SPEND_LEDGER_SALT_FILENAME);
    const journalPath = spendLedgerStoragePath(journalStorage);
    const saltPath = spendLedgerStoragePath(saltStorage);
    const assertOwnedAccounting = (): void => {
      assertStorageOwned(journalStorage);
      if (ledgerEntryExists(journalPath)) assertSafeLedgerFile(journalPath);
      if (ledgerEntryExists(saltPath)) assertSafeLedgerFile(saltPath);
    };
    sharedLedger = createSpendReservationLedger({
      journal: createOwnedFileSpendJournal(journalStorage),
      salt: loadOrCreateSpendLedgerSalt(saltStorage),
      policy: sharedPolicy,
      assertOwnedAccounting,
    });
  }
  return sharedLedger;
}

const MAX_DIAGNOSTIC_ERROR_COUNT = 1_000_000;

/** Scalar-only and side-effect-free: reading diagnostics never constructs or replays. */
export function spendLedgerDiagnosticsSnapshot(): {
  readonly ownership: "held" | "unheld";
  readonly initialized: boolean;
  readonly configured: boolean;
  readonly degraded: boolean;
  readonly persistFailures: number;
  readonly corruptRecords: number;
} {
  const ledger = sharedLedger;
  const bounded = (value: number): number => Math.min(MAX_DIAGNOSTIC_ERROR_COUNT, Math.max(0, value));
  return {
    ...spendLedgerOwnerSnapshot(),
    initialized: ledger !== undefined,
    configured: spendCeilingsConfigured(sharedPolicy),
    degraded: ledger?.degraded ?? false,
    persistFailures: bounded(ledger?.persistFailures ?? 0),
    corruptRecords: bounded(ledger?.corruptRecords ?? 0),
  };
}

/**
 * Test seam for discarding the singleton outright.
 *
 * Production discards it too, but only with the ownership it belongs to, which is what
 * `onSpendLedgerOwnerReleased` does. Neither path resets a spent budget: the journal is the
 * durable record and the next construction replays it.
 */
export function resetSharedSpendLedgerForTest(): void {
  sharedLedger = undefined;
  sharedPolicy = DEFAULT_SPEND_RESERVATION_POLICY;
  resetSpendLedgerOwnerBindingForTest();
}
