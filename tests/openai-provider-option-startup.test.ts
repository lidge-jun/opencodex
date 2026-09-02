import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteFile,
  AtomicWriteResidualTempError,
  AtomicWriteSecretResidualError,
  backupConfigBeforeOpenAiTierMigration,
  getDefaultConfig,
  OpenAiTierBackupCleanupError,
  OpenAiTierBackupCollisionError,
  OpenAiTierBackupRollbackError,
  OpenAiTierBackupSecretResidualError,
  OpenAiTierRollbackPreserveError,
  preserveOpenAiTierRollbackSnapshot,
  type OpenAiTierBackupIO,
  type OpenAiTierRollbackPreserveIO,
} from "../src/config";
import { runOpenAiTierStartupMigration } from "../src/providers/openai-tier-startup";
import { OpenAiTierMigrationCollisionError, projectOpenAiTierMigration } from "../src/providers/openai-tiers";
import type { OcxConfig } from "../src/types";
import * as windowsAcl from "../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const config: OcxConfig = {
  port: 10100,
  defaultProvider: "openai",
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
};

function virtualBackupIO(initial: Record<string, string>, fail: {
  publish?: Error;
  tempUnlink?: number;
  backupUnlink?: number;
  truncate?: number;
  harden?: number;
  read?: number;
  create?: number;
  write?: number;
  writeAfter?: number;
} = {}) {
  type Inode = { bytes: Uint8Array; hardened: boolean };
  const files = new Map<string, Inode>(Object.entries(initial).map(([path, value]) => [path, {
    bytes: new TextEncoder().encode(value),
    hardened: path.endsWith(".bak"),
  }]));
  const calls: string[] = [];
  let writeCount = 0;
  const io: OpenAiTierBackupIO = {
    exists: path => files.has(path),
    read: path => {
      calls.push(`read:${path}`);
      if ((fail.read ?? 0) > 0) {
        fail.read!--;
        throw new Error("read failed");
      }
      const inode = files.get(path);
      if (!inode) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return inode.bytes.slice();
    },
    createExclusive: path => {
      calls.push(`create:${path}`);
      if ((fail.create ?? 0) > 0) {
        fail.create!--;
        throw new Error("create failed");
      }
      if (files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, { bytes: new Uint8Array(), hardened: false });
    },
    write: (path, bytes) => {
      calls.push(`write:${path}`);
      writeCount += 1;
      if ((fail.write ?? 0) > 0) {
        fail.write!--;
        throw new Error("write failed");
      }
      if (fail.writeAfter !== undefined && writeCount > fail.writeAfter) throw new Error("write failed");
      files.get(path)!.bytes = bytes.slice();
    },
    harden: path => {
      calls.push(`harden:${path}`);
      if ((fail.harden ?? 0) > 0) {
        fail.harden!--;
        throw new Error("harden failed");
      }
      files.get(path)!.hardened = true;
    },
    publishNoReplace: (temp, backup) => {
      calls.push(`publish:${backup}`);
      if (fail.publish) throw fail.publish;
      if (files.has(backup)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(backup, files.get(temp)!);
    },
    truncate: path => {
      calls.push(`truncate:${path}`);
      if ((fail.truncate ?? 0) > 0) {
        fail.truncate!--;
        throw new Error("truncate failed");
      }
      files.get(path)!.bytes = new Uint8Array();
    },
    unlink: path => {
      calls.push(`unlink:${path}`);
      const isBackup = path.endsWith(".bak");
      if (isBackup && (fail.backupUnlink ?? 0) > 0) {
        fail.backupUnlink!--;
        throw new Error("backup unlink failed");
      }
      if (!isBackup && (fail.tempUnlink ?? 0) > 0) {
        fail.tempUnlink!--;
        throw new Error("temp unlink failed");
      }
      files.delete(path);
    },
  };
  return { io, files, calls };
}

function aclBackupIO(options: {
  failTempUnlink?: () => boolean;
  hideTempFromExists?: boolean;
  vanishAfterHarden?: boolean;
} = {}): OpenAiTierBackupIO {
  return {
    exists: path => options.hideTempFromExists && path.endsWith(".tmp") ? false : existsSync(path),
    read: path => readFileSync(path),
    createExclusive: path => { writeFileSync(path, new Uint8Array(), { flag: "wx", mode: 0o600 }); },
    write: (path, bytes) => writeFileSync(path, bytes),
    harden: path => {
      chmodSync(path, 0o600);
      windowsAcl.hardenSecretPath(path, { required: true });
      if (options.vanishAfterHarden) unlinkSync(path);
    },
    publishNoReplace: (temp, backup) => linkSync(temp, backup),
    truncate: path => truncateSync(path, 0),
    unlink: path => {
      if (path.endsWith(".tmp") && options.failTempUnlink?.()) {
        throw Object.assign(new Error("injected temp unlink failure"), { code: "EPERM" });
      }
      unlinkSync(path);
    },
  };
}

describe("OpenAI provider option startup coordinator", () => {
  test("fresh default config is already marked with the current OpenAI tier schema", () => {
    expect(getDefaultConfig().openaiProviderTierVersion).toBe(2);
    expect(runOpenAiTierStartupMigration(getDefaultConfig(), {
      project: projectOpenAiTierMigration,
      backup: () => { throw new Error("fresh config must not be backed up"); },
      save: () => { throw new Error("fresh config must not be rewritten"); },
    }).openaiProviderTierVersion).toBe(2);
  });
  test("uses project -> backup -> save order and returns the projection", () => {
    const calls: string[] = [];
    const projected = { ...config, openaiProviderTierVersion: 2 as const };
    const result = runOpenAiTierStartupMigration(config, {
      project: () => { calls.push("project"); return { config: projected, changed: true, resolvedMode: "pool", warnings: [] }; },
      backup: () => { calls.push("backup"); },
      save: value => { calls.push("save"); expect(value).toBe(projected); },
    });
    expect(calls).toEqual(["project", "backup", "save"]);
    expect(result).toBe(projected);
  });

  test("emits path-only warnings after save succeeds", () => {
    const calls: string[] = [];
    const originalWarn = console.warn;
    console.warn = message => { calls.push(`warn:${String(message)}`); };
    try {
      runOpenAiTierStartupMigration(config, {
        project: () => ({ config: { ...config, openaiProviderTierVersion: 2 }, changed: true, resolvedMode: "pool", warnings: ["providerContextCaps.openai: conflict resolved"] }),
        backup: () => { calls.push("backup"); },
        save: () => { calls.push("save"); },
      });
    } finally {
      console.warn = originalWarn;
    }
    expect(calls).toEqual([
      "backup",
      "save",
      "warn:[openai-provider-migration] providerContextCaps.openai: conflict resolved",
    ]);
  });

  test("projection collision performs zero backup/save", () => {
    const calls: string[] = [];
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => { calls.push("project"); throw new OpenAiTierMigrationCollisionError(); },
      backup: () => { calls.push("backup"); },
      save: () => { calls.push("save"); },
    })).toThrow(OpenAiTierMigrationCollisionError);
    expect(calls).toEqual(["project"]);
  });

  test("backup failure performs no save", () => {
    const calls: string[] = [];
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => ({ config: { ...config }, changed: true, resolvedMode: "pool", warnings: [] }),
      backup: () => { calls.push("backup"); throw new Error("backup failed"); },
      save: () => { calls.push("save"); },
    })).toThrow("backup failed");
    expect(calls).toEqual(["backup"]);
  });

  test("unchanged projection skips backup and save entirely", () => {
    const calls: string[] = [];
    const result = runOpenAiTierStartupMigration(config, {
      project: () => { calls.push("project"); return { config: { ...config }, changed: false, resolvedMode: "pool", warnings: [] }; },
      backup: () => { calls.push("backup"); },
      save: () => { calls.push("save"); },
    });
    expect(calls).toEqual(["project"]);
    expect(result.defaultProvider).toBe(config.defaultProvider);
  });

  test("save failure propagates without masking", () => {
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => ({ config: { ...config }, changed: true, resolvedMode: "pool", warnings: ["must not emit"] }),
      backup: () => {},
      save: () => { throw new Error("disk full"); },
    })).toThrow("disk full");
  });

  test("rollback collision preserves the snapshot then retries backup once before save (#1599)", () => {
    const calls: string[] = [];
    let backups = 0;
    const projected = { ...config, openaiProviderTierVersion: 2 as const };
    const result = runOpenAiTierStartupMigration(config, {
      project: () => ({ config: projected, changed: true, resolvedMode: "pool", warnings: [] }),
      backup: () => {
        calls.push("backup");
        backups += 1;
        if (backups === 1) throw new OpenAiTierBackupCollisionError();
      },
      preserveRollback: () => { calls.push("preserve"); },
      save: () => { calls.push("save"); },
    });
    expect(calls).toEqual(["backup", "preserve", "backup", "save"]);
    expect(result).toBe(projected);
  });

  test("rollback preserve failure leaves the original backup and does not save (#1599)", () => {
    const calls: string[] = [];
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => ({ config: { ...config, openaiProviderTierVersion: 2 }, changed: true, resolvedMode: "pool", warnings: [] }),
      backup: () => { calls.push("backup"); throw new OpenAiTierBackupCollisionError(); },
      preserveRollback: () => { calls.push("preserve"); throw new Error("preserve failed"); },
      save: () => { calls.push("save"); },
    })).toThrow("preserve failed");
    expect(calls).toEqual(["backup", "preserve"]);
  });

  test("non-collision backup errors are not retried (#1599)", () => {
    const calls: string[] = [];
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => ({ config: { ...config }, changed: true, resolvedMode: "pool", warnings: [] }),
      backup: () => { calls.push("backup"); throw new OpenAiTierBackupCleanupError(); },
      preserveRollback: () => { calls.push("preserve"); },
      save: () => { calls.push("save"); },
    })).toThrow(OpenAiTierBackupCleanupError);
    expect(calls).toEqual(["backup"]);
  });

  test("rollback collision retries backup only once (#1599)", () => {
    const calls: string[] = [];
    expect(() => runOpenAiTierStartupMigration(config, {
      project: () => ({ config: { ...config, openaiProviderTierVersion: 2 }, changed: true, resolvedMode: "pool", warnings: [] }),
      backup: () => { calls.push("backup"); throw new OpenAiTierBackupCollisionError(); },
      preserveRollback: () => { calls.push("preserve"); },
      save: () => { calls.push("save"); },
    })).toThrow(OpenAiTierBackupCollisionError);
    expect(calls).toEqual(["backup", "preserve", "backup"]);
  });

  test("absent original file produces a no-op backup", () => {
    const state = virtualBackupIO({});
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/nonexistent.json", state.io)).toBe("absent");
    expect(state.calls).toEqual([]);
  });

  test("atomic writer reports a scrubbed residual when unlink permanently fails", () => {
    let scrubbed = false;
    expect(() => atomicWriteFile("/virtual/config.json", "secret", {
      write: () => {},
      harden: () => {},
      rename: () => { throw new Error("rename failed"); },
      truncate: () => { scrubbed = true; },
      unlink: () => { throw new Error("unlink failed"); },
    })).toThrow(AtomicWriteResidualTempError);
    expect(scrubbed).toBe(true);
  });

  test("atomic writer reports an honest secret residual when scrub and removal both fail", () => {
    let writes = 0;
    expect(() => atomicWriteFile("/virtual/config.json", "secret", {
      write: () => {
        writes += 1;
        if (writes > 1) throw new Error("overwrite failed");
      },
      harden: () => {},
      rename: () => { throw new Error("rename failed"); },
      truncate: () => { throw new Error("truncate failed"); },
      unlink: () => { throw new Error("unlink failed"); },
    })).toThrow(AtomicWriteSecretResidualError);
  });

  test("atomic writer cleans initial write and harden failures without touching the destination", () => {
    for (const stage of ["write", "harden"] as const) {
      const files = new Map([["/virtual/config.json", "original"]]);
      let writeCalls = 0;
      expect(() => atomicWriteFile("/virtual/config.json", "secret", {
        write: (path, value) => {
          writeCalls += 1;
          if (stage === "write" && writeCalls === 1) throw new Error("write failed");
          files.set(path, value);
        },
        harden: () => { if (stage === "harden") throw new Error("harden failed"); },
        rename: (source, destination) => { files.set(destination, files.get(source)!); files.delete(source); },
        truncate: path => { files.set(path, ""); },
        unlink: path => { files.delete(path); },
      })).toThrow(`${stage} failed`);
      expect(files.get("/virtual/config.json")).toBe("original");
      expect([...files.keys()].filter(path => path.endsWith(".tmp"))).toEqual([]);
    }
  });

  test("backup creates a hardened no-replace snapshot and removes its hard-link temp", () => {
    const state = virtualBackupIO({ "/virtual/config.json": "original-secret" });
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", state.io)).toBe("created");
    const backup = state.files.get("/virtual/config.json.pre-openai-tiers-v2.bak");
    expect(new TextDecoder().decode(backup?.bytes)).toBe("original-secret");
    expect(backup?.hardened).toBe(true);
    expect([...state.files.keys()].filter(path => path.endsWith(".tmp"))).toEqual([]);
  });

  test("backup temp cleanup forgets successful ACL memos and retains failed removals", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-backup-acl-"));
    const source = join(root, "config.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(source, "original-secret");
      expect(backupConfigBeforeOpenAiTierMigration(source, aclBackupIO())).toBe("created");
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);

      unlinkSync(`${source}.pre-openai-tiers-v2.bak`);
      let failRemoval = true;
      expect(() => backupConfigBeforeOpenAiTierMigration(source, aclBackupIO({
        failTempUnlink: () => failRemoval,
      }))).toThrow(OpenAiTierBackupCleanupError);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(1);
      failRemoval = false;
      for (const name of readdirSync(root)) {
        if (name.endsWith(".tmp")) unlinkSync(join(root, name));
      }
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      removeTreeWithRetry(root);
    }
  });

  test("backup unlink EPERM retains its ACL memo when exists falsely reports the temp absent", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-backup-hidden-acl-"));
    const source = join(root, "config.json");
    const backup = `${source}.pre-openai-tiers-v2.bak`;
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(source, "original-secret");
      expect(() => backupConfigBeforeOpenAiTierMigration(source, aclBackupIO({
        failTempUnlink: () => true,
        hideTempFromExists: true,
      }))).toThrow(OpenAiTierBackupCleanupError);
      expect(existsSync(backup)).toBe(false);
      const residuals = readdirSync(root).filter(name => name.endsWith(".tmp"));
      expect(residuals).toHaveLength(1);
      expect(existsSync(join(root, residuals[0]!))).toBe(true);
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(1);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      removeTreeWithRetry(root);
    }
  });

  test("backup confirmed-absent cleanup forgets a memo created before the temp vanished", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-backup-absent-acl-"));
    const source = join(root, "config.json");
    const previousUsername = process.env.USERNAME;
    process.env.USERNAME = "ocx-test-user";
    windowsAcl.resetHardenedStateForTests();
    windowsAcl.setPlatformForTests("win32");
    windowsAcl.setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
    try {
      writeFileSync(source, "original-secret");
      expect(() => backupConfigBeforeOpenAiTierMigration(source, aclBackupIO({ vanishAfterHarden: true })))
        .toThrow();
      expect(windowsAcl.hardenedSecretPathCountForTests()).toBe(0);
    } finally {
      windowsAcl.setIcaclsRunnerForTests(null);
      windowsAcl.setPlatformForTests(null);
      windowsAcl.resetHardenedStateForTests();
      if (previousUsername === undefined) delete process.env.USERNAME;
      else process.env.USERNAME = previousUsername;
      removeTreeWithRetry(root);
    }
  });

  test("v2 backup creation never overwrites the historical v1 snapshot", () => {
    const state = virtualBackupIO({
      "/virtual/config.json": "three-tier-state",
      "/virtual/config.json.pre-openai-tiers-v1.bak": "pre-three-tier-state",
    });
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", state.io)).toBe("created");
    expect(new TextDecoder().decode(state.files.get("/virtual/config.json.pre-openai-tiers-v1.bak")?.bytes)).toBe("pre-three-tier-state");
    expect(new TextDecoder().decode(state.files.get("/virtual/config.json.pre-openai-tiers-v2.bak")?.bytes)).toBe("three-tier-state");
  });

  test("backup reuses byte-identical snapshots and replaces stale ones", () => {
    const equal = virtualBackupIO({
      "/virtual/config.json": "same",
      "/virtual/config.json.pre-openai-tiers-v2.bak": "same",
    });
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", equal.io)).toBe("reused");
    expect(equal.calls.some(call => call.startsWith("create:"))).toBe(false);

    const different = virtualBackupIO({
      "/virtual/config.json": "current",
      "/virtual/config.json.pre-openai-tiers-v2.bak": "older",
    });
    // Stale backup (config was rewritten by ocx init) is deleted and recreated atomically
    // with proper permissions, not written in-place (issue #257).
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", different.io)).toBe("created");
    expect(new TextDecoder().decode(different.files.get("/virtual/config.json.pre-openai-tiers-v2.bak")!.bytes)).toBe("current");
  });

  test("backup throws collision for a differing v1 JSON backup (not silently replaced)", () => {
    // A backup that parses as a valid pre-migration (v1) config is a legitimate rollback
    // point. Silently replacing it could destroy the user's intended restore snapshot.
    const v1Backup = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    const io = virtualBackupIO({
      "/virtual/config.json": "current-config",
      "/virtual/config.json.pre-openai-tiers-v2.bak": v1Backup,
    });
    expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", io.io)).toThrow(OpenAiTierBackupCollisionError);
    // The original backup must remain intact.
    expect(new TextDecoder().decode(io.files.get("/virtual/config.json.pre-openai-tiers-v2.bak")!.bytes)).toBe(v1Backup);
  });

  test("backup replaces a differing v2 JSON backup (post-migration config was rewritten)", () => {
    // A backup whose openaiProviderTierVersion is 2 was created from an already-migrated
    // config, meaning ocx init or another process replaced config.json after migration.
    const v2Backup = JSON.stringify({ openaiProviderTierVersion: 2, port: 10100, defaultProvider: "openai", providers: {} });
    const io = virtualBackupIO({
      "/virtual/config.json": "current-config",
      "/virtual/config.json.pre-openai-tiers-v2.bak": v2Backup,
    });
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", io.io)).toBe("created");
    expect(new TextDecoder().decode(io.files.get("/virtual/config.json.pre-openai-tiers-v2.bak")!.bytes)).toBe("current-config");
  });

  test("an EEXIST publication race compares and reuses the winner", () => {
    const race = virtualBackupIO({ "/virtual/config.json": "same" }, {
      publish: Object.assign(new Error("race"), { code: "EEXIST" }),
    });
    const originalPublish = race.io.publishNoReplace;
    race.io.publishNoReplace = (temp, backup) => {
      race.files.set(backup, { bytes: new TextEncoder().encode("same"), hardened: true });
      originalPublish(temp, backup);
    };
    expect(backupConfigBeforeOpenAiTierMigration("/virtual/config.json", race.io)).toBe("reused");
    expect([...race.files.keys()].filter(path => path.endsWith(".tmp"))).toEqual([]);
  });

  test("post-publication cleanup rolls back before scrubbing the shared temp", () => {
    const state = virtualBackupIO({ "/virtual/config.json": "original-secret" }, { tempUnlink: 2 });
    expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", state.io))
      .toThrow(OpenAiTierBackupCleanupError);
    expect(state.files.has("/virtual/config.json.pre-openai-tiers-v2.bak")).toBe(false);
    expect([...state.files.values()].some(inode => new TextDecoder().decode(inode.bytes).includes("secret"))).toBe(true);
    expect([...state.files.keys()].filter(path => path.endsWith(".tmp"))).toEqual([]);
  });

  test("rollback failure preserves both hardened links with complete bytes", () => {
    const state = virtualBackupIO(
      { "/virtual/config.json": "original-secret" },
      { tempUnlink: 2, backupUnlink: 1 },
    );
    expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", state.io))
      .toThrow(OpenAiTierBackupRollbackError);
    const survivors = [...state.files.entries()].filter(([path]) => path !== "/virtual/config.json");
    expect(survivors).toHaveLength(2);
    for (const [, inode] of survivors) {
      expect(new TextDecoder().decode(inode.bytes)).toBe("original-secret");
      expect(inode.hardened).toBe(true);
    }
  });

  test("backup reports honest secret residuals before publication and after rollback", () => {
    const beforePublish = virtualBackupIO(
      { "/virtual/config.json": "backup-secret" },
      { harden: 1, truncate: 1, writeAfter: 1, tempUnlink: 2 },
    );
    expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", beforePublish.io))
      .toThrow(OpenAiTierBackupSecretResidualError);
    expect([...beforePublish.files.values()].some(inode => new TextDecoder().decode(inode.bytes) === "backup-secret")).toBe(true);

    const afterRollback = virtualBackupIO(
      { "/virtual/config.json": "backup-secret" },
      { tempUnlink: 4, truncate: 1, writeAfter: 1 },
    );
    expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", afterRollback.io))
      .toThrow(OpenAiTierBackupSecretResidualError);
    expect(afterRollback.files.has("/virtual/config.json.pre-openai-tiers-v2.bak")).toBe(false);
    const residual = [...afterRollback.files.entries()].find(([path]) => path.endsWith(".tmp"));
    expect(new TextDecoder().decode(residual?.[1].bytes)).toBe("backup-secret");
    expect(afterRollback.calls.filter(call => call.startsWith("unlink:") && call.endsWith(".tmp"))).toHaveLength(4);
  });

  test("backup aborts cleanly at every pre-publication stage", () => {
    for (const stage of ["read", "create", "write", "harden", "publish"] as const) {
      const failure = stage === "publish"
        ? { publish: new Error("publish failed") }
        : { [stage]: 1 };
      const state = virtualBackupIO({ "/virtual/config.json": "original-secret" }, failure);
      expect(() => backupConfigBeforeOpenAiTierMigration("/virtual/config.json", state.io)).toThrow(`${stage} failed`);
      expect(new TextDecoder().decode(state.files.get("/virtual/config.json")?.bytes)).toBe("original-secret");
      expect(state.files.has("/virtual/config.json.pre-openai-tiers-v2.bak")).toBe(false);
      expect([...state.files.keys()].filter(path => path.endsWith(".tmp"))).toEqual([]);
      const expectedPrefix = stage === "read" ? ["read:/virtual/config.json"] : ["read:/virtual/config.json", expect.stringContaining("create:")];
      expect(state.calls.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    }
  });

  test("startup migration preserves a rollback-classified v2 backup then continues (#1599)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-1599-startup-"));
    try {
      const configPath = join(dir, "config.json");
      const v2Backup = `${configPath}.pre-openai-tiers-v2.bak`;
      const currentConfig: OcxConfig = {
        port: 10100,
        defaultProvider: "kimi",
        providers: { kimi: { adapter: "openai-chat", baseUrl: "https://api.moonshot.cn/v1" } },
      };
      const currentBytes = `${JSON.stringify(currentConfig, null, 2)}\n`;
      const rollbackBytes = `${JSON.stringify({
        openaiProviderTierVersion: 1,
        defaultProvider: "openai-multi",
        providers: { "openai-multi": { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      }, null, 2)}\n`;
      writeFileSync(configPath, currentBytes);
      writeFileSync(v2Backup, rollbackBytes);

      expect(projectOpenAiTierMigration(currentConfig).changed).toBe(true);
      expect(currentConfig).not.toHaveProperty("openaiProviderTierVersion");

      const result = runOpenAiTierStartupMigration(currentConfig, {
        project: projectOpenAiTierMigration,
        backup: () => backupConfigBeforeOpenAiTierMigration(configPath),
        save: value => { writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`); },
      });

      expect(result.openaiProviderTierVersion).toBe(2);
      expect(result.defaultProvider).toBe("kimi");
      expect(readFileSync(configPath, "utf8")).toContain('"openaiProviderTierVersion": 2');
      expect(readFileSync(v2Backup, "utf8")).toBe(currentBytes);
      const preserved = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
      expect(preserved).toHaveLength(1);
      expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(rollbackBytes);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("startup migration does not overwrite an occupied rollback destination (#1599)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-1599-collide-"));
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const configPath = join(dir, "config.json");
      const v2Backup = `${configPath}.pre-openai-tiers-v2.bak`;
      const occupied = `${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`;
      const currentConfig: OcxConfig = {
        port: 10100,
        defaultProvider: "kimi",
        providers: { kimi: { adapter: "openai-chat", baseUrl: "https://api.moonshot.cn/v1" } },
      };
      const currentBytes = `${JSON.stringify(currentConfig, null, 2)}\n`;
      const rollbackBytes = JSON.stringify({ openaiProviderTierVersion: 1, defaultProvider: "openai-multi", providers: {} });
      writeFileSync(configPath, currentBytes);
      writeFileSync(v2Backup, rollbackBytes);
      writeFileSync(occupied, "existing rollback");

      runOpenAiTierStartupMigration(currentConfig, {
        project: projectOpenAiTierMigration,
        backup: () => backupConfigBeforeOpenAiTierMigration(configPath),
        save: value => { writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`); },
      });

      expect(readFileSync(occupied, "utf8")).toBe("existing rollback");
      expect(readFileSync(v2Backup, "utf8")).toBe(currentBytes);
      const preserved = readdirSync(dir)
        .filter(name => name.includes("pre-openai-tiers-v1-rollback") && join(dir, name) !== occupied);
      expect(preserved).toHaveLength(1);
      expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(rollbackBytes);
    } finally {
      Date.now = realNow;
      removeTreeWithRetry(dir);
    }
  });

  test("unchanged projection does not touch rollback or v2 backups (#1599)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-1599-unchanged-"));
    try {
      const configPath = join(dir, "config.json");
      const v2Backup = `${configPath}.pre-openai-tiers-v2.bak`;
      const rollbackName = `${configPath}.pre-openai-tiers-v1-rollback.keep.bak`;
      writeFileSync(configPath, "current");
      writeFileSync(v2Backup, "v2-backup");
      writeFileSync(rollbackName, "rollback");
      const marked = { ...config, openaiProviderTierVersion: 2 as const };
      const result = runOpenAiTierStartupMigration(marked, {
        project: () => ({ config: marked, changed: false, resolvedMode: "pool", warnings: [] }),
        backup: () => backupConfigBeforeOpenAiTierMigration(configPath),
        save: () => { writeFileSync(configPath, "migrated"); },
      });
      expect(result).toBe(marked);
      expect(readFileSync(configPath, "utf8")).toBe("current");
      expect(readFileSync(v2Backup, "utf8")).toBe("v2-backup");
      expect(readFileSync(rollbackName, "utf8")).toBe("rollback");
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("startup leaves the v2 backup and does not save when rollback copy fails (#1599)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-1599-copyfail-"));
    try {
      const configPath = join(dir, "config.json");
      const v2Backup = `${configPath}.pre-openai-tiers-v2.bak`;
      const currentConfig: OcxConfig = {
        port: 10100,
        defaultProvider: "kimi",
        providers: { kimi: { adapter: "openai-chat", baseUrl: "https://api.moonshot.cn/v1" } },
      };
      const currentBytes = `${JSON.stringify(currentConfig, null, 2)}\n`;
      const rollbackBytes = JSON.stringify({ openaiProviderTierVersion: 1, defaultProvider: "openai-multi", providers: {} });
      writeFileSync(configPath, currentBytes);
      writeFileSync(v2Backup, rollbackBytes);
      const failingIo: OpenAiTierRollbackPreserveIO = {
        exists: existsSync,
        read: path => readFileSync(path),
        copyExclusive: () => { throw new Error("copy failed"); },
        unlink: unlinkSync,
      };

      expect(() => runOpenAiTierStartupMigration(currentConfig, {
        project: projectOpenAiTierMigration,
        backup: () => backupConfigBeforeOpenAiTierMigration(configPath),
        preserveRollback: () => { preserveOpenAiTierRollbackSnapshot(configPath, failingIo); },
        save: () => { throw new Error("save must not run"); },
      })).toThrow("copy failed");

      expect(readFileSync(v2Backup, "utf8")).toBe(rollbackBytes);
      expect(readFileSync(configPath, "utf8")).toBe(currentBytes);
      expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("preserveOpenAiTierRollbackSnapshot rejects stale backups without deleting them (#1599)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-1599-stale-"));
    try {
      const configPath = join(dir, "config.json");
      const v2Backup = `${configPath}.pre-openai-tiers-v2.bak`;
      const stale = JSON.stringify({ openaiProviderTierVersion: 2, providers: {} });
      writeFileSync(configPath, "current");
      writeFileSync(v2Backup, stale);
      expect(() => preserveOpenAiTierRollbackSnapshot(configPath)).toThrow(OpenAiTierRollbackPreserveError);
      expect(readFileSync(v2Backup, "utf8")).toBe(stale);
      expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
    } finally {
      removeTreeWithRetry(dir);
    }
  });
});
