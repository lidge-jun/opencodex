import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { restoreLegacyOpenaiHistory, syncCodexHistoryProvider } from "../src/codex-history-provider";

/** Read the LAST session_meta payload, mirroring the app's last-writer-wins fold over rollout lines. */
function latestSessionMetaPayload(path: string): Record<string, unknown> {
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("\"session_meta\"")) continue;
    const rec = JSON.parse(line);
    if (rec?.type === "session_meta" && rec.payload) return rec.payload;
  }
  throw new Error(`no session_meta line in ${path}`);
}

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
  test("maps resumable Codex threads to opencodex via the latest session_meta", () => {
    const { dbPath, backupPath, rollout } = makeFixture();

    const result = syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "opencodex" });
    expect(db.query("SELECT has_user_event FROM threads WHERE id = 'thread-1'").get()).toEqual({ has_user_event: 1 });
    db.close();
    expect(latestSessionMetaPayload(rollout).model_provider).toBe("opencodex");
  });

  test("appends a new session_meta instead of rewriting line 1, preserving inode and prior content", () => {
    const { dbPath, backupPath, rollout } = makeFixture();
    const inodeBefore = statSync(rollout).ino;
    const before = readFileSync(rollout, "utf8");
    const beforeLineCount = before.split("\n").filter(Boolean).length;

    const result = syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    // No temp+rename: the app caches the live append handle, so the inode must survive.
    expect(statSync(rollout).ino).toBe(inodeBefore);
    const after = readFileSync(rollout, "utf8");
    // Original bytes are a strict prefix: we only ever append, never rewrite or truncate.
    expect(after.startsWith(before)).toBe(true);
    // Exactly one new session_meta line was appended, and it carries the new provider.
    expect(after.split("\n").filter(Boolean).length).toBe(beforeLineCount + 1);
    expect(latestSessionMetaPayload(rollout).model_provider).toBe("opencodex");
    // The original first line is untouched.
    expect(JSON.parse(before.split("\n")[0])).toEqual(JSON.parse(after.split("\n")[0]));
  });

  test("does not append when the latest session_meta belongs to a different thread id", () => {
    const { dbPath, backupPath, rollout } = makeFixture();
    // Simulate a forked rollout whose trailing session_meta embeds a *different* thread's id.
    appendFileSync(rollout, JSON.stringify({
      type: "session_meta",
      timestamp: "2026-01-02T00:00:00.000Z",
      payload: { id: "some-other-forked-thread", model_provider: "openai", cwd: "/tmp" },
    }) + "\n");
    const before = readFileSync(rollout, "utf8");

    const result = syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    // DB row still flips, but the rollout is left untouched (no misleading append for a foreign id).
    expect(result.files).toBe(0);
    expect(readFileSync(rollout, "utf8")).toBe(before);
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "opencodex" });
    db.close();
  });

  test("rewrites line 1 in place (length-preserving) when reverting an opencodex-origin rollout, so a later first-line clone cannot resurrect opencodex", () => {
    const { dbPath, backupPath, legacyRollout } = makeFixture({ includeLegacy: true });
    // thread-3 / legacyRollout is an opencodex-origin row with no backup -> eject path (revert to openai).
    const firstLineBefore = readFileSync(legacyRollout, "utf8").split("\n")[0];
    const inodeBefore = statSync(legacyRollout).ino;

    const result = syncCodexHistoryProvider("openai", dbPath, backupPath);
    expect(result.ejectedRows).toBe(1);

    const afterRestore = readFileSync(legacyRollout, "utf8");
    const firstLineAfter = afterRestore.split("\n")[0];
    // Line 1 now says openai, byte length preserved, inode unchanged (no truncate / no rename).
    expect(JSON.parse(firstLineAfter).payload.model_provider).toBe("openai");
    expect(Buffer.byteLength(firstLineAfter)).toBe(Buffer.byteLength(firstLineBefore));
    expect(statSync(legacyRollout).ino).toBe(inodeBefore);

    // Simulate the Codex app cloning line 1 and re-appending it (git/memory-mode update path).
    const cloned = JSON.parse(firstLineAfter);
    cloned.timestamp = "2026-02-01T00:00:00.000Z";
    cloned.payload.git = { branch: "main" };
    appendFileSync(legacyRollout, JSON.stringify(cloned) + "\n");

    expect(latestSessionMetaPayload(legacyRollout).model_provider).toBe("openai");
  });

  test("patches line 1 even when the first session_meta line is larger than the read chunk (big base_instructions)", () => {
    const dir = join(tmpdir(), `ocx-bighead-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const rollout = join(dir, "rollout.jsonl");
    const big = "x".repeat(200_000); // > 64KiB read chunk, forces the probe to grow
    writeFileSync(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "big-1", model_provider: "opencodex", source: "cli", cwd: dir, base_instructions: big } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00.000Z", payload: { message: "live turn keep me" } }),
    ].join("\n") + "\n");
    const dbPath = join(dir, "state_5.sqlite");
    const backupPath = join(dir, "bk.json");
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0)`);
    db.run(`INSERT INTO threads VALUES ('big-1', ?, 'opencodex', 'cli', 'hi', 1)`, rollout);
    db.close();
    const firstLineBefore = readFileSync(rollout, "utf8").split("\n")[0];

    syncCodexHistoryProvider("openai", dbPath, backupPath);

    const firstLineAfter = readFileSync(rollout, "utf8").split("\n")[0];
    expect(JSON.parse(firstLineAfter).payload.model_provider).toBe("openai");
    expect(Buffer.byteLength(firstLineAfter)).toBe(Buffer.byteLength(firstLineBefore));
    expect(readFileSync(rollout, "utf8").includes("live turn keep me")).toBe(true);
  });

  test("maps resumable Codex threads back to openai", () => {
    const { dbPath, backupPath, rollout } = makeFixture();
    syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    const result = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(result).toEqual({ rows: 1, files: 1 });
    const db = new Database(dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
    expect(latestSessionMetaPayload(rollout).model_provider).toBe("openai");
    expect(existsSync(backupPath)).toBe(false);
  });

  test("does not consume a history backup written for a different Codex state DB", () => {
    const first = makeFixture();
    const second = makeFixture();
    syncCodexHistoryProvider("opencodex", first.dbPath, first.backupPath);

    const result = syncCodexHistoryProvider("openai", second.dbPath, first.backupPath);

    expect(result).toEqual({ rows: 0, files: 0 });
    expect(existsSync(first.backupPath)).toBe(true);
    const db = new Database(second.dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
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
    expect(latestSessionMetaPayload(execRollout).source).toBe("cli");

    const restore = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(restore).toEqual({ rows: 2, files: 2 });
    db = new Database(dbPath);
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-2'").get()).toEqual({
      model_provider: "openai",
      source: "cli",
      has_user_event: 1,
    });
    db.close();
    expect(latestSessionMetaPayload(execRollout).model_provider).toBe("openai");
    expect(latestSessionMetaPayload(execRollout).source).toBe("cli");
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
    expect(latestSessionMetaPayload(execRollout).model_provider).toBe("openai");
    expect(latestSessionMetaPayload(execRollout).source).toBe("cli");
    expect(latestSessionMetaPayload(legacyRollout).model_provider).toBe("openai");
  });
});
