import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  inspectCodexCoordinator,
  recoverZeroByteCodexCoordinator,
} from "../src/codex/coordinator-doctor";
import {
  codexWriteCoordinationEligibility,
  STABLE_ZERO_BYTE_COORDINATOR_AGE_MS,
} from "../src/codex/inject-coordination";
import {
  openCodexCoordinatorTransaction,
} from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { formatCoordinatorDoctorLines } from "../src/cli/doctor";

let codexHome = "";
let opencodexHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ocx-coordinator-doctor-codex-"));
  opencodexHome = mkdtempSync(join(tmpdir(), "ocx-coordinator-doctor-ocx-"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(opencodexHome, { recursive: true, force: true });
});

function privateFile(path: string, bytes = ""): void {
  writeFileSync(path, bytes);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

test("doctor classifies and explicitly backs up a stable zero-byte coordinator", () => {
  privateFile(coordinatorPath);
  const diagnostic = inspectCodexCoordinator();
  expect(diagnostic.kind).toBe("zero-byte");
  if (diagnostic.kind !== "zero-byte") return;
  expect(formatCoordinatorDoctorLines(diagnostic).join("\n")).toContain(
    "ocx doctor --recover-zero-byte-coordinator --yes",
  );
  expect(formatCoordinatorDoctorLines(diagnostic).join("\n")).toContain(
    "size: 0 bytes; user_version: 0",
  );

  const recovered = recoverZeroByteCodexCoordinator(new Date("2026-08-21T12:00:00.000Z"));
  expect(recovered.ok).toBe(true);
  if (!recovered.ok) return;
  expect(recovered.backupPath).toEndWith(".zero-byte-backup-20260821T120000000Z");
  expect(existsSync(coordinatorPath)).toBe(false);
  expect(existsSync(recovered.backupPath)).toBe(true);
  rmSync(recovered.backupPath, { force: true });
});

test("doctor distinguishes unversioned, rowless, and authoritative coordinators", () => {
  let database = new Database(coordinatorPath, { create: true });
  database.exec("CREATE TABLE temporary_probe (id INTEGER); DROP TABLE temporary_probe");
  database.close();
  if (process.platform !== "win32") chmodSync(coordinatorPath, 0o600);
  expect(inspectCodexCoordinator().kind).toBe("unversioned-empty");
  expect(recoverZeroByteCodexCoordinator()).toEqual({
    ok: false,
    reason: "coordinator state is unversioned-empty, not a recoverable zero-byte remnant",
  });

  database = new Database(coordinatorPath, { readwrite: true, create: false });
  database.exec("PRAGMA user_version = 1; CREATE TABLE codex_transition_state (singleton INTEGER PRIMARY KEY)");
  database.close();
  expect(inspectCodexCoordinator().kind).toBe("rowless");
  expect(recoverZeroByteCodexCoordinator()).toEqual({
    ok: false,
    reason: "coordinator state is rowless, not a recoverable zero-byte remnant",
  });

  database = new Database(coordinatorPath, { readwrite: true, create: false });
  database.exec("INSERT INTO codex_transition_state (singleton) VALUES (1)");
  database.close();
  const malformed = inspectCodexCoordinator();
  expect(malformed.kind).toBe("unreadable");
  expect(formatCoordinatorDoctorLines(malformed).join("\n")).toContain("user_version: 1");
  expect(formatCoordinatorDoctorLines(malformed).join("\n")).toContain("transition rows: 1");

  rmSync(coordinatorPath, { force: true });
  const transaction = openCodexCoordinatorTransaction(coordinatorPath);
  transaction.commit();
  transaction.close();
  expect(inspectCodexCoordinator().kind).toBe("ready");
  expect(recoverZeroByteCodexCoordinator()).toEqual({
    ok: false,
    reason: "coordinator state is ready, not a recoverable zero-byte remnant",
  });
});

test("doctor inspection is immutable and refuses sidecars, unsafe modes, and symlinks", () => {
  privateFile(coordinatorPath);
  expect(inspectCodexCoordinator().kind).toBe("zero-byte");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    expect(existsSync(`${coordinatorPath}${suffix}`)).toBe(false);
  }

  privateFile(`${coordinatorPath}-wal`, "active");
  expect(inspectCodexCoordinator()).toMatchObject({ kind: "unsafe" });
  rmSync(`${coordinatorPath}-wal`, { force: true });

  if (process.platform !== "win32") {
    chmodSync(coordinatorPath, 0o644);
    expect(inspectCodexCoordinator()).toMatchObject({ kind: "unsafe" });
    chmodSync(coordinatorPath, 0o600);

    const target = `${coordinatorPath}.target`;
    privateFile(target);
    rmSync(coordinatorPath, { force: true });
    symlinkSync(target, coordinatorPath);
    expect(inspectCodexCoordinator()).toMatchObject({ kind: "unsafe" });
    rmSync(coordinatorPath, { force: true });
    rmSync(target, { force: true });
  }
});

test("recovery refuses a zero-byte coordinator with an active SQLite writer sidecar", () => {
  privateFile(coordinatorPath);
  const holder = new Database(coordinatorPath, { readwrite: true, create: false });
  holder.exec("PRAGMA journal_mode = OFF; PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  try {
    expect(recoverZeroByteCodexCoordinator()).toMatchObject({
      ok: false,
      reason: expect.stringContaining("active SQLite journal sidecar"),
    });
    expect(existsSync(coordinatorPath)).toBe(true);
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("zero-byte residue uses the legacy boundary while clean homes still initialize", () => {
  privateFile(coordinatorPath);
  const afterStableAge = () => Date.now() + STABLE_ZERO_BYTE_COORDINATOR_AGE_MS + 1;
  expect(codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => ({ kind: "residue" }),
    integrationRecord: () => ({ kind: "missing" }),
    nowMs: afterStableAge,
  })).toEqual({
    kind: "legacy-uncoordinated",
    reason: "the coordinator is a zero-byte non-authoritative remnant and this routed home has not been adopted yet",
  });
  expect(codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => ({ kind: "clean" }),
    integrationRecord: () => ({ kind: "missing" }),
    nowMs: afterStableAge,
  })).toEqual({ kind: "coordinated" });

  privateFile(coordinatorPath, "not-empty");
  expect(codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => ({ kind: "residue" }),
    integrationRecord: () => ({ kind: "missing" }),
  })).toEqual({ kind: "coordinated" });
});

test("a fresh zero-byte coordinator stays on the locked path until it is stable", () => {
  privateFile(coordinatorPath);
  const fresh = codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => ({ kind: "residue" }),
    integrationRecord: () => ({ kind: "missing" }),
    nowMs: () => Date.now(),
  });
  expect(fresh).toEqual({ kind: "coordinated" });

  const settled = codexWriteCoordinationEligibility({
    coordinatorPath: () => coordinatorPath,
    residue: () => ({ kind: "residue" }),
    integrationRecord: () => ({ kind: "missing" }),
    nowMs: () => Date.now() + STABLE_ZERO_BYTE_COORDINATOR_AGE_MS + 1,
  });
  expect(settled.kind).toBe("legacy-uncoordinated");
});
