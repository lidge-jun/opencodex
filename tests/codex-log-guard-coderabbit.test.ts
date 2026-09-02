import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexLogGuardLockDigest } from "../src/codex/log-guard/lock";
import { sameLogGuardPathIdentity } from "../src/codex/log-guard/path-safety";
import {
  getCodexLogGuardProtectionStatus,
  protectCodexLogs,
  unprotectCodexLogs,
} from "../src/codex/log-guard/protection";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function createCurrentLogsDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_thread_id ON logs(thread_id);
    CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_process_uuid_threadless_ts
      ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
      WHERE thread_id IS NULL;
  `);
  db.close();
}

function fixture(): { codexHome: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-cr-protect-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const databasePath = join(codexHome, "logs_2.sqlite");
  createCurrentLogsDb(databasePath);
  return { codexHome, databasePath };
}

function deps(codexHome: string, writeDesiredMode?: (mode: "off" | "compat" | "quiet") => void) {
  let desired: "off" | "compat" | "quiet" = "off";
  return {
    codexHome,
    processCheck: () => ({ state: "ok" as const, processes: [] }),
    readDesiredMode: () => desired,
    writeDesiredMode: (mode: "off" | "compat" | "quiet") => {
      desired = mode;
      writeDesiredMode?.(mode);
    },
    withLock: <T>(_home: string, _db: string, work: () => T) => ({ kind: "completed" as const, value: work() }),
  };
}

function reservedTriggers(databasePath: string): Array<{ name: string; sql: string }> {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'opencodex_log_guard_%' ORDER BY name",
    ).all();
  } finally {
    db.close();
  }
}

describe("CodeRabbit protection regressions", () => {
  test("compatible but unsafe trigger path reports unknown protection state", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-cr-symlink-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    if (process.platform === "win32") {
      const realCodexHome = join(root, "real-codex-home");
      mkdirSync(realCodexHome);
      writeFileSync(join(realCodexHome, "config.toml"), "");
      createCurrentLogsDb(join(realCodexHome, "logs_2.sqlite"));
      // Unelevated Windows can create a junction but not a file symlink. The
      // ancestor redirection exercises the same concrete unsafe-path refusal.
      symlinkSync(realCodexHome, codexHome, "junction");
    } else {
      mkdirSync(codexHome);
      writeFileSync(join(codexHome, "config.toml"), "");
      const target = join(root, "real-logs.sqlite");
      createCurrentLogsDb(target);
      symlinkSync(target, join(codexHome, "logs_2.sqlite"));
    }

    const status = getCodexLogGuardProtectionStatus(deps(codexHome));
    expect(status.schema.state).toBe("compatible");
    expect(status.protection).toEqual({ desiredMode: "off", observedMode: "collision", state: "unknown" });
  });

  test.skipIf(process.platform !== "darwin")(
    "Darwin accepts only trusted system aliases and rejects an arbitrary ancestor symlink",
    () => {
      expect(sameLogGuardPathIdentity(
        "/private/tmp/opencodex-log-guard/logs_2.sqlite",
        "/tmp/opencodex-log-guard/logs_2.sqlite",
      )).toBe(true);
      expect(sameLogGuardPathIdentity(
        "/private/var/tmp/opencodex-log-guard/logs_2.sqlite",
        "/var/tmp/opencodex-log-guard/logs_2.sqlite",
      )).toBe(true);

      const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-cr-path-"));
      roots.push(root);
      const realParent = join(root, "real");
      const aliasParent = join(root, "alias");
      mkdirSync(realParent);
      symlinkSync(realParent, aliasParent, "dir");

      expect(sameLogGuardPathIdentity(
        join(realParent, "logs_2.sqlite"),
        join(aliasParent, "logs_2.sqlite"),
      )).toBe(false);
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "Darwin trusted aliases share one Log Guard lock digest",
    () => {
      expect(codexLogGuardLockDigest(
        "/tmp/opencodex-home",
        "/var/tmp/opencodex-home/logs_2.sqlite",
      )).toBe(codexLogGuardLockDigest(
        "/private/tmp/opencodex-home",
        "/private/var/tmp/opencodex-home/logs_2.sqlite",
      ));
    },
  );

  test("successful mutation status honors a fresh unsupported inspection", () => {
    const { codexHome, databasePath } = fixture();
    const result = protectCodexLogs("compat", deps(codexHome, () => {
      const db = new Database(databasePath);
      db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
      db.close();
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.capabilities.protection.state).toBe("unsupported");
    expect(result.status.protection.state).toBe("unsupported");
  });

  test("unprotect recovers when both exact OpenCodex-owned triggers are present", () => {
    const { codexHome, databasePath } = fixture();
    const testDeps = deps(codexHome);
    expect(protectCodexLogs("compat", testDeps).ok).toBe(true);

    const db = new Database(databasePath);
    db.exec(`
      CREATE TRIGGER opencodex_log_guard_quiet_v1
      BEFORE INSERT ON logs
      WHEN upper(NEW.level) = 'TRACE'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    db.close();

    const result = unprotectCodexLogs(testDeps);
    expect(result.ok).toBe(true);
    expect(reservedTriggers(databasePath)).toEqual([]);
  });

  test("config-write compensation restores every previously owned trigger definition", () => {
    const { codexHome, databasePath } = fixture();
    expect(protectCodexLogs("compat", deps(codexHome)).ok).toBe(true);

    const db = new Database(databasePath);
    db.exec(`
      CREATE TRIGGER opencodex_log_guard_quiet_v1
      BEFORE INSERT ON logs
      WHEN upper(NEW.level) = 'TRACE'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    db.close();
    const before = reservedTriggers(databasePath);

    const result = protectCodexLogs("quiet", deps(codexHome, () => {
      throw new Error("disk full");
    }));

    expect(result).toEqual({ ok: false, error: "config_write_failed" });
    expect(reservedTriggers(databasePath)).toEqual(before);
  });
});

/*
 * Windows CI reported 22 Log Guard failures as `unsafe_path`, on a feature (#1729) that is
 * new in this release range and has therefore never shipped.
 *
 * `realpathSync.native` on Windows expands 8.3 short components — the `RUNNER~1` form that
 * appears throughout %TEMP% — so the canonical realpath and the requested path disagree as
 * strings while naming the same file. The safety check read that as an ancestor-symlink
 * redirection and refused every mutation. macOS had the same class of problem with /var and
 * /tmp and was given an explicit alias normalizer; Windows was not.
 */
describe("log guard path identity survives OS canonicalization", () => {
  test("a path that only differs by the OS's own canonical spelling is the same file", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-identity-"));
    roots.push(root);
    const path = join(root, "logs_2.sqlite");
    writeFileSync(path, "");

    // realpathSync.native is exactly what databasePathIsSafe compares against.
    expect(sameLogGuardPathIdentity(realpathSync.native(path), path)).toBe(true);
  });

  // The guard this widening must not weaken: a redirection resolves somewhere else, and
  // "somewhere else" is still refused.
  test("a symlinked database is still refused", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-identity-"));
    roots.push(root);
    const real = join(root, "real.sqlite");
    const link = join(root, "logs_2.sqlite");
    writeFileSync(real, "");
    try {
      symlinkSync(real, link);
    } catch {
      return; // unprivileged Windows cannot create symlinks; the POSIX legs cover this
    }

    expect(sameLogGuardPathIdentity(realpathSync.native(link), link)).toBe(false);
  });

  test("an unrelated sibling path is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-identity-"));
    roots.push(root);
    const path = join(root, "logs_2.sqlite");
    writeFileSync(path, "");

    expect(sameLogGuardPathIdentity(join(root, "elsewhere.sqlite"), path)).toBe(false);
  });
});
