/**
 * H — the cross-process history serialization primitive.
 *
 * Today a native apply or restore performs SQLite rows, the backup manifest and
 * every rollout file on the caller thread, and the manifest and rollout writes
 * sit OUTSIDE the provider's SQLite transaction
 * (`src/codex/history-provider.ts:606-648,656-698`). A SQLite busy timeout
 * therefore serializes one third of a state transition and explains one stall.
 * H is held across the whole unit — DB, manifest and rollouts together — so an
 * opposite-direction process cannot overtake through the unguarded files.
 *
 * Two ways H differs from K, both forced by review:
 *
 * `H -> N` is a real edge, not a violation. The Worker reads the coordinator row
 * and writes its terminal state while holding H, and both take BEGIN IMMEDIATE
 * on N. That is why H must be its own database: sharing N's would make the
 * Worker contend with itself. `N -> H`, `K -> H` and `C -> H` are forbidden, and
 * the resulting `H -> N -> K -> C` order was checked acyclic in review round 3.
 *
 * H is keyed by the canonical state database as well as the canonical home,
 * because one CODEX_HOME can name a different `state_5.sqlite` and those are not
 * the same exclusion (`src/codex/user-identity.ts`).
 *
 * The permit is a runtime registration, not a type. An opaque TypeScript brand
 * proves a permit-bearing call path exists; it cannot prove the callback still
 * holds the lock, and a permit leaked past its callback type-checks perfectly.
 * So every history mutator asks this module at runtime whether the permit it was
 * handed is still live for the state database it is about to write.
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/005_contract.md §6.
 */
import { chmodSync, lstatSync, realpathSync } from "node:fs";

import { Database } from "bun:sqlite";

import {
  CodexUserIdentityRefusal,
  resolveCodexHistorySerializationDatabasePath,
  resolveEffectiveUserIdentity,
  samePathIdentity,
} from "./user-identity";

/**
 * Authorization to perform history mutations inside ONE H acquisition.
 *
 * Deliberately carries no usable field. Holding this object is necessary and
 * never sufficient: `assertHistoryWritePermit` decides, by looking the object up
 * in a registry only this module can write. A forged cast, a prototype copy or a
 * symbol clone produces a value of this type that every writer refuses.
 */
export interface HistoryWritePermit {
  readonly [historyWritePermitBrand]: true;
}

declare const historyWritePermitBrand: unique symbol;

export type HistorySerializationOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "unavailable"; reason: "busy" | "database" | "unsafe-path" };

export class HistoryWritePermitRefusal extends Error {
  readonly code = "CODEX_HISTORY_WRITE_PERMIT_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "HistoryWritePermitRefusal";
  }
}

interface PermitRegistration {
  readonly canonicalStateDbPath: string;
  readonly transactionId: string;
  live: boolean;
}

/**
 * Registrations are marked dead, never deleted.
 *
 * Deleting would make a leaked permit indistinguishable from a forged one, and
 * those are different bugs: "used after its acquisition released" points at a
 * caller that kept a permit past its callback, while "never minted here" points
 * at a cast or a clone. Both are refused; only the diagnosis differs. The map is
 * weak, so a dead entry costs nothing once the permit is unreachable.
 */
const activePermits = new WeakMap<object, PermitRegistration>();
let acquisitionCounter = 0;

function isBusy(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED"
    || /database (?:is|table is) locked/i.test(message);
}

/**
 * Refuse unless this exact permit is live for this exact state database.
 *
 * Every history mutator calls this BEFORE touching the database, the manifest or
 * a rollout file. The state database is named by the caller rather than derived,
 * because a rollout path can point anywhere the manifest recorded.
 */
export function assertHistoryWritePermit(
  permit: HistoryWritePermit,
  canonicalStateDbPath: string,
): void {
  const registration = activePermits.get(permit as unknown as object);
  if (!registration) {
    throw new HistoryWritePermitRefusal(
      "The history write permit was not minted by the serialization owner.",
    );
  }
  if (!registration.live) {
    throw new HistoryWritePermitRefusal(
      "The history write permit belongs to a released acquisition.",
    );
  }
  if (registration.canonicalStateDbPath !== canonicalStateDbPath) {
    throw new HistoryWritePermitRefusal(
      "The history write permit authorizes a different Codex state database.",
    );
  }
}

/**
 * Acquire H for one canonical state database and run `work` while it is held.
 *
 * The callback may enter N — that is the `H -> N` edge the Worker needs to read
 * the coordinator row and publish its terminal state. It must never re-enter H.
 *
 * `busy_timeout = 0` with `BEGIN IMMEDIATE` makes contention fail fast and
 * typed. Blocking here would hold the acquisition across an unbounded wait,
 * which is the stall this phase exists to remove.
 */
export function withHistoryWriteSerialization<T>(
  canonicalCodexHome: string,
  canonicalStateDbPath: string,
  work: (permit: HistoryWritePermit) => T,
): HistorySerializationOutcome<T> {
  let databasePath: string;
  try {
    databasePath = resolveCodexHistorySerializationDatabasePath(
      resolveEffectiveUserIdentity(),
      canonicalCodexHome,
      canonicalStateDbPath,
    );
  } catch (error) {
    if (error instanceof CodexUserIdentityRefusal) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    return { kind: "unavailable", reason: "database" };
  }

  let database: Database | undefined;
  let transactionOpen = false;
  let registration: PermitRegistration | undefined;
  let permit: HistoryWritePermit | undefined;

  try {
    let databaseWasAbsent = false;
    try {
      const before = lstatSync(databasePath);
      if (before.isSymbolicLink() || !before.isFile()) {
        return { kind: "unavailable", reason: "unsafe-path" };
      }
      if (process.platform !== "win32") {
        const uid = process.getuid?.();
        if (uid === undefined || before.uid !== uid || (before.mode & 0o777) !== 0o600) {
          return { kind: "unavailable", reason: "unsafe-path" };
        }
      }
    } catch (cause) {
      const code = cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : "";
      if (code !== "ENOENT") throw cause;
      databaseWasAbsent = true;
    }

    database = new Database(databasePath, { create: true });
    if (databaseWasAbsent) {
      try { chmodSync(databasePath, 0o600); } catch { /* Windows applies ACLs in WP11. */ }
    }
    const opened = lstatSync(databasePath);
    if (opened.isSymbolicLink() || !opened.isFile()
      || !samePathIdentity(realpathSync.native(databasePath), databasePath)) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }

    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    transactionOpen = true;

    acquisitionCounter += 1;
    registration = {
      canonicalStateDbPath,
      transactionId: `${process.pid}:${acquisitionCounter}`,
      live: true,
    };
    // A bare object: nothing about it is guessable or reconstructable, because
    // the authority lives in the registry entry rather than in the value.
    permit = {} as HistoryWritePermit;
    activePermits.set(permit as unknown as object, registration);

    let value: T;
    try {
      value = work(permit);
    } finally {
      // Revoke BEFORE releasing the transaction, so a mutator racing the release
      // can never find a live permit without a live lock. This runs on the
      // throwing path too, which is what a `finally`-less version gets wrong.
      registration.live = false;
    }

    database.exec("COMMIT");
    transactionOpen = false;
    return { kind: "completed", value };
  } catch (error) {
    if (transactionOpen) {
      try { database?.exec("ROLLBACK"); } catch { /* close releases the transaction */ }
      transactionOpen = false;
    }
    if (registration?.live) {
      registration.live = false;
    }
    if (error instanceof CodexUserIdentityRefusal) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    if (isBusy(error)) return { kind: "unavailable", reason: "busy" };
    // A callback failure is the caller's error, not a lock outcome: H acquired
    // fine. Reporting it as `unavailable` would tell the caller to retry
    // something that fails identically.
    throw error;
  } finally {
    try { database?.close(); } catch { /* acquisition already finished */ }
  }
}

/** Test-only: prove a leaked permit is dead without reaching into the registry. */
export function isHistoryWritePermitLive(permit: HistoryWritePermit): boolean {
  return activePermits.get(permit as unknown as object)?.live === true;
}
