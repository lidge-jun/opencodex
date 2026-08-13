import { afterEach, describe, expect, test } from "bun:test";
import { constants as fsConstants, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupOpenAiTierBackupAfterInit } from "../src/cli/init";
import {
  classifyOpenAiTierBackup,
  OpenAiTierRollbackPreserveCleanupError,
  OpenAiTierRollbackPreserveError,
  OpenAiTierRollbackPreserveSecretResidualError,
  preserveOpenAiTierRollbackSnapshot,
  type OpenAiTierRollbackPreserveIO,
} from "../src/config";

function preserveIo(
  backup: string,
  overrides: Partial<OpenAiTierRollbackPreserveIO> = {},
  options: { allowSourceUnlink?: boolean } = {},
): OpenAiTierRollbackPreserveIO {
  return {
    exists: existsSync,
    read: path => readFileSync(path),
    copyExclusive: (source, destination) => {
      copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    },
    harden: () => {},
    truncate: path => {
      if (path === backup) throw new Error("source truncate must not run");
      truncateSync(path, 0);
    },
    write: (path, bytes) => {
      if (path === backup) throw new Error("source write must not run");
      writeFileSync(path, bytes);
    },
    unlink: path => {
      if (path === backup && !options.allowSourceUnlink) throw new Error("source unlink must not run");
      unlinkSync(path);
    },
    ...overrides,
  };
}

describe("cleanupOpenAiTierBackupAfterInit", () => {
  const dirs: string[] = [];
  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-init-backup-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  test("no-op when no backup exists", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes a stale post-migration (v2) backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, JSON.stringify({ openaiProviderTierVersion: 2, port: 10100, providers: {} }));
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("deletes an unparseable backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    writeFileSync(backup, "not-json{{{");
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
  });

  test("preserves a valid pre-migration (v1) rollback snapshot by renaming it", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    cleanupOpenAiTierBackupAfterInit(configPath);
    expect(existsSync(backup)).toBe(false);
    const preserved = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(v1);
  });

  test("does not overwrite an occupied rollback destination (no-replace publication)", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    // Pre-occupy the first-choice destination for the current clock tick(s).
    const now = Date.now();
    const existing = `${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`;
    writeFileSync(existing, "existing rollback");
    const realNow = Date.now;
    Date.now = () => now; // freeze the clock so the collision is deterministic
    try {
      cleanupOpenAiTierBackupAfterInit(configPath);
    } finally {
      Date.now = realNow;
    }
    // The pre-existing snapshot must be untouched, and the v1 backup preserved elsewhere.
    expect(readFileSync(existing, "utf8")).toBe("existing rollback");
    expect(existsSync(backup)).toBe(false);
    const preserved = readdirSync(dir)
      .filter(name => name.includes("pre-openai-tiers-v1-rollback") && join(dir, name) !== existing);
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(v1);
  });

  test("classifyOpenAiTierBackup shares the migration policy", () => {
    const enc = (value: string) => new TextEncoder().encode(value);
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 2 })))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc("garbage"))).toBe("stale");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({ openaiProviderTierVersion: 1 })))).toBe("rollback");
    expect(classifyOpenAiTierBackup(enc(JSON.stringify({})))).toBe("rollback");
  });

  test("preserveOpenAiTierRollbackSnapshot copy failure keeps the v2 backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      copyExclusive: () => { throw new Error("copy failed"); },
      harden: () => { throw new Error("harden must not run"); },
      truncate: () => { throw new Error("truncate must not run"); },
      write: () => { throw new Error("write must not run"); },
      unlink: () => { throw new Error("unlink must not run"); },
    }))).toThrow("copy failed");
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot does not overwrite occupied destinations and keeps source on exhaustion", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const now = Date.now();
    writeFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`, "occupied");
    for (let attempt = 1; attempt < 16; attempt++) {
      writeFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}-${attempt}.bak`, "occupied");
    }
    const realNow = Date.now;
    Date.now = () => now;
    try {
      expect(() => preserveOpenAiTierRollbackSnapshot(configPath)).toThrow(OpenAiTierRollbackPreserveError);
    } finally {
      Date.now = realNow;
    }
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}.bak`, "utf8")).toBe("occupied");
    expect(readFileSync(`${configPath}.pre-openai-tiers-v1-rollback.${now}-1.bak`, "utf8")).toBe("occupied");
  });

  test("preserveOpenAiTierRollbackSnapshot hardens before unlinking the source", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const calls: string[] = [];
    const preserved = preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      read: path => {
        calls.push(path === backup ? "read-source" : "read-preserved");
        return readFileSync(path);
      },
      copyExclusive: (source, destination) => {
        calls.push("copy");
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
      },
      harden: path => { calls.push(`harden:${path}`); },
      truncate: () => { throw new Error("truncate must not run"); },
      write: () => { throw new Error("write must not run"); },
      unlink: path => {
        calls.push(path === backup ? "unlink-source" : "unlink-other");
        if (path !== backup) throw new Error("only the source backup may be unlinked after a verified copy");
        unlinkSync(path);
      },
    }, { allowSourceUnlink: true }));
    expect(calls).toEqual(["read-source", "copy", "read-preserved", `harden:${preserved}`, "read-source", "unlink-source"]);
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(preserved, "utf8")).toBe(v1);
  });

  test("preserveOpenAiTierRollbackSnapshot harden failure keeps the v2 backup", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const calls: string[] = [];
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      harden: () => { throw new Error("harden failed"); },
      truncate: path => { calls.push(`truncate:${path}`); truncateSync(path, 0); },
      unlink: path => {
        calls.push(path === backup ? "unlink-source" : "unlink-preserved");
        if (path === backup) throw new Error("source unlink must not run");
        unlinkSync(path);
      },
    }))).toThrow("harden failed");
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(calls[0]?.startsWith("truncate:") && calls[0]!.includes("pre-openai-tiers-v1-rollback")).toBe(true);
    expect(calls).toEqual([calls[0]!, "unlink-preserved"]);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot does not unlink a source that changed after copy", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const bytesA = JSON.stringify({ openaiProviderTierVersion: 1, defaultProvider: "openai-multi", providers: {} });
    const bytesB = JSON.stringify({ openaiProviderTierVersion: 1, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, bytesA);
    const hardened: string[] = [];
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      copyExclusive: (source, destination) => {
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
        writeFileSync(source, bytesB);
      },
      harden: path => { hardened.push(path); },
      truncate: () => { throw new Error("verified hardened copy must not be scrubbed"); },
      write: () => { throw new Error("verified hardened copy must not be overwritten"); },
    }))).toThrow(OpenAiTierRollbackPreserveError);
    expect(readFileSync(backup, "utf8")).toBe(bytesB);
    const preserved = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf8")).toBe(bytesA);
    expect(hardened).toEqual([join(dir, preserved[0]!)]);
  });

  test("preserveOpenAiTierRollbackSnapshot removes an unverified copy when read(preserved) fails", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const calls: string[] = [];
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      read: path => {
        if (path.includes("pre-openai-tiers-v1-rollback")) throw new Error("read preserved failed");
        return readFileSync(path);
      },
      harden: () => { throw new Error("harden must not run"); },
      truncate: path => { calls.push(`truncate:${path}`); truncateSync(path, 0); },
      unlink: path => {
        calls.push(path === backup ? "unlink-source" : "unlink-preserved");
        if (path === backup) throw new Error("source unlink must not run");
        unlinkSync(path);
      },
    }))).toThrow("Failed to read preserved rollback snapshot");
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(calls[0]?.startsWith("truncate:") && calls[0]!.includes("pre-openai-tiers-v1-rollback")).toBe(true);
    expect(calls).toEqual([calls[0]!, "unlink-preserved"]);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot scrubs a byte-mismatched copy", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const calls: string[] = [];
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      copyExclusive: (source, destination) => {
        copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
        writeFileSync(destination, "tampered-secret");
      },
      harden: () => { throw new Error("harden must not run"); },
      truncate: path => { calls.push(`truncate:${path}`); truncateSync(path, 0); },
      unlink: path => {
        calls.push(path === backup ? "unlink-source" : "unlink-preserved");
        if (path === backup) throw new Error("source unlink must not run");
        unlinkSync(path);
      },
    }))).toThrow("Preserved rollback snapshot does not match source bytes");
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(calls[0]?.startsWith("truncate:") && calls[0]!.includes("pre-openai-tiers-v1-rollback")).toBe(true);
    expect(calls).toEqual([calls[0]!, "unlink-preserved"]);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot retries unlink once after the first cleanup unlink fails", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    let preservedUnlinks = 0;
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      read: path => {
        if (path.includes("pre-openai-tiers-v1-rollback")) throw new Error("read preserved failed");
        return readFileSync(path);
      },
      harden: () => { throw new Error("harden must not run"); },
      unlink: path => {
        if (path === backup) throw new Error("source unlink must not run");
        preservedUnlinks += 1;
        if (preservedUnlinks === 1) throw new Error("first unlink failed");
        unlinkSync(path);
      },
    }))).toThrow("Failed to read preserved rollback snapshot");
    expect(preservedUnlinks).toBe(2);
    expect(readFileSync(backup, "utf8")).toBe(v1);
    expect(readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"))).toEqual([]);
  });

  test("preserveOpenAiTierRollbackSnapshot does not leave plaintext when unlink keeps failing after a successful scrub", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const leftoverHarden: string[] = [];
    expect(() => preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
      read: path => {
        if (path.includes("pre-openai-tiers-v1-rollback")) throw new Error("read preserved failed");
        return readFileSync(path);
      },
      harden: path => { leftoverHarden.push(path); },
      unlink: path => {
        if (path === backup) throw new Error("source unlink must not run");
        throw new Error("unlink failed");
      },
    }))).toThrow(OpenAiTierRollbackPreserveCleanupError);
    expect(readFileSync(backup, "utf8")).toBe(v1);
    const leftover = readdirSync(dir).filter(name => name.includes("pre-openai-tiers-v1-rollback"));
    expect(leftover).toHaveLength(1);
    expect(readFileSync(join(dir, leftover[0]!), "utf8")).toBe("");
    expect(leftoverHarden).toEqual([join(dir, leftover[0]!)]);
  });

  test("preserveOpenAiTierRollbackSnapshot reports a residual-secret error when scrub and unlink both fail", () => {
    const dir = makeDir();
    const configPath = join(dir, "config.json");
    const backup = `${configPath}.pre-openai-tiers-v2.bak`;
    const v1 = JSON.stringify({ openaiProviderTierVersion: 1, port: 10100, defaultProvider: "openai", providers: {} });
    writeFileSync(backup, v1);
    const leftoverHarden: string[] = [];
    try {
      preserveOpenAiTierRollbackSnapshot(configPath, preserveIo(backup, {
        read: path => {
          if (path.includes("pre-openai-tiers-v1-rollback")) throw new Error("read preserved failed");
          return readFileSync(path);
        },
        harden: path => { leftoverHarden.push(path); },
        truncate: () => { throw new Error("truncate failed"); },
        write: () => { throw new Error("write failed"); },
        unlink: path => {
          if (path === backup) throw new Error("source unlink must not run");
          throw new Error("unlink failed");
        },
      }));
      throw new Error("expected residual-secret failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAiTierRollbackPreserveSecretResidualError);
      const residual = error as OpenAiTierRollbackPreserveSecretResidualError;
      expect(residual.preservedPath.includes("pre-openai-tiers-v1-rollback")).toBe(true);
      expect(existsSync(residual.preservedPath)).toBe(true);
      expect(readFileSync(residual.preservedPath, "utf8")).toBe(v1);
      expect(leftoverHarden).toEqual([residual.preservedPath]);
    }
    expect(readFileSync(backup, "utf8")).toBe(v1);
  });
});
