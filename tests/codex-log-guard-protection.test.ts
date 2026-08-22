import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCodexLogGuardProtectionStatus,
  protectCodexLogs,
  repairCodexLogGuardProtection,
  unprotectCodexLogs,
} from "../src/codex/log-guard/protection";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-protect-"));
  roots.push(root);
  return root;
}

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
  const root = makeRoot();
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const databasePath = join(codexHome, "logs_2.sqlite");
  createCurrentLogsDb(databasePath);
  return { codexHome, databasePath };
}

function rows(path: string): Array<{ level: string; target: string }> {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ level: string; target: string }, []>(
      "SELECT level, target FROM logs ORDER BY id",
    ).all();
  } finally {
    db.close();
  }
}

function triggers(path: string): Array<{ name: string; sql: string }> {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ name: string; sql: string }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    ).all();
  } finally {
    db.close();
  }
}

function insert(path: string, level: string, target: string): void {
  const db = new Database(path);
  try {
    db.query(
      "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (?, 0, ?, ?, ?, 1)",
    ).run(Date.now(), level, target, "PRIVATE");
  } finally {
    db.close();
  }
}

function testDeps(codexHome: string, initial: "off" | "compat" | "quiet" = "off") {
  let desired = initial;
  return {
    codexHome,
    processCheck: () => ({ state: "ok" as const, processes: [] }),
    readDesiredMode: () => desired,
    writeDesiredMode: (mode: "off" | "compat" | "quiet") => { desired = mode; },
    withLock: <T>(_home: string, _db: string, work: () => T) => ({ kind: "completed" as const, value: work() }),
    desired: () => desired,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard protection", () => {
  test("compat suppresses only the pinned upstream noisy set and preserves unrelated TRACE", async () => {
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    const result = protectCodexLogs("compat", deps);
    expect(result.ok).toBe(true);
    expect(deps.desired()).toBe("compat");

    insert(databasePath, "TRACE", "codex_api::sse");
    insert(databasePath, "TRACE", "opentelemetry_sdk");
    insert(databasePath, "TRACE", "opentelemetry_sdk::trace");
    insert(databasePath, "TRACE", "custom::trace");
    insert(databasePath, "DEBUG", "rmcp");
    insert(databasePath, "WARN", "hyper_util");
    insert(databasePath, "INFO", "codex_core");

    expect(rows(databasePath)).toEqual([
      { level: "TRACE", target: "opentelemetry_sdk::trace" },
      { level: "TRACE", target: "custom::trace" },
      { level: "WARN", target: "hyper_util" },
      { level: "INFO", target: "codex_core" },
    ]);
    expect(triggers(databasePath).map(row => row.name)).toEqual(["opencodex_log_guard_compat_v1"]);
  });

  test("compat suppresses descendant targets, matching upstream Targets prefix semantics", async () => {
    // Upstream registers these with `Targets::with_target`, which matches the
    // target AND every module beneath it. Exact equality caught only the parent,
    // so the high-volume children that actually fill the database kept writing
    // while compat reported itself active.
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("compat", deps).ok).toBe(true);

    insert(databasePath, "TRACE", "hyper_util::client::legacy::pool");
    insert(databasePath, "TRACE", "codex_api::sse::responses");
    insert(databasePath, "TRACE", "rmcp::service");
    insert(databasePath, "TRACE", "codex_http_client::transport::wire");
    // A near-prefix must NOT match: the '::' boundary is what separates a child
    // module from an unrelated crate that merely starts with the same letters.
    insert(databasePath, "TRACE", "hyper_utilities");
    // Rust target paths are case-sensitive. SQLite LIKE is ASCII
    // case-insensitive, so a LIKE-based prefix would have suppressed this
    // unrelated target too; substr() keeps the comparison exact.
    insert(databasePath, "TRACE", "HYPER_UTIL::child");
    // opentelemetry_sdk stays exact upstream, so its children are preserved.
    insert(databasePath, "TRACE", "opentelemetry_sdk::trace");

    expect(rows(databasePath)).toEqual([
      { level: "TRACE", target: "hyper_utilities" },
      { level: "TRACE", target: "HYPER_UTIL::child" },
      { level: "TRACE", target: "opentelemetry_sdk::trace" },
    ]);
  });

  test("a Disable that lands during Repair is not silently undone", async () => {
    // Repair used to read the desired mode BEFORE acquiring the lock. A Disable
    // completing in that gap was reported successful and then reinstalled by the
    // stale Repair, so the caller saw 'off' and got 'compat'.
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("compat", deps).ok).toBe(true);
    expect(deps.desired()).toBe("compat");

    let interleaved = false;
    const repair = repairCodexLogGuardProtection({
      ...deps,
      readDesiredMode: () => {
        // Runs inside the lock now; the Disable below already committed.
        return deps.desired() as never;
      },
      withLock: (home, path, run) => {
        if (!interleaved) {
          interleaved = true;
          expect(unprotectCodexLogs(deps).ok).toBe(true);
          expect(deps.desired()).toBe("off");
        }
        return deps.withLock(home, path, run);
      },
    });

    expect(repair.ok).toBe(true);
    expect(deps.desired()).toBe("off");
    expect(triggers(databasePath)).toEqual([]);
  });
  test("quiet suppresses all TRACE while preserving DEBUG INFO WARN and ERROR", async () => {
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("quiet", deps).ok).toBe(true);

    for (const level of ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]) {
      insert(databasePath, level, "custom::target");
    }
    expect(rows(databasePath).map(row => row.level)).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
  });

  test("refuses unknown schemas without changing desired state or installing a trigger", async () => {
    const { codexHome, databasePath } = fixture();
    const db = new Database(databasePath);
    db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
    db.close();
    const deps = testDeps(codexHome);

    const result = protectCodexLogs("compat", deps);
    expect(result).toEqual({ ok: false, error: "unsupported_schema" });
    expect(deps.desired()).toBe("off");
    expect(triggers(databasePath)).toEqual([]);
  });

  test("fails closed when Codex is running or process enumeration is unknown", async () => {
    const running = fixture();
    const runningDeps = {
      ...testDeps(running.codexHome),
      processCheck: () => ({ state: "ok" as const, processes: [{ pid: 42, commandLine: "codex exec" }] }),
    };
    expect(protectCodexLogs("compat", runningDeps)).toEqual({ ok: false, error: "codex_running" });
    expect(triggers(running.databasePath)).toEqual([]);

    const unknown = fixture();
    const unknownDeps = {
      ...testDeps(unknown.codexHome),
      processCheck: () => ({ state: "unknown" as const, reason: "enumeration_failed" as const }),
    };
    expect(protectCodexLogs("compat", unknownDeps)).toEqual({ ok: false, error: "process_enumeration_failed" });
    expect(triggers(unknown.databasePath)).toEqual([]);
  });

  test("never overwrites a trigger-name collision", async () => {
    const { codexHome, databasePath } = fixture();
    const db = new Database(databasePath);
    db.exec(`
      CREATE TRIGGER opencodex_log_guard_compat_v1 BEFORE INSERT ON logs
      BEGIN SELECT 1; END;
    `);
    db.close();
    const before = triggers(databasePath);

    const result = protectCodexLogs("compat", testDeps(codexHome));
    expect(result).toEqual({ ok: false, error: "trigger_collision" });
    expect(triggers(databasePath)).toEqual(before);
  });

  test("reports drift after a Codex-style table rebuild drops the owned trigger", async () => {
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("compat", deps).ok).toBe(true);
    expect(getCodexLogGuardProtectionStatus(deps).protection.state).toBe("active");

    const db = new Database(databasePath);
    db.exec(`
      ALTER TABLE logs RENAME TO logs_old;
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
      DROP TABLE logs_old;
      CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
      CREATE INDEX idx_logs_thread_id ON logs(thread_id);
      CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
      CREATE INDEX idx_logs_process_uuid_threadless_ts
        ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
        WHERE thread_id IS NULL;
    `);
    db.close();

    const status = getCodexLogGuardProtectionStatus(deps);
    expect(status.protection).toEqual({ desiredMode: "compat", observedMode: "off", state: "drifted" });
  });

  test("unprotect removes only OpenCodex-owned triggers", async () => {
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("quiet", deps).ok).toBe(true);
    const db = new Database(databasePath);
    db.exec("CREATE TRIGGER user_trigger BEFORE INSERT ON logs BEGIN SELECT 1; END;");
    db.close();

    expect(unprotectCodexLogs(deps).ok).toBe(true);
    expect(deps.desired()).toBe("off");
    expect(triggers(databasePath).map(row => row.name)).toEqual(["user_trigger"]);
  });

  test("rolls back an installed trigger when persisting desired state fails", async () => {
    const { codexHome, databasePath } = fixture();
    const deps = {
      ...testDeps(codexHome),
      writeDesiredMode: (_mode: "off" | "compat" | "quiet") => { throw new Error("disk full"); },
    };

    expect(protectCodexLogs("compat", deps)).toEqual({ ok: false, error: "config_write_failed" });
    expect(triggers(databasePath)).toEqual([]);
  });
  test("Disable still works after the Codex schema moves out from under us", async () => {
    // Protect is correctly refused on an unrecognized schema, but gating Disable
    // the same way stranded an installed trigger: the user kept an active
    // OpenCodex trigger with no in-product way to remove it.
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);
    expect(protectCodexLogs("compat", deps).ok).toBe(true);
    expect(triggers(databasePath).map(row => row.name)).toEqual(["opencodex_log_guard_compat_v1"]);

    // Simulate a Codex upgrade adding a column, so the exact-schema check fails.
    const db = new Database(databasePath);
    db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
    db.close();

    // Installing into the unknown schema stays refused...
    expect(protectCodexLogs("quiet", deps)).toEqual({ ok: false, error: "unsupported_schema" });
    // ...but taking our own trigger back out is always available.
    expect(unprotectCodexLogs(deps).ok).toBe(true);
    expect(triggers(databasePath)).toEqual([]);
  });
  test("a schema change between inspection and the locked write is refused", () => {
    // TOCTOU: the lock serializes OpenCodex against itself, not against Codex or
    // another SQLite writer. The locked recheck used to compare column NAMES
    // only - strictly weaker than the inspector's contract - so a migration
    // landing in that window let Protect install a row-dropping trigger on a
    // database the inspector classifies as monitor-only.
    const { codexHome, databasePath } = fixture();
    const deps = testDeps(codexHome);

    // Drop a canonical index the inspector requires but a column-name check
    // cannot see.
    const db = new Database(databasePath);
    db.exec("DROP INDEX idx_logs_ts");
    db.close();

    expect(protectCodexLogs("quiet", deps)).toEqual({ ok: false, error: "unsupported_schema" });
    expect(triggers(databasePath)).toEqual([]);
  });
});
