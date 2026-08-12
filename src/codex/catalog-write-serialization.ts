/**
 * K — the permanent catalog serialization primitive.
 *
 * Round 4 of the audit killed the idea that "the replacement happens under a
 * lock" is enough. The retained `/api/sync` chain reads the active catalog,
 * captures it, awaits provider gathering, and only then writes from that
 * captured state (`src/codex/catalog/sync.ts:513,520,526,565`). If convergence
 * publishes Y while that await is pending, taking a lock afterwards does not
 * make the captured X fresh — the writer legally overwrites Y while holding it.
 * So K serializes the whole read-transform-write transaction, either by
 * recomputing under K or by revalidating complete evidence under K, not by
 * guarding the last rename.
 *
 * The second defect that round found was subtler: an opaque TypeScript permit
 * type proves a permit-bearing call path EXISTS. It cannot prove the callback
 * still holds K. A leaked permit used after its callback returned type-checks
 * perfectly. So the type is not the mechanism — this module owns a private
 * active-permit registry, and every mutator asks it at runtime whether the
 * permit it holds is still live for the home it is about to write.
 *
 * K is permanent and is NOT WP11's native write lock. It never reads or
 * advances the native pair. Order is `N -> K -> C`; there is no `C -> K` and no
 * `K -> N` (`005_contract.md:660-762`).
 *
 * Design record: devlog/_fin/260804_codex_write_substrate/005_contract.md §3.
 */
import { chmodSync, lstatSync, realpathSync } from "node:fs";

import { Database } from "bun:sqlite";

import {
  CodexUserIdentityRefusal,
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
  samePathIdentity,
} from "./user-identity";

/**
 * Authorization to perform the fixed sequence of catalog mutations inside ONE
 * K acquisition.
 *
 * Deliberately carries no usable field. Holding this object is necessary but
 * never sufficient: `assertCatalogWritePermit` is what actually decides, by
 * looking the object up in a registry this module alone can write. A forged
 * cast, a prototype copy, or a symbol clone produces a value of this type that
 * every writer refuses.
 */
export interface CatalogWritePermit {
  readonly [catalogWritePermitBrand]: true;
}

declare const catalogWritePermitBrand: unique symbol;

export type CatalogSerializationOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "unavailable"; reason: "busy" | "database" | "unsafe-path" };

export class CatalogWritePermitRefusal extends Error {
  readonly code = "CODEX_CATALOG_WRITE_PERMIT_REFUSED";

  constructor(message: string) {
    super(message);
    this.name = "CatalogWritePermitRefusal";
  }
}

interface PermitRegistration {
  /** The exact canonical CODEX_HOME whose artifacts this acquisition may write. */
  readonly canonicalCodexHome: string;
  /** Identifies the acquisition, so a permit cannot outlive its transaction. */
  readonly transactionId: string;
  live: boolean;
}

/**
 * The registry is a module-private WeakMap keyed by permit IDENTITY. There is
 * no exported constructor, brand value, or registration API, so the only way to
 * obtain a registered permit is to be inside a live callback.
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
 * The runtime proof every low-level catalog/backup/cache mutator must obtain
 * before its FIRST filesystem mutation — including temp creation, hardening,
 * unlink, link, rename, truncate, or replacement.
 *
 * `owningCodexHome` is supplied by the caller rather than inferred from the
 * target's parent directory, because an accepted configured catalog target may
 * be absolute and outside CODEX_HOME entirely.
 */
export function assertCatalogWritePermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
): void {
  const registration = activePermits.get(permit as unknown as object);
  if (!registration) {
    throw new CatalogWritePermitRefusal(
      "The catalog write permit was not minted by the serialization owner.",
    );
  }
  if (!registration.live) {
    throw new CatalogWritePermitRefusal(
      "The catalog write permit belongs to a released acquisition.",
    );
  }
  if (registration.canonicalCodexHome !== owningCodexHome) {
    throw new CatalogWritePermitRefusal(
      "The catalog write permit authorizes a different CODEX_HOME.",
    );
  }
}

/**
 * Acquire K for one canonical CODEX_HOME and run `write` while it is held.
 *
 * Synchronous by contract: the callback performs no provider request, runtime
 * probe, OAuth refresh, subprocess, or awaited work. It may enter
 * `withExpectedConfigGenerationSync` — that is the `K -> C` edge.
 *
 * `busy_timeout = 0` with `BEGIN IMMEDIATE` makes contention fail fast and
 * typed; the outer async orchestration decides whether to retry within its
 * deadline. Blocking here would hold K across an unbounded wait.
 */
export function withCatalogWriteSerialization<T>(
  canonicalCodexHome: string,
  write: (permit: CatalogWritePermit) => T,
): CatalogSerializationOutcome<T> {
  let databasePath: string;
  try {
    databasePath = resolveCodexCatalogSerializationDatabasePath(
      resolveEffectiveUserIdentity(),
      canonicalCodexHome,
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
  let permit: CatalogWritePermit | undefined;

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
      canonicalCodexHome,
      transactionId: `${process.pid}:${acquisitionCounter}`,
      live: true,
    };
    // A bare object: nothing about it is guessable or reconstructable, because
    // authority lives in the registry entry rather than in the value.
    permit = {} as CatalogWritePermit;
    activePermits.set(permit as unknown as object, registration);

    let value: T;
    try {
      value = write(permit);
    } finally {
      // Revoke BEFORE the transaction is released, so a mutator racing the
      // release can never find a live permit without a live lock. This runs on
      // the throwing path too, which is the case a `finally`-less version gets
      // wrong.
      registration.live = false;
      activePermits.delete(permit as unknown as object);
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
      if (permit) activePermits.delete(permit as unknown as object);
    }
    if (error instanceof CodexUserIdentityRefusal) {
      return { kind: "unavailable", reason: "unsafe-path" };
    }
    if (isBusy(error)) return { kind: "unavailable", reason: "busy" };
    // A callback failure is the caller's error, not a lock outcome: K acquired
    // fine. Reporting it as `unavailable` would tell the caller to retry
    // something that will fail identically.
    throw error;
  } finally {
    try { database?.close(); } catch { /* acquisition already finished */ }
  }
}

/** Test-only: prove a leaked permit is dead without reaching into the registry. */
export function isCatalogWritePermitLive(permit: CatalogWritePermit): boolean {
  return activePermits.get(permit as unknown as object)?.live === true;
}
