import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { classifyRecoverableHistoryError, countPendingOpencodexHistory, historyBackupPathFor, isRecoverableHistoryError, migrateHistoryToOpenai, restoreLegacyOpenaiHistory, setAfterNoopPendingCountForTests, setAfterStrictHistoryRolloutAppendForTests, setBeforeHistoryApplyTransactionForTests, setBeforeHistoryBackupConsumeForTests, setBeforeStrictHistoryRolloutAppendForTests, setHistoryDbBusyTimeoutForTests, snapshotCodexHistoryNoop, syncCodexHistoryProvider, withHistoryRetry } from "../src/codex/history-provider";
import { INVALID_HISTORY_BACKUP_FIXTURES, validHistoryBackupFixture } from "./helpers/codex-history-manifest-fixtures";

// Windows CI: a transient file lock can consume the full production 5s busy timeout, tripping
// bun's 5s default per-test timeout by itself. Fail fast into withHistoryRetry instead.
setHistoryDbBusyTimeoutForTests(250);
// Windows CI runners also have slow filesystems: legitimate sqlite open/fsync cycles in this
// file measure 5-7s there (vs <100ms locally), straddling bun's 5s default. Explicit headroom.
setDefaultTimeout(30_000);

const noopSnapshotArtifacts = new Set<string>();
afterEach(() => {
  setBeforeHistoryBackupConsumeForTests(undefined);
  setBeforeStrictHistoryRolloutAppendForTests(undefined);
  setAfterStrictHistoryRolloutAppendForTests(undefined);
  setBeforeHistoryApplyTransactionForTests(undefined);
  for (const path of noopSnapshotArtifacts) rmSync(path, { recursive: true, force: true });
  noopSnapshotArtifacts.clear();
});

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
      first_user_message TEXT,
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

  test("routes and exactly restores a resumable row with a null first-user message", () => {
    const fixture = makeFixture();
    const db = new Database(fixture.dbPath);
    db.run("UPDATE threads SET first_user_message = NULL, has_user_event = 0 WHERE id = 'thread-1'");
    db.close();

    expect(syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath))
      .toEqual({ rows: 1, files: 1 });
    const routed = new Database(fixture.dbPath, { readonly: true });
    expect(routed.query("SELECT model_provider, first_user_message, has_user_event FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "opencodex", first_user_message: null, has_user_event: 0 });
    routed.close();

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toEqual({ rows: 1, files: 1 });
    const restored = new Database(fixture.dbPath, { readonly: true });
    expect(restored.query("SELECT model_provider, source, first_user_message, has_user_event FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "openai", source: "vscode", first_user_message: null, has_user_event: 0 });
    restored.close();
    expect(existsSync(fixture.backupPath)).toBe(false);
  });

  test("does not route a new database row that was not captured in the manifest snapshot", () => {
    const fixture = makeFixture();
    const lateRollout = join(fixture.rollout, "..", "late-rollout.jsonl");
    writeFileSync(lateRollout, JSON.stringify({
      type: "session_meta",
      payload: { id: "thread-late", model_provider: "openai", source: "cli" },
    }) + "\n");
    setBeforeHistoryApplyTransactionForTests(() => {
      const late = new Database(fixture.dbPath);
      late.run("INSERT INTO threads VALUES ('thread-late', ?, 'openai', 'cli', 'late', 1)", lateRollout);
      late.close();
    });

    expect(syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath))
      .toEqual({ rows: 1, files: 1 });
    const manifest = JSON.parse(readFileSync(fixture.backupPath, "utf8"));
    expect(Object.keys(manifest.entries)).toEqual(["thread-1"]);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-late'").get())
      .toEqual({ model_provider: "openai" });
    db.close();
    expect(latestSessionMetaPayload(lateRollout).model_provider).toBe("openai");

    setBeforeHistoryApplyTransactionForTests(undefined);
    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toEqual({ rows: 1, files: 1 });
    const restored = new Database(fixture.dbPath, { readonly: true });
    expect(restored.query("SELECT model_provider FROM threads WHERE id = 'thread-late'").get())
      .toEqual({ model_provider: "openai" });
    restored.close();
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
    const { dbPath, legacyRollout } = makeFixture({ includeLegacy: true });
    // Only the explicit legacy recovery command may force a bare routed row to OpenAI.
    const firstLineBefore = readFileSync(legacyRollout, "utf8").split("\n")[0];
    const inodeBefore = statSync(legacyRollout).ino;

    const result = restoreLegacyOpenaiHistory(dbPath);
    expect(result.rows).toBe(1);

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
    const db = new Database(dbPath);
    db.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, model_provider TEXT NOT NULL, source TEXT NOT NULL, first_user_message TEXT NOT NULL, has_user_event INTEGER NOT NULL DEFAULT 0)`);
    db.run(`INSERT INTO threads VALUES ('big-1', ?, 'opencodex', 'cli', 'hi', 1)`, rollout);
    db.close();
    const firstLineBefore = readFileSync(rollout, "utf8").split("\n")[0];

    restoreLegacyOpenaiHistory(dbPath);

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
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-1'").get()).toEqual({
      model_provider: "openai",
      source: "vscode",
      has_user_event: 0,
    });
    db.close();
    expect(latestSessionMetaPayload(rollout).model_provider).toBe("openai");
    expect(existsSync(backupPath)).toBe(false);
  });

  test("does not consume a history backup written for a different Codex state DB", () => {
    const first = makeFixture();
    const second = makeFixture();
    syncCodexHistoryProvider("opencodex", first.dbPath, first.backupPath);

    const manifestBefore = readFileSync(first.backupPath);
    expect(syncCodexHistoryProvider("openai", second.dbPath, first.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });

    expect(existsSync(first.backupPath)).toBe(true);
    expect(readFileSync(first.backupPath).equals(manifestBefore)).toBe(true);
    const db = new Database(second.dbPath);
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
  });

  test("promotes opencodex exec threads to app-visible cli source and restores their exact routed provenance", () => {
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
      model_provider: "opencodex",
      source: "exec",
      has_user_event: 0,
    });
    db.close();
    expect(latestSessionMetaPayload(execRollout).model_provider).toBe("opencodex");
    expect(latestSessionMetaPayload(execRollout).source).toBe("exec");
    expect(existsSync(backupPath)).toBe(false);
    expect(countPendingOpencodexHistory(dbPath, backupPath)).toEqual({ pendingRows: 0, backupEntries: 0 });
  });

  test("leaves no-backup routed-provider history byte-identical during native restore", () => {
    const { dbPath, backupPath, legacyRollout } = makeFixture({ includeLegacy: true });
    const databaseBefore = readFileSync(dbPath);
    const rolloutBefore = readFileSync(legacyRollout);

    const result = syncCodexHistoryProvider("openai", dbPath, backupPath);

    expect(result).toEqual({ rows: 0, files: 0 });
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT model_provider, source FROM threads WHERE id = 'thread-3'").get()).toEqual({
      model_provider: "opencodex",
      source: "cli",
    });
    db.close();
    expect(readFileSync(dbPath).equals(databaseBefore)).toBe(true);
    expect(readFileSync(legacyRollout).equals(rolloutBefore)).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
  });

  test("uses preserved JSON padding to restore a first-line provider after an older forced relabel", () => {
    const { dbPath, backupPath, legacyRollout } = makeFixture({ includeLegacy: true });
    restoreLegacyOpenaiHistory(dbPath);

    // Simulate a surviving manifest from an interrupted old restore. Its trailing metadata was
    // already repaired, but line 1 still carries the shortened OpenAI provider plus padding.
    appendFileSync(legacyRollout, JSON.stringify({
      type: "session_meta",
      timestamp: "2026-02-02T00:00:00.000Z",
      payload: { id: "thread-3", model_provider: "opencodex", source: "exec" },
    }) + "\n");
    writeFileSync(backupPath, JSON.stringify({
      version: 1,
      stateDbPath: dbPath,
      entries: {
        "thread-3": {
          id: "thread-3",
          rolloutPath: legacyRollout,
          modelProvider: "opencodex",
          source: "exec",
          hasUserEvent: 1,
        },
      },
    }));

    expect(syncCodexHistoryProvider("openai", dbPath, backupPath)).toEqual({ rows: 1, files: 1 });
    const first = JSON.parse(readFileSync(legacyRollout, "utf8").split("\n")[0]);
    expect(first.payload.model_provider).toBe("opencodex");
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT model_provider, source FROM threads WHERE id = 'thread-3'").get())
      .toEqual({ model_provider: "opencodex", source: "exec" });
    db.close();
    expect(existsSync(backupPath)).toBe(false);
  });

  test("fails closed before mutation for malformed or mismatched backup provenance", () => {
    const malformed = makeFixture({ includeLegacy: true });
    const malformedDbBefore = readFileSync(malformed.dbPath);
    const malformedRolloutBefore = readFileSync(malformed.legacyRollout);
    writeFileSync(malformed.backupPath, JSON.stringify({
      version: 1,
      stateDbPath: malformed.dbPath,
      entries: {
        "thread-3": {
          id: "thread-3",
          rolloutPath: malformed.legacyRollout,
          modelProvider: "opencodex",
          hasUserEvent: 1,
        },
      },
    }));
    const malformedManifestBefore = readFileSync(malformed.backupPath);

    expect(syncCodexHistoryProvider("openai", malformed.dbPath, malformed.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    expect(readFileSync(malformed.dbPath).equals(malformedDbBefore)).toBe(true);
    expect(readFileSync(malformed.legacyRollout).equals(malformedRolloutBefore)).toBe(true);
    expect(readFileSync(malformed.backupPath).equals(malformedManifestBefore)).toBe(true);

    const mismatched = makeFixture({ includeLegacy: true });
    writeFileSync(mismatched.backupPath, JSON.stringify({
      version: 1,
      stateDbPath: mismatched.dbPath,
      entries: {
        "thread-3": {
          id: "thread-3",
          rolloutPath: mismatched.rollout,
          modelProvider: "opencodex",
          source: "cli",
          hasUserEvent: 1,
        },
      },
    }));
    const mismatchedDbBefore = readFileSync(mismatched.dbPath);
    const mismatchedRolloutBefore = readFileSync(mismatched.rollout);
    const mismatchedManifestBefore = readFileSync(mismatched.backupPath);
    expect(syncCodexHistoryProvider("openai", mismatched.dbPath, mismatched.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    expect(readFileSync(mismatched.dbPath).equals(mismatchedDbBefore)).toBe(true);
    expect(readFileSync(mismatched.rollout).equals(mismatchedRolloutBefore)).toBe(true);
    expect(readFileSync(mismatched.backupPath).equals(mismatchedManifestBefore)).toBe(true);

    const forward = makeFixture();
    writeFileSync(forward.backupPath, "{not-json");
    const forwardDbBefore = readFileSync(forward.dbPath);
    const forwardRolloutBefore = readFileSync(forward.rollout);
    const forwardManifestBefore = readFileSync(forward.backupPath);
    expect(syncCodexHistoryProvider("opencodex", forward.dbPath, forward.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    expect(readFileSync(forward.dbPath).equals(forwardDbBefore)).toBe(true);
    expect(readFileSync(forward.rollout).equals(forwardRolloutBefore)).toBe(true);
    expect(readFileSync(forward.backupPath).equals(forwardManifestBefore)).toBe(true);

    const missingRollout = makeFixture({ includeLegacy: true });
    rmSync(missingRollout.legacyRollout);
    writeFileSync(missingRollout.backupPath, JSON.stringify({
      version: 1,
      stateDbPath: missingRollout.dbPath,
      entries: {
        "thread-3": {
          id: "thread-3",
          rolloutPath: missingRollout.legacyRollout,
          modelProvider: "opencodex",
          source: "exec",
          hasUserEvent: 1,
        },
      },
    }));
    const missingDbBefore = readFileSync(missingRollout.dbPath);
    const missingManifestBefore = readFileSync(missingRollout.backupPath);
    expect(syncCodexHistoryProvider("openai", missingRollout.dbPath, missingRollout.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    expect(readFileSync(missingRollout.dbPath).equals(missingDbBefore)).toBe(true);
    expect(readFileSync(missingRollout.backupPath).equals(missingManifestBefore)).toBe(true);
  });

  test("refuses a manifest whose current row is neither its OpenCodex post-image nor its target", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    const changed = new Database(fixture.dbPath);
    changed.run("UPDATE threads SET model_provider = 'other' WHERE id = 'thread-1'");
    changed.close();
    const databaseBefore = readFileSync(fixture.dbPath);
    const rolloutBefore = readFileSync(fixture.rollout);
    const manifestBefore = readFileSync(fixture.backupPath);

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    expect(readFileSync(fixture.dbPath).equals(databaseBefore)).toBe(true);
    expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
    expect(readFileSync(fixture.backupPath).equals(manifestBefore)).toBe(true);
  });

  test("preserves a newer same-id rollout provider decision instead of overwriting it", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    appendFileSync(fixture.rollout, JSON.stringify({
      type: "session_meta",
      timestamp: "2026-03-01T00:00:00.000Z",
      payload: { id: "thread-1", model_provider: "custom", source: "vscode" },
    }) + "\n");
    const databaseBefore = readFileSync(fixture.dbPath);
    const rolloutBefore = readFileSync(fixture.rollout);
    const manifestBefore = readFileSync(fixture.backupPath);

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 0, files: 0, failed: true, failureReason: "integrity" });
    expect(readFileSync(fixture.dbPath).equals(databaseBefore)).toBe(true);
    expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
    expect(readFileSync(fixture.backupPath).equals(manifestBefore)).toBe(true);
    expect(latestSessionMetaPayload(fixture.rollout).model_provider).toBe("custom");
  });

  test("compensates a same-id provider append that races strict restore's own append", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    appendFileSync(fixture.rollout, JSON.stringify({
      type: "event_msg",
      timestamp: "2026-02-28T00:00:00.000Z",
      payload: { type: "user_message", message: "비ASCII 경합 기준 🧪" },
    }) + "\n");
    setBeforeStrictHistoryRolloutAppendForTests(() => {
      appendFileSync(fixture.rollout, JSON.stringify({
        type: "session_meta",
        timestamp: "2026-03-01T00:00:00.000Z",
        payload: { id: "thread-1", model_provider: "custom", source: "vscode" },
      }) + "\n");
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 0, files: 1, failed: true, failureReason: "integrity" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    expect(latestSessionMetaPayload(fixture.rollout).model_provider).toBe("custom");
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "opencodex" });
    db.close();
  });

  test("reports ambiguous file progress when a strict append lands before a write fault", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setAfterStrictHistoryRolloutAppendForTests(() => {
      throw Object.assign(new Error("append finalization failed"), { code: "EPERM" });
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 0, files: 1, failed: true, failureReason: "integrity" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "opencodex" });
    db.close();
  });

  test("preflights every rollout before mutating the first entry of a multi-entry restore", () => {
    const fixture = makeFixture({ includeExec: true });
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    rmSync(fixture.execRollout);
    const databaseBefore = readFileSync(fixture.dbPath);
    const firstRolloutBefore = readFileSync(fixture.rollout);
    const manifestBefore = readFileSync(fixture.backupPath);

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 0, files: 0, failed: true, failureReason: "integrity" });
    expect(readFileSync(fixture.dbPath).equals(databaseBefore)).toBe(true);
    expect(readFileSync(fixture.rollout).equals(firstRolloutBefore)).toBe(true);
    expect(readFileSync(fixture.backupPath).equals(manifestBefore)).toBe(true);
  });

  test("keeps provenance when the conditional database restore loses its compare-and-swap", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    const guarded = new Database(fixture.dbPath);
    guarded.exec(`
      CREATE TRIGGER ignore_history_restore
      BEFORE UPDATE OF model_provider, source, has_user_event ON threads
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    guarded.close();
    const manifestBefore = readFileSync(fixture.backupPath);
    const rolloutBefore = readFileSync(fixture.rollout);

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ failed: true, failureReason: "integrity" });
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "opencodex" });
    db.close();
    expect(readFileSync(fixture.rollout).equals(rolloutBefore)).toBe(true);
    expect(readFileSync(fixture.backupPath).equals(manifestBefore)).toBe(true);
  });

  test("does not delete a manifest replaced after exact restore readback", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    const replacement = JSON.parse(readFileSync(fixture.backupPath, "utf8"));
    replacement.revision = "newer";
    setBeforeHistoryBackupConsumeForTests(() => {
      writeFileSync(fixture.backupPath, JSON.stringify(replacement));
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "integrity" });
    expect(JSON.parse(readFileSync(fixture.backupPath, "utf8")).revision).toBe("newer");
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "openai", source: "vscode", has_user_event: 0 });
    db.close();
  });

  test("keeps the manifest when the database target changes after restore readback", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setBeforeHistoryBackupConsumeForTests(() => {
      const changed = new Database(fixture.dbPath);
      changed.run("UPDATE threads SET model_provider = 'custom' WHERE id = 'thread-1'");
      changed.close();
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "integrity" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "custom" });
    db.close();
  });

  test("keeps the manifest when a newer same-id rollout provider lands after readback", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setBeforeHistoryBackupConsumeForTests(() => {
      appendFileSync(fixture.rollout, JSON.stringify({
        type: "session_meta",
        timestamp: "2026-03-02T00:00:00.000Z",
        payload: { id: "thread-1", model_provider: "custom", source: "vscode" },
      }) + "\n");
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "integrity" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    expect(latestSessionMetaPayload(fixture.rollout).model_provider).toBe("custom");
  });

  test("reports applied permission progress when manifest finalization is denied", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setBeforeHistoryBackupConsumeForTests(() => {
      throw Object.assign(new Error("finalization denied"), { code: "EPERM" });
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "permission" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    const db = new Database(fixture.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get())
      .toEqual({ model_provider: "openai" });
    db.close();
  });

  test("reports applied busy progress when manifest finalization cannot complete", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setBeforeHistoryBackupConsumeForTests(() => {
      throw Object.assign(new Error("finalization busy"), { code: "EBUSY" });
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "busy" });
    expect(existsSync(fixture.backupPath)).toBe(true);
  });

  test("reports applied integrity progress for an unclassified finalization failure", () => {
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    setBeforeHistoryBackupConsumeForTests(() => {
      throw new Error("finalization failed without a recoverable code");
    });

    expect(syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath))
      .toMatchObject({ rows: 1, files: 1, failed: true, failureReason: "integrity" });
    expect(existsSync(fixture.backupPath)).toBe(true);
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

describe("history lock retry", () => {
  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

  test("isRecoverableHistoryError recognizes lock/busy shapes and rejects hard errors", () => {
    expect(isRecoverableHistoryError(busy())).toBe(true);
    expect(isRecoverableHistoryError(Object.assign(new Error("x"), { code: "SQLITE_LOCKED" }))).toBe(true);
    expect(isRecoverableHistoryError(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe(true);
    expect(isRecoverableHistoryError(new Error("database is locked"))).toBe(true);
    expect(isRecoverableHistoryError(new Error("permission denied"))).toBe(true);
    expect(isRecoverableHistoryError(new Error("malformed database schema"))).toBe(false);
    expect(isRecoverableHistoryError(new TypeError("undefined is not a function"))).toBe(false);
  });

  test("classifies exhausted history failures for restore callers", () => {
    expect(classifyRecoverableHistoryError(Object.assign(new Error("x"), { code: "SQLITE_BUSY" }))).toBe("busy");
    expect(classifyRecoverableHistoryError(Object.assign(new Error("x"), { code: "EACCES" }))).toBe("permission");
    expect(classifyRecoverableHistoryError(new Error("malformed database schema"))).toBeNull();
  });

  test("withHistoryRetry succeeds after one recoverable failure, sleeping between attempts", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withHistoryRetry(() => {
      calls++;
      if (calls === 1) throw busy();
      return { rows: 3, files: 2 };
    }, { sleepFn: ms => sleeps.push(ms) });

    expect(result).toEqual({ rows: 3, files: 2 });
    expect(calls).toBe(2);
    expect(sleeps.length).toBe(1);
  });

  test("withHistoryRetry returns null when the lock never clears (callers surface failed:true)", () => {
    let calls = 0;
    const result = withHistoryRetry(() => {
      calls++;
      throw busy();
    }, { sleepFn: () => {} });

    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  test("syncCodexHistoryProvider reports why the retry budget died", () => {
    // Only manifest-backed work writes. Seed one real routed transition before holding SQLite.
    const fixture = makeFixture();
    syncCodexHistoryProvider("opencodex", fixture.dbPath, fixture.backupPath);
    const holder = new Database(fixture.dbPath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const result = syncCodexHistoryProvider("openai", fixture.dbPath, fixture.backupPath);
      expect(result.failed).toBe(true);
      expect(result.failureReason).toBe("busy");
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  test("withHistoryRetry rethrows hard errors immediately", () => {
    let calls = 0;
    expect(() =>
      withHistoryRetry(() => {
        calls++;
        throw new Error("malformed database schema");
      }, { sleepFn: () => {} }),
    ).toThrow("malformed database schema");
    expect(calls).toBe(1);
  });
});

describe("Design B migration helpers", () => {
  test("strict no-op snapshots distinguish absence from manifest uncertainty", () => {
    const dir = join(tmpdir(), `ocx-history-noop-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state_5.sqlite");
    const backupPath = historyBackupPathFor(dbPath);
    noopSnapshotArtifacts.add(backupPath);
    noopSnapshotArtifacts.add(dir);
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({
      kind: "unknown", reason: "database-absent",
      stateDbPresent: false, backupPresent: false,
    });
    writeFileSync(backupPath, JSON.stringify({ version: 1, stateDbPath: dbPath, entries: {} }));
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({
      kind: "unknown", reason: "database-absent", stateDbPresent: false, backupPresent: true,
    });
    writeFileSync(backupPath, "{not-json");
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({ kind: "unknown", reason: "manifest-read" });
    writeFileSync(backupPath, JSON.stringify({ version: 1, stateDbPath: join(dir, "other.sqlite"), entries: {} }));
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({ kind: "unknown", reason: "manifest-foreign" });
    writeFileSync(backupPath, JSON.stringify({ version: 1, entries: {} }));
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({ kind: "unknown", reason: "manifest-schema" });
    writeFileSync(backupPath, JSON.stringify({
      version: 1,
      stateDbPath: dbPath,
      entries: { "thread-1": { id: "wrong-id", rolloutPath: "r", modelProvider: "openai", source: "cli", hasUserEvent: 1 } },
    }));
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({ kind: "unknown", reason: "manifest-schema" });
    rmSync(backupPath, { force: true });
    mkdirSync(backupPath);
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({ kind: "unknown", reason: "manifest-read" });
  });

  test("strict no-op snapshots reject every invalid provenance shape", () => {
    const dir = join(tmpdir(), `ocx-history-noop-schema-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state_5.sqlite");
    const backupPath = historyBackupPathFor(dbPath);
    const rolloutPath = join(dir, "rollout.jsonl");
    noopSnapshotArtifacts.add(backupPath);
    noopSnapshotArtifacts.add(dir);
    for (const invalid of INVALID_HISTORY_BACKUP_FIXTURES) {
      const manifest = validHistoryBackupFixture(dbPath, rolloutPath);
      invalid.mutate(manifest);
      writeFileSync(backupPath, JSON.stringify(manifest));
      expect(snapshotCodexHistoryNoop(dbPath, backupPath), invalid.name)
        .toMatchObject({ kind: "unknown", reason: "manifest-schema" });
      expect(countPendingOpencodexHistory(dbPath, backupPath), invalid.name)
        .toEqual({ pendingRows: 0, backupEntries: 0, failed: true, failureReason: "integrity" });
    }
  });

  test("a missing database with a valid nonempty manifest remains pending", () => {
    const dir = join(tmpdir(), `ocx-history-noop-pending-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state_5.sqlite");
    const backupPath = historyBackupPathFor(dbPath);
    noopSnapshotArtifacts.add(backupPath);
    noopSnapshotArtifacts.add(dir);
    const rolloutPath = join(dir, "rollout.jsonl");
    writeFileSync(backupPath, JSON.stringify({
      version: 1,
      stateDbPath: dbPath,
      entries: {
        "thread-1": { id: "thread-1", rolloutPath, modelProvider: "openai", source: "cli", hasUserEvent: 1 },
      },
    }));
    expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({
      kind: "work-pending", pendingRows: 0, backupEntries: 1,
      stateDbPresent: false, backupPresent: true,
    });
  });

  test("a WAL commit after the pending count invalidates a no-op snapshot", () => {
    const dir = join(tmpdir(), `ocx-history-noop-wal-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state_5.sqlite");
    const backupPath = historyBackupPathFor(dbPath);
    noopSnapshotArtifacts.add(backupPath);
    noopSnapshotArtifacts.add(dir);
    const seed = new Database(dbPath);
    try {
      seed.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          model_provider TEXT,
          source TEXT,
          has_user_event INTEGER,
          first_user_message TEXT
        );
      `);
      seed.run(
        "INSERT INTO threads VALUES (?, ?, 'openai', 'cli', 1, 'seed')",
        ["openai-row", join(dir, "openai-rollout.jsonl")],
      );
    } finally {
      seed.close();
    }

    setAfterNoopPendingCountForTests(() => {
      const writer = new Database(dbPath);
      try {
        writer.exec("PRAGMA journal_mode = WAL");
        writer.run(
          "INSERT INTO threads VALUES (?, ?, 'opencodex', 'cli', 1, 'raced')",
          ["raced-opencodex-row", join(dir, "raced-rollout.jsonl")],
        );
      } finally {
        writer.close();
      }
    });

    try {
      expect(snapshotCodexHistoryNoop(dbPath, backupPath)).toMatchObject({
        kind: "unknown",
        reason: "snapshot-race",
        stateDbPresent: true,
        backupPresent: false,
      });
    } finally {
      setAfterNoopPendingCountForTests(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const busy = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

  test("withHistoryRetry honors a custom attempts budget", () => {
    let calls = 0;
    const result = withHistoryRetry(() => {
      calls++;
      if (calls < 4) throw busy();
      return "ok";
    }, { sleepFn: () => {}, attempts: 4 });

    expect(result).toBe("ok");
    expect(calls).toBe(4);
  });

  test("withHistoryRetry attempts:1 never sleeps and fails fast", () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withHistoryRetry(() => {
      calls++;
      throw busy();
    }, { sleepFn: ms => sleeps.push(ms), attempts: 1 });

    expect(result).toBeNull();
    expect(calls).toBe(1);
    expect(sleeps.length).toBe(0);
  });

  test("countPendingOpencodexHistory excludes unknown-provenance routed rows from automatic work", () => {
    const { dbPath, backupPath, execRollout, legacyRollout } = makeFixture({ includeExec: true, includeLegacy: true });
    const databaseBefore = readFileSync(dbPath);
    const execBefore = readFileSync(execRollout);
    const legacyBefore = readFileSync(legacyRollout);

    const before = countPendingOpencodexHistory(dbPath, backupPath);
    expect(before.failed).toBeUndefined();
    expect(before).toEqual({ pendingRows: 0, backupEntries: 0 });

    const migrated = migrateHistoryToOpenai(dbPath, backupPath);
    expect(migrated).toEqual({ rows: 0, files: 0 });
    expect(readFileSync(dbPath).equals(databaseBefore)).toBe(true);
    expect(readFileSync(execRollout).equals(execBefore)).toBe(true);
    expect(readFileSync(legacyRollout).equals(legacyBefore)).toBe(true);

    const after = countPendingOpencodexHistory(dbPath, backupPath);
    expect(after.pendingRows).toBe(0);
    expect(after.backupEntries).toBe(0);

    // Idempotent: a second migration is a no-op.
    const again = migrateHistoryToOpenai(dbPath, backupPath);
    expect(again.rows).toBe(0);
    expect(again.ejectedRows ?? 0).toBe(0);
  });

  test("countPendingOpencodexHistory classifies changed manifest targets as integrity failures", () => {
    const databaseFixture = makeFixture();
    syncCodexHistoryProvider("opencodex", databaseFixture.dbPath, databaseFixture.backupPath);
    const changed = new Database(databaseFixture.dbPath);
    changed.run("UPDATE threads SET model_provider = 'custom' WHERE id = 'thread-1'");
    changed.close();
    expect(countPendingOpencodexHistory(databaseFixture.dbPath, databaseFixture.backupPath))
      .toEqual({ pendingRows: 0, backupEntries: 1, failed: true, failureReason: "integrity" });

    const rolloutFixture = makeFixture();
    syncCodexHistoryProvider("opencodex", rolloutFixture.dbPath, rolloutFixture.backupPath);
    appendFileSync(rolloutFixture.rollout, JSON.stringify({
      type: "session_meta",
      timestamp: "2026-03-01T00:00:00.000Z",
      payload: { id: "thread-1", model_provider: "custom", source: "vscode" },
    }) + "\n");
    expect(countPendingOpencodexHistory(rolloutFixture.dbPath, rolloutFixture.backupPath))
      .toEqual({ pendingRows: 0, backupEntries: 1, failed: true, failureReason: "integrity" });
    expect(countPendingOpencodexHistory(
      rolloutFixture.dbPath,
      rolloutFixture.backupPath,
      { validateRestoreTargets: false },
    )).toEqual({ pendingRows: 0, backupEntries: 1 });
    const canonicalBackupPath = historyBackupPathFor(rolloutFixture.dbPath);
    noopSnapshotArtifacts.add(canonicalBackupPath);
    writeFileSync(canonicalBackupPath, readFileSync(rolloutFixture.backupPath));
    expect(snapshotCodexHistoryNoop(rolloutFixture.dbPath, canonicalBackupPath))
      .toMatchObject({ kind: "work-pending", pendingRows: 0, backupEntries: 1 });
    expect(syncCodexHistoryProvider("openai", rolloutFixture.dbPath, rolloutFixture.backupPath))
      .toMatchObject({ rows: 0, files: 0, failed: true, failureReason: "integrity" });
  });

  test("countPendingOpencodexHistory returns zeros for a missing DB", () => {
    const missing = join(tmpdir(), `ocx-none-${Date.now()}`, "state_5.sqlite");
    const result = countPendingOpencodexHistory(missing, join(tmpdir(), "no-backup.json"));
    expect(result).toEqual({ pendingRows: 0, backupEntries: 0 });
  });

  // Byte-identity covers the rollout and the main DB file; the no-write guarantee itself
  // lives in the code path (the gate returns before withHistoryRetry ever opens a writer).
  test("migrateHistoryToOpenai steady state leaves rollouts and the main DB file byte-identical", () => {
    const { dbPath, backupPath, rollout } = makeFixture(); // only an openai-tagged row, no backup
    const rolloutBefore = readFileSync(rollout, "utf8");
    const dbBefore = readFileSync(dbPath);

    const result = migrateHistoryToOpenai(dbPath, backupPath);

    expect(result).toEqual({ rows: 0, files: 0 });
    expect(readFileSync(rollout, "utf8")).toBe(rolloutBefore);
    expect(readFileSync(dbPath).equals(dbBefore)).toBe(true);
  });

  test("migrateHistoryToOpenai restores only manifest-backed pending metadata", () => {
    const { dbPath, backupPath } = makeFixture();
    syncCodexHistoryProvider("opencodex", dbPath, backupPath);

    const result = migrateHistoryToOpenai(dbPath, backupPath);

    expect(result.failed).toBeUndefined();
    expect(result.rows).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT model_provider, source, has_user_event FROM threads WHERE id = 'thread-1'").get()).toEqual({
      model_provider: "openai",
      source: "vscode",
      has_user_event: 0,
    });
    db.close();
  });

  test("a missing DB with a leftover backup manifest does not satisfy the steady-state gate", () => {
    const dir = join(tmpdir(), `ocx-reinstall-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const missingDb = join(dir, "state_5.sqlite");
    const backupPath = join(dir, "codex-history-backup.json");
    writeFileSync(backupPath, JSON.stringify({
      version: 1,
      stateDbPath: missingDb,
      entries: { "thread-1": { id: "thread-1", rolloutPath: join(dir, "r.jsonl"), modelProvider: "openai", source: "cli", hasUserEvent: 1 } },
    }));

    const pending = countPendingOpencodexHistory(missingDb, backupPath);
    expect(pending.backupEntries).toBe(1); // gate must see this and NOT report a provable no-op
    expect(pending).toMatchObject({ failed: true, failureReason: "integrity" });

    // Work cannot converge without its bound database; the manifest remains retry evidence.
    const result = migrateHistoryToOpenai(missingDb, backupPath);
    expect(result).toEqual({ rows: 0, files: 0, failed: true, failureReason: "integrity" });
    expect(existsSync(backupPath)).toBe(true);
  });

  test("syncCodexHistoryProvider openai with skipWhenProvablyNoop skips writes in steady state but still restores pending rows", () => {
    const steady = makeFixture();
    const steadyBefore = readFileSync(steady.rollout, "utf8");
    const skipped = syncCodexHistoryProvider("openai", steady.dbPath, steady.backupPath, { skipWhenProvablyNoop: true });
    expect(skipped).toEqual({ rows: 0, files: 0 });
    expect(readFileSync(steady.rollout, "utf8")).toBe(steadyBefore);

    const pending = makeFixture();
    syncCodexHistoryProvider("opencodex", pending.dbPath, pending.backupPath);
    const restored = syncCodexHistoryProvider("openai", pending.dbPath, pending.backupPath, { skipWhenProvablyNoop: true });
    expect(restored.rows).toBe(1);
    const db = new Database(pending.dbPath, { readonly: true });
    expect(db.query("SELECT model_provider FROM threads WHERE id = 'thread-1'").get()).toEqual({ model_provider: "openai" });
    db.close();
  });
});
