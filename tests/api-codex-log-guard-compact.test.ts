import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexLogGuardMaintenanceDeps } from "../src/codex/log-guard/maintenance";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

function createLogsDb(path: string): void {
  const db = new Database(path);
  db.exec(`
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA journal_mode=WAL;
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
    CREATE TABLE reclaim_fixture (id INTEGER PRIMARY KEY, body BLOB NOT NULL);
  `);
  const insert = db.query("INSERT INTO reclaim_fixture (id, body) VALUES (?, zeroblob(8192))");
  for (let i = 0; i < 120; i += 1) insert.run(i + 1);
  db.exec("DELETE FROM reclaim_fixture WHERE id <= 100; PRAGMA wal_checkpoint(FULL)");
  db.close();
}

function fixture(): { deps: CodexLogGuardMaintenanceDeps } {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-api-compact-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  createLogsDb(join(codexHome, "logs_2.sqlite"));
  process.env.CODEX_HOME = codexHome;
  return {
    deps: {
      codexHome,
      processCheck: () => ({ state: "ok", processes: [] }),
      withLock: <T>(_home: string, _database: string, work: () => T) => ({ kind: "completed", value: work() }),
    },
  };
}

function config(): OcxConfig {
  return { port: 0, defaultProvider: "openai", providers: {} } as OcxConfig;
}

async function request(path: string, deps: CodexLogGuardMaintenanceDeps): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, { method: "POST" });
  const response = await handleManagementAPI(
    req,
    new URL(req.url),
    config(),
    { codexLogGuardMaintenanceDeps: deps },
  );
  expect(response).not.toBeNull();
  return response!;
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard compact management API", () => {
  test("POST compact returns path-private before/after maintenance metrics", async () => {
    const { deps } = fixture();
    const response = await request("/api/storage/codex-logs/compact", deps);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.report.before.freelistPages).toBeGreaterThan(0);
    expect(body.report.after.freelistPages).toBeLessThan(body.report.before.freelistPages);
    expect(body.report.pagesReclaimed).toBeGreaterThan(0);
    expect(body.report.integrity).toEqual({ before: "ok", after: "ok" });
    expect(body.report).not.toHaveProperty("databasePath");
    expect(JSON.stringify(body)).not.toContain(deps.codexHome!);
  });

  test("GET compact is not a mutation alias", async () => {
    const { deps } = fixture();
    const req = new ManagementRequest("http://localhost/api/storage/codex-logs/compact", { method: "GET" });
    const response = await handleManagementAPI(
      req,
      new URL(req.url),
      config(),
      { codexLogGuardMaintenanceDeps: deps },
    );
    expect(response).toBeNull();
  });

  test("integrity refusal is surfaced without pretending maintenance succeeded", async () => {
    const { deps } = fixture();
    const response = await request("/api/storage/codex-logs/compact", {
      ...deps,
      quickCheck: () => ["synthetic corruption"],
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "integrity_check_failed", phase: "before" });
  });
});
