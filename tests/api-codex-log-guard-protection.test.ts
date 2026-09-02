import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodexLogGuardMode, CodexLogGuardProtectionDeps } from "../src/codex/log-guard/protection";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";
import { ManagementRequest } from "./helpers/management-auth";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;

function createLogsDb(path: string): void {
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

function fixture(): { databasePath: string; protectionDeps: CodexLogGuardProtectionDeps } {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-api-protect-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const ocxHome = join(root, "ocx-home");
  mkdirSync(codexHome);
  mkdirSync(ocxHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 0,
    defaultProvider: "openai",
    providers: {},
  }));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = ocxHome;
  const databasePath = join(codexHome, "logs_2.sqlite");
  createLogsDb(databasePath);

  let desiredMode: CodexLogGuardMode = "off";
  const protectionDeps: CodexLogGuardProtectionDeps = {
    codexHome,
    processCheck: () => ({ state: "ok", processes: [] }),
    readDesiredMode: () => desiredMode,
    writeDesiredMode: mode => { desiredMode = mode; },
    withLock: <T>(_home: string, _database: string, work: () => T) => ({
      kind: "completed",
      value: work(),
    }),
  };
  return { databasePath, protectionDeps };
}

function config(): OcxConfig {
  return { port: 0, defaultProvider: "openai", providers: {} } as OcxConfig;
}

async function request(
  path: string,
  init: RequestInit,
  protectionDeps: CodexLogGuardProtectionDeps,
): Promise<Response> {
  const req = new ManagementRequest(`http://localhost${path}`, init);
  const response = await handleManagementAPI(
    req,
    new URL(req.url),
    config(),
    { codexLogGuardProtectionDeps: protectionDeps },
  );
  expect(response).not.toBeNull();
  return response!;
}

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex Log Guard protection management API", () => {
  test("protect, drift repair, and unprotect round-trip desired and observed state", async () => {
    const { databasePath, protectionDeps } = fixture();

    const protect = await request("/api/storage/codex-logs/protect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "compat" }),
    }, protectionDeps);
    expect(protect.status).toBe(200);
    expect((await protect.json()).protection).toEqual({
      desiredMode: "compat",
      observedMode: "compat",
      state: "active",
    });

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

    const drift = await request("/api/storage/codex-logs", { method: "GET" }, protectionDeps);
    expect(drift.status).toBe(200);
    expect((await drift.json()).protection).toEqual({
      desiredMode: "compat",
      observedMode: "off",
      state: "drifted",
    });

    const repair = await request(
      "/api/storage/codex-logs/repair",
      { method: "POST" },
      protectionDeps,
    );
    expect(repair.status).toBe(200);
    expect((await repair.json()).protection.state).toBe("active");

    const unprotect = await request(
      "/api/storage/codex-logs/unprotect",
      { method: "POST" },
      protectionDeps,
    );
    expect(unprotect.status).toBe(200);
    expect((await unprotect.json()).protection).toEqual({
      desiredMode: "off",
      observedMode: "off",
      state: "off",
    });
  });

  test("protect validates its mode before touching the database", async () => {
    const { protectionDeps } = fixture();
    const response = await request("/api/storage/codex-logs/protect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "maximum" }),
    }, protectionDeps);
    expect(response.status).toBe(400);
  });
});
