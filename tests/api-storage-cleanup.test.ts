import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// Windows CI under load can spend >5s just binding the proxy + previewing cleanup;
// Bun's default test budget then fails the suite before the assertion runs.
setDefaultTimeout(20_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authMode: "forward",
      },
    },
  } as OcxConfig;
}

function seedArchived(codexHome: string): void {
  mkdirSync(join(codexHome, "archived_sessions"));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), "o".repeat(100));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), "n".repeat(200));
  utimesSync(join(codexHome, "archived_sessions", "rollout-old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
  utimesSync(join(codexHome, "archived_sessions", "rollout-new.jsonl"), new Date("2026-06-01"), new Date("2026-06-01"));
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)`);
  db.exec(`INSERT INTO threads VALUES
    ('told','archived_sessions/rollout-old.jsonl',1),
    ('tnew','archived_sessions/rollout-new.jsonl',1)
  `);
  db.close();
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-storage-cleanup-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-storage-cleanup-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("POST /api/storage/cleanup", () => {
  test("preview returns digest without host paths", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(1);
      expect(body.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.candidates[0].relPath).toBe("archived_sessions/rollout-old.jsonl");
      expect(body.candidates[0].absPath).toBeUndefined();
      expect(body.codexHome).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("quarantine mode moves files and returns trashDir", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("quarantine");
      expect(body.count).toBe(1);
      expect(body.trashDir).toContain(".trash/");
      expect(body.error).toBeUndefined();
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("permanent mode deletes files without trash", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "permanent", digest: preview.digest }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("permanent");
      expect(body.count).toBe(1);
      expect(body.trashDir).toBeUndefined();
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(isolatedCodexHome!.path, ".trash"))).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("stale_preview returns 409 with mapped error only", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      writeFileSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-extra.jsonl"), "x");
      utimesSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-extra.jsonl"), new Date("2025-01-01"), new Date("2025-01-01"));
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("stale_preview");
      expect(JSON.stringify(body)).not.toContain(isolatedCodexHome!.path);
    } finally {
      await server.stop(true);
    }
  });

  test("codex_busy returns 409", async () => {
    seedArchived(isolatedCodexHome!.path);
    const locker = new Database(join(isolatedCodexHome!.path, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100, mode: "quarantine", digest: preview.digest }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("codex_busy");
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    } finally {
      await server.stop(true);
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  test("rejects invalid mode", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 10, mode: "yeet", digest: "a".repeat(64) }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("invalid_mode");
    } finally {
      await server.stop(true);
    }
  });

  test("partial permanent purge returns relative trashDir on the wire", async () => {
    seedArchived(isolatedCodexHome!.path);
    const previous = process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
    process.env.OPENCODEX_CLEANUP_TEST_HOOKS = "1";
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 100 }),
      });
      const preview = await previewRes.json();
      const res = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          percent: 100,
          mode: "permanent",
          digest: preview.digest,
          _test: { failPurgeBasenames: ["rollout-new.jsonl"] },
        }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("fs_failed");
      expect(body.trashDir).toMatch(/^\.trash\/\d+$/);
      expect(JSON.stringify(body)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
      const trashAbs = join(isolatedCodexHome!.path, ...String(body.trashDir).split("/"));
      expect(existsSync(join(trashAbs, "rollout-new.jsonl"))).toBe(true);
      expect(existsSync(join(trashAbs, "manifest.json"))).toBe(true);
    } finally {
      await server.stop(true);
      if (previous === undefined) delete process.env.OPENCODEX_CLEANUP_TEST_HOOKS;
      else process.env.OPENCODEX_CLEANUP_TEST_HOOKS = previous;
    }
  });
});

describe("GET /api/storage/trash + POST restore", () => {
  test("lists relative trash entries and restores without host paths", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      expect(cleanupRes.status).toBe(200);
      const cleanup = await cleanupRes.json();
      expect(cleanup.trashDir).toMatch(/^\.trash\//);

      const listRes = await fetch(new URL("/api/storage/trash", server.url));
      expect(listRes.status).toBe(200);
      const listed = await listRes.json();
      expect(listed.entries).toHaveLength(1);
      expect(listed.entries[0].id).toBe(cleanup.trashDir);
      expect(listed.entries[0].fileCount).toBe(1);
      expect(JSON.stringify(listed)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));

      const restoreRes = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: cleanup.trashDir }),
      });
      expect(restoreRes.status).toBe(200);
      const restored = await restoreRes.json();
      expect(restored.ok).toBe(true);
      expect(restored.count).toBe(1);
      expect(restored.restoredPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
      expect(JSON.stringify(restored)).not.toContain(isolatedCodexHome!.path.replaceAll("\\", "\\\\"));
      expect(existsSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"))).toBe(true);

      const listAfter = await (await fetch(new URL("/api/storage/trash", server.url))).json();
      expect(listAfter.entries).toEqual([]);
    } finally {
      await server.stop(true);
    }
  }, { timeout: 20_000 });

  test("restore returns 409 when Codex DB is busy", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      const cleanup = await cleanupRes.json();

      const locker = new Database(join(isolatedCodexHome!.path, "state_5.sqlite"));
      locker.exec("BEGIN EXCLUSIVE");
      try {
        const restoreRes = await fetch(new URL("/api/storage/trash/restore", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: cleanup.trashDir }),
        });
        expect(restoreRes.status).toBe(409);
        const body = await restoreRes.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("codex_busy");
      } finally {
        locker.exec("ROLLBACK");
        locker.close();
      }
    } finally {
      await server.stop(true);
    }
  }, { timeout: 20_000 });

  test("rejects invalid and missing trash ids", async () => {
    const server = startServer(0);
    try {
      const invalid = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "../etc/passwd" }),
      });
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).error).toBe("invalid_trash");

      const missing = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ".trash/999999999" }),
      });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toBe("missing_trash");
    } finally {
      await server.stop(true);
    }
  });

  test("restore returns 409 when destination archived file already exists", async () => {
    seedArchived(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const previewRes = await fetch(new URL("/api/storage/cleanup/preview", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50 }),
      });
      const preview = await previewRes.json();
      const cleanupRes = await fetch(new URL("/api/storage/cleanup", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ percent: 50, mode: "quarantine", digest: preview.digest }),
      });
      const cleanup = await cleanupRes.json();
      expect(cleanup.ok).toBe(true);

      writeFileSync(join(isolatedCodexHome!.path, "archived_sessions", "rollout-old.jsonl"), "COLLISION");
      const restoreRes = await fetch(new URL("/api/storage/trash/restore", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: cleanup.trashDir }),
      });
      expect(restoreRes.status).toBe(409);
      const body = await restoreRes.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe("dest_exists");
    } finally {
      await server.stop(true);
    }
  });
});
