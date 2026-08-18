import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AtomicWriteIO } from "../src/config";
import {
  type CatalogWritePermit,
  CatalogWritePermitRefusal,
  withCatalogWriteSerialization,
} from "../src/codex/catalog-write-serialization";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import {
  type CatalogBackupWriteIO,
  type PreparedCatalogFileWrite,
  publishHashedCodexCatalogBackup,
  publishLegacyCodexCatalogBackup,
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
} from "../src/codex/internal/catalog-writer";

interface MutatorCase {
  readonly name: string;
  readonly invoke: (
    permit: CatalogWritePermit,
    owningCodexHome: string,
    prepared: PreparedCatalogFileWrite,
    effects: string[],
  ) => unknown;
}

let testRoot = "";
let codexHome = "";
let otherCodexHome = "";
let targetDir = "";
let previousCodexHome: string | undefined;
let previousOpenCodexHome: string | undefined;

function atomicIo(effects: string[]): AtomicWriteIO {
  return {
    write(path, content) {
      effects.push(`temp:${path}`);
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    },
    harden(path) {
      effects.push(`harden:${path}`);
      chmodSync(path, 0o600);
    },
    rename(source, destination) {
      effects.push(`rename:${source}->${destination}`);
      expect(existsSync(source)).toBe(true);
      renameSync(source, destination);
    },
    truncate(path) {
      effects.push(`truncate:${path}`);
      truncateSync(path, 0);
    },
    unlink(path) {
      effects.push(`unlink:${path}`);
      unlinkSync(path);
    },
  };
}

function backupIo(effects: string[]): CatalogBackupWriteIO {
  return {
    resolveTarget: path => path,
    write(path, content) {
      effects.push(`temp:${path}`);
      writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    },
    harden(path) {
      effects.push(`harden:${path}`);
      chmodSync(path, 0o600);
    },
    publishNoReplace(source, destination) {
      effects.push(`publish:${source}->${destination}`);
      expect(existsSync(source)).toBe(true);
      linkSync(source, destination);
    },
    truncate(path) {
      effects.push(`truncate:${path}`);
      truncateSync(path, 0);
    },
    unlink(path) {
      effects.push(`unlink:${path}`);
      unlinkSync(path);
    },
  };
}

const mutators: readonly MutatorCase[] = [
  {
    name: "active catalog replacement",
    invoke: (permit, home, prepared, effects) =>
      replaceActiveCodexCatalog(permit, home, prepared, atomicIo(effects)),
  },
  {
    name: "hashed backup publication",
    invoke: (permit, home, prepared, effects) =>
      publishHashedCodexCatalogBackup(permit, home, prepared, backupIo(effects)),
  },
  {
    name: "legacy backup publication",
    invoke: (permit, home, prepared, effects) =>
      publishLegacyCodexCatalogBackup(permit, home, prepared, backupIo(effects)),
  },
  {
    name: "models cache replacement",
    invoke: (permit, home, prepared, effects) =>
      replaceCodexModelsCache(permit, home, prepared, atomicIo(effects)),
  },
] as const;

function directorySnapshot(): string[] {
  return readdirSync(targetDir).sort();
}

function expectRefusedBeforeFilesystemEffect(
  mutator: MutatorCase,
  permit: CatalogWritePermit,
  owningHome = codexHome,
): void {
  const before = directorySnapshot();
  const effects: string[] = [];
  const prepared = {
    path: join(targetDir, `${mutator.name.replaceAll(" ", "-")}.json`),
    content: "new bytes\n",
  };

  expect(() => mutator.invoke(permit, owningHome, prepared, effects))
    .toThrow(CatalogWritePermitRefusal);
  expect(effects).toEqual([]);
  expect(directorySnapshot()).toEqual(before);
}

function withLivePermit<T>(callback: (permit: CatalogWritePermit) => T): T {
  const outcome = withCatalogWriteSerialization(codexHome, callback);
  expect(outcome.kind).toBe("completed");
  if (outcome.kind !== "completed") throw new Error(`K unavailable: ${outcome.reason}`);
  return outcome.value;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  testRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-writer-")));
  codexHome = join(testRoot, "codex-home");
  otherCodexHome = join(testRoot, "other-codex-home");
  targetDir = join(testRoot, "external-catalog-targets");
  for (const path of [codexHome, otherCodexHome, targetDir, join(testRoot, "opencodex-home")]) {
    mkdirSync(path, { recursive: true });
  }
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = join(testRoot, "opencodex-home");
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;

  const identity = resolveEffectiveUserIdentity();
  for (const home of [codexHome, otherCodexHome]) {
    const databasePath = resolveCodexCatalogSerializationDatabasePath(identity, home);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }
  rmSync(testRoot, { recursive: true, force: true });
});

test("every mutator refuses a missing or forged permit before temp creation", () => {
  for (const mutator of mutators) {
    expectRefusedBeforeFilesystemEffect(
      mutator,
      undefined as unknown as CatalogWritePermit,
    );
    expectRefusedBeforeFilesystemEffect(mutator, {} as CatalogWritePermit);
  }
});

test("every mutator refuses leaked and revoked permits before temp creation", () => {
  let leaked: CatalogWritePermit | undefined;
  withLivePermit((permit) => {
    leaked = permit;
  });

  let revoked: CatalogWritePermit | undefined;
  expect(() => withCatalogWriteSerialization(codexHome, (permit) => {
    revoked = permit;
    throw new Error("revoke this acquisition");
  })).toThrow("revoke this acquisition");

  for (const mutator of mutators) {
    expectRefusedBeforeFilesystemEffect(mutator, leaked!);
    expectRefusedBeforeFilesystemEffect(mutator, revoked!);
  }
});

test("every mutator refuses a live permit bound to a different home before temp creation", () => {
  withLivePermit((permit) => {
    for (const mutator of mutators) {
      expectRefusedBeforeFilesystemEffect(mutator, permit, otherCodexHome);
    }
  });
});

for (const mutator of mutators) {
  test(`${mutator.name} writes prepared bytes atomically with the right live permit`, () => {
    const path = join(targetDir, `${mutator.name.replaceAll(" ", "-")}.json`);
    const isBackup = mutator.name.includes("backup");
    if (!isBackup) writeFileSync(path, "old bytes\n", { mode: 0o600 });
    const effects: string[] = [];

    const result = withLivePermit((permit) =>
      mutator.invoke(permit, codexHome, { path, content: "new bytes\n" }, effects)
    );

    expect(readFileSync(path, "utf8")).toBe("new bytes\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(targetDir).filter(name => name.endsWith(".tmp"))).toEqual([]);

    // Bind the three effects to ONE temp path, and to each other in order.
    //
    // Unbound `some()` checks — "a temp was written, something was hardened, something
    // was published" — hold even when the three touch different files, which is the
    // failure they exist to catch.
    //
    // Order matters as much as membership. Hardening lands on the temp file and
    // publishing moves that already-restricted file into place; if publish ran first,
    // the destination would sit world-readable for the width of the gap. A set-membership
    // assertion passes for that writer too, so the index comparison is what makes this a
    // claim about the race rather than about the call list. For the backup mutators it is
    // the ONLY detector: `publishNoReplace` is `linkSync`, so a temp hardened after
    // publication still shares the destination's inode — the mode check reads 0o600 and
    // the leftover-`.tmp` check passes, while the write was briefly exposed.
    //
    // Scope, stated plainly: `io` is an injected seam, so what is asserted here is
    // production's call ORDER (src/config.ts and src/codex/internal/catalog-writer.ts
    // both run write → harden → publish). Supplying `io` bypasses the real
    // implementations, so this proves hardening is REQUESTED on the temp before
    // publication — not that it restricts. The Windows NTFS ACL that does the actual
    // restricting is exercised in tests/windows-secret-acl.test.ts, and the POSIX mode
    // below is the only half `statSync` can observe (Windows reports 0o666 whatever
    // `chmodSync` did).
    const tempEffect = effects.find(effect => effect.startsWith("temp:"));
    expect(tempEffect).toBeDefined();
    const tempPath = tempEffect!.slice("temp:".length);
    const hardenIndex = effects.indexOf(`harden:${tempPath}`);
    const publishIndex = effects.indexOf(`${isBackup ? "publish" : "rename"}:${tempPath}->${path}`);
    expect(hardenIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(hardenIndex).toBeLessThan(publishIndex);
    if (isBackup) expect(result).toBe("written");
  });
}

for (const [name, publish] of [
  ["hashed", publishHashedCodexCatalogBackup],
  ["legacy", publishLegacyCodexCatalogBackup],
] as const) {
  test(`${name} create-once backup preserves an existing winner byte-for-byte`, () => {
    const path = join(targetDir, `${name}.backup.json`);
    writeFileSync(path, "first winner\n", { mode: 0o600 });

    const result = withLivePermit((permit) =>
      publish(permit, codexHome, { path, content: "late contender\n" })
    );

    expect(result).toBe("preserved");
    expect(readFileSync(path, "utf8")).toBe("first winner\n");
    expect(readdirSync(targetDir).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
  });
}
