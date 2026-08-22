import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

function makeLogsDb(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
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
    INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes)
      VALUES (1, 0, 'TRACE', 'codex_api::sse', 'PRIVATE API BODY', 100);
  `);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
}

function config(): OcxConfig {
  return { port: 0, defaultProvider: "openai", providers: {} } as OcxConfig;
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard management API", () => {
  test("GET /api/storage/codex-logs returns privacy-safe read-only diagnostics", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-api-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const sqliteHome = join(root, "sqlite-home");
    mkdirSync(codexHome);
    mkdirSync(sqliteHome);
    writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
    makeLogsDb(join(sqliteHome, "logs_2.sqlite"));
    process.env.CODEX_HOME = codexHome;

    const req = new ManagementRequest("http://localhost/api/storage/codex-logs", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config(), { refreshCodexCatalog: async () => {} });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.externalSqliteHome).toBe(true);
    expect(body).not.toHaveProperty("sqliteHome");
    expect(body).not.toHaveProperty("databasePath");
    expect(body).not.toHaveProperty("codexHome");
    expect(JSON.stringify(body)).not.toContain(sqliteHome);
    expect(JSON.stringify(body)).not.toContain(codexHome);
    expect(JSON.stringify(body)).not.toContain("PRIVATE API BODY");
  });

  test("GET /api/storage carries path-safe diagnostics without folding external SQLite into CODEX_HOME totals", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-storage-"));
    roots.push(root);
    const codexHome = join(root, "codex-home");
    const sqliteHome = join(root, "sqlite-home");
    mkdirSync(codexHome);
    mkdirSync(sqliteHome);
    writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
    makeLogsDb(join(sqliteHome, "logs_2.sqlite"));
    process.env.CODEX_HOME = codexHome;

    const req = new ManagementRequest("http://localhost/api/storage", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config(), { refreshCodexCatalog: async () => {} });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const body = await response!.json() as {
      total: { bytes: number };
      codexLogs?: {
        externalSqliteHome: boolean;
        files: { databaseBytes: number };
      };
    };
    expect(body.codexLogs?.externalSqliteHome).toBe(true);
    expect(body.codexLogs!.files.databaseBytes).toBeGreaterThan(body.total.bytes);
    expect(body.codexLogs).not.toHaveProperty("sqliteHome");
    expect(body.codexLogs).not.toHaveProperty("databasePath");
    expect(body.codexLogs).not.toHaveProperty("codexHome");
    expect(JSON.stringify(body.codexLogs)).not.toContain(sqliteHome);
    expect(JSON.stringify(body.codexLogs)).not.toContain(codexHome);
    expect(JSON.stringify(body.codexLogs)).not.toContain("PRIVATE API BODY");
  });

  test("inspection failures return a stable message without leaking the config path", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-api-error-"));
    roots.push(root);
    const codexHome = join(root, "private-codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "sqlite_home = 42\n");
    process.env.CODEX_HOME = codexHome;

    const req = new ManagementRequest("http://localhost/api/storage/codex-logs", { method: "GET" });
    const response = await handleManagementAPI(req, new URL(req.url), config(), { refreshCodexCatalog: async () => {} });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(500);
    expect(await response!.json()).toEqual({
      error: "inspect_failed",
      message: "Codex log inspection failed",
    });
  });
});
