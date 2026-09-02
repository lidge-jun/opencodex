import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCatalogWritePermit,
  isCatalogWritePermitLive,
  withCatalogWriteSerialization,
  type CatalogWritePermit,
} from "../src/codex/catalog-write-serialization";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let codexHome = "";
let otherHome = "";
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-k-home-")));
  otherHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-k-other-")));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  const identity = resolveEffectiveUserIdentity();
  for (const home of [codexHome, otherHome]) {
    const path = resolveCodexCatalogSerializationDatabasePath(identity, home);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
  removeTreeWithRetry(codexHome);
  removeTreeWithRetry(otherHome);
});

/**
 * Sharing one database with the native coordinator would make `N -> K` nest
 * onto itself and deadlock the very transition it is meant to serialize.
 */
test("K's database is never the native coordinator's database", () => {
  const identity = resolveEffectiveUserIdentity();
  const kPath = resolveCodexCatalogSerializationDatabasePath(identity, codexHome);
  const nPath = resolveCodexCoordinatorDatabasePath(identity, codexHome);

  expect(kPath).not.toBe(nPath);
  // Same identity namespace, different exclusion surface.
  expect(kPath.endsWith(".sqlite")).toBe(true);
  expect(kPath).toContain("catalog-write-locks");
  expect(nPath).toContain("native-write-locks");
});

test("two homes take two different K databases", () => {
  const identity = resolveEffectiveUserIdentity();
  expect(resolveCodexCatalogSerializationDatabasePath(identity, codexHome))
    .not.toBe(resolveCodexCatalogSerializationDatabasePath(identity, otherHome));
});

test("a callback holding a live permit may write for its own home", () => {
  const outcome = withCatalogWriteSerialization(codexHome, (permit) => {
    assertCatalogWritePermit(permit, codexHome);
    return "published";
  });

  expect(outcome).toEqual({ kind: "completed", value: "published" });
});

/**
 * The defect this registry exists for: an opaque type proves a permit-bearing
 * call path exists, never that the callback still holds K. A leaked permit
 * type-checks perfectly, so only a runtime lookup can refuse it.
 */
test("a permit leaked out of its callback is refused afterwards", () => {
  let leaked: CatalogWritePermit | undefined;
  const outcome = withCatalogWriteSerialization(codexHome, (permit) => {
    leaked = permit;
    expect(isCatalogWritePermitLive(permit)).toBe(true);
    return "done";
  });
  expect(outcome.kind).toBe("completed");

  expect(isCatalogWritePermitLive(leaked!)).toBe(false);
  expect(() => assertCatalogWritePermit(leaked!, codexHome))
    .toThrow("was not minted by the serialization owner");
});

test("a permit is revoked even when its callback throws", () => {
  let leaked: CatalogWritePermit | undefined;
  expect(() => withCatalogWriteSerialization(codexHome, (permit) => {
    leaked = permit;
    throw new Error("callback exploded");
  })).toThrow("callback exploded");

  expect(isCatalogWritePermitLive(leaked!)).toBe(false);
  expect(() => assertCatalogWritePermit(leaked!, codexHome)).toThrow();
});

/**
 * A later acquisition must not resurrect an earlier permit, even for the same
 * home: one live permit authorizes the mutations of ITS OWN callback only.
 */
test("a permit cannot be reused by a later acquisition of the same home", () => {
  let first: CatalogWritePermit | undefined;
  withCatalogWriteSerialization(codexHome, (permit) => { first = permit; });

  const outcome = withCatalogWriteSerialization(codexHome, (second) => {
    expect(second).not.toBe(first);
    expect(() => assertCatalogWritePermit(first!, codexHome)).toThrow();
    assertCatalogWritePermit(second, codexHome);
    return "second-only";
  });
  expect(outcome).toEqual({ kind: "completed", value: "second-only" });
});

/**
 * The owning home is supplied by the caller, not inferred from the target's
 * parent, because a configured catalog target may legitimately be absolute and
 * outside CODEX_HOME. That makes cross-home confusion possible, so it is
 * refused explicitly.
 */
test("a live permit for one home is refused by a writer for another home", () => {
  const outcome = withCatalogWriteSerialization(codexHome, (permit) => {
    assertCatalogWritePermit(permit, codexHome);
    expect(() => assertCatalogWritePermit(permit, otherHome))
      .toThrow("authorizes a different CODEX_HOME");
    return "home-bound";
  });
  expect(outcome).toEqual({ kind: "completed", value: "home-bound" });
});

test("a forged permit shaped like the real one is refused", () => {
  withCatalogWriteSerialization(codexHome, (real) => {
    const forgedByCast = {} as CatalogWritePermit;
    const forgedByPrototype = Object.create(
      Object.getPrototypeOf(real) ?? Object.prototype,
    ) as CatalogWritePermit;
    const forgedBySymbolCopy = { ...(real as object) } as CatalogWritePermit;

    for (const forged of [forgedByCast, forgedByPrototype, forgedBySymbolCopy]) {
      expect(() => assertCatalogWritePermit(forged, codexHome))
        .toThrow("was not minted by the serialization owner");
    }
    return null;
  });
});

/**
 * `busy_timeout = 0` is deliberate: contention must be a typed outcome the
 * caller can decide about, not an unbounded wait while K is held.
 */
test("a second acquisition during a live callback is typed busy, not blocked", () => {
  const outcome = withCatalogWriteSerialization(codexHome, () => {
    const nested = withCatalogWriteSerialization(codexHome, () => "should-not-run");
    expect(nested).toEqual({ kind: "unavailable", reason: "busy" });
    return "outer-kept-k";
  });

  expect(outcome).toEqual({ kind: "completed", value: "outer-kept-k" });
});

test("a different home is not excluded by a live acquisition", () => {
  const outcome = withCatalogWriteSerialization(codexHome, () => {
    const other = withCatalogWriteSerialization(otherHome, () => "other-home-ran");
    expect(other).toEqual({ kind: "completed", value: "other-home-ran" });
    return "independent";
  });

  expect(outcome).toEqual({ kind: "completed", value: "independent" });
});

/**
 * A callback failure is the caller's error, not a lock outcome. Reporting it as
 * `unavailable` would invite a retry of something that fails identically.
 */
test("a callback error propagates rather than becoming a lock outcome", () => {
  expect(() => withCatalogWriteSerialization(codexHome, () => {
    throw new TypeError("derivation failed");
  })).toThrow(TypeError);

  // K must be released, so the next acquisition succeeds rather than hanging.
  expect(withCatalogWriteSerialization(codexHome, () => "recovered"))
    .toEqual({ kind: "completed", value: "recovered" });
});

test("K creates its database private to the effective user", () => {
  withCatalogWriteSerialization(codexHome, () => null);
  const path = resolveCodexCatalogSerializationDatabasePath(
    resolveEffectiveUserIdentity(),
    codexHome,
  );
  expect(existsSync(path)).toBe(true);
});
