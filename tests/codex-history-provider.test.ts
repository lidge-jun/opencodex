import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { restoreLegacyOpenaiHistory, syncCodexHistoryProvider } from "../src/codex-history-provider";

function makeFixture({ includeExec = false, includeLegacy = false } = {}) {
  const dir = join(tmpdir(), `ocx-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const rollout = join(dir, "rollout.jsonl");
  writeFileSync(rollout, [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-1", model_provider: "openai", cwd: dir },
    }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { message: "x" } }),
  ].join("\n") + "\n");
  const execRollout = join(dir, "exec-rollout.jsonl");
  writeFileSync(execRollout, [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-2", model_provider: "opencodex", source: "exec", cwd: dir },
    }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { message: "y" } }),
  ].join("\n") + "\n");
  const legacyRollout = join(dir, "legacy-rollout.jsonl");
  writeFileSync(legacyRollout, [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-3", model_provider: "opencodex", source: "cli", cwd: dir },
    }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { message: "z" } }),
  ].join("\n") + "\n");
  const mtime = new Date("2026-01-02T03:04:05.000Z");
  utimesSync(rollout, mtime, mtime);
  utimesSync(execRollout, mtime, mtime);
  utimesSync(legacyRollout, mtime, mtime);

  const dbPath = join(dir, "state_5.sqlite");
  const backupPath = join(dir, "codex-history-backup.json");
  const db = new Database(dbPath);
  db.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    INSERT INTO threads (id, rollout_path, model_provider, source, first_user_message, has_user_event)
    VALUES ('thread-1', ?, 'openai', 'vscode', 'hello', 0)
  `, rollout);
  if (includeExec) {
    db.run(`
      INSERT INTO threads (id, rollout_path, model_provider, source, first_user_message, has_user_event)
      VALUES ('thread-2', ?, 'opencodex', 'exec', 'hello from exec', 0)
    `, execRollout);
  }
  if (includeLegacy) {
    db.run(`
      INSERT INTO threads (id, rollout_path, model_provider, source, first_user_message, has_user_event)
      VALUES ('thread-3', ?, 'opencodex', 'cli', 'legacy remapped row', 1)
    `, legacyRollout);
  }
  db.close();
  return { dbPath, backupPath, rollout, execRollout, legacyRollout, mtime };
}

describe("Codex history provider sync", () => {
  test("maps resumable Codex threads to opencodex without touching file mtime", () => {
    const { dbPath, backupPath, rollout, mtime } = makeFixture();

    const result = syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "opencodex" });
    expect(db.query("SELECT has_user_event FROM threads WHERE id = 'thread-1'").get()).toEqual({ has_user_event: 1 });
    db.close();
    const firstLine = readFileSync(rollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("opencodex");
    expect(statSync(rollout).mtime.getTime()).toBe(mtime.getTime());
  });

  test("maps resumable Codex threads back to openai", () => {
    const { dbPath, backupPath, rollout } = makeFixture();
    syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    const result = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
    const firstLine = readFileSync(rollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
    expect(existsSync(backupPath)).toBe(false);
  });

  test("promotes opencodex exec threads to app-visible cli source and restores from backup", () => {
    const { dbPath, backupPath, execRollout } = makeFixture({ includeExec: true });

    const result = syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    expect(result).toEqual({ rows: 2, files: 2 });
    let db = new Database(dbPath);
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-2'").get()).toEqual({
      model_provider: "opencodex",
      source: "cli",
      has_user_event: 1,
    });
    db.close();
    let firstLine = readFileSync(execRollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.source).toBe("cli");

    const restore = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(restore).toEqual({ rows: 2, files: 2 });
    db = new Database(dbPath);
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-2'").get()).toEqual({
      model_provider: "openai",
      source: "cli",
      has_user_event: 1,
    });
    db.close();
    firstLine = readFileSync(execRollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
    expect(JSON.parse(firstLine).payload.source).toBe("cli");
    expect(existsSync(backupPath)).toBe(false);
  });

  test("ejects no-backup opencodex interactive rows to openai during native restore", () => {
    const { dbPath, backupPath } = makeFixture({ includeLegacy: true });

    const result = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(result).toEqual({ rows: 0, files: 1, ejectedRows: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider, source FROM threads WHERE id = 'thread-3'").get()).toEqual({
      model_provider: "openai",
      source: "cli",
    });
    db.close();
    expect(existsSync(backupPath)).toBe(false);
  });

  test("explicitly recovers legacy opencodex user rows to openai", () => {
    const { dbPath, execRollout, legacyRollout } = makeFixture({ includeExec: true, includeLegacy: true });

    const result = restoreLegacyOpenaiHistory(dbPath);

    expect(result).toEqual({ rows: 2, files: 2 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider, source FROM threads WHERE id = 'thread-3'").get()).toEqual({
      model_provider: "openai",
      source: "cli",
    });
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-2'").get()).toEqual({
      model_provider: "openai",
      source: "cli",
      has_user_event: 1,
    });
    db.close();
    let firstLine = readFileSync(execRollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
    expect(JSON.parse(firstLine).payload.source).toBe("cli");

    firstLine = readFileSync(legacyRollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLine).payload.model_provider).toBe("openai");
  });
});
