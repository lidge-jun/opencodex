import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

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

/** Seed the isolated CODEX_HOME with a known sessions tree the endpoint must report. */
function writeSessionsFixture(codexHome: string): void {
  mkdirSync(join(codexHome, "sessions", "2026", "07", "01"), { recursive: true });
  writeFileSync(join(codexHome, "sessions", "2026", "07", "01", "rollout-x.jsonl"), "x".repeat(500));
  mkdirSync(join(codexHome, "archived_sessions"));
  writeFileSync(join(codexHome, "archived_sessions", "rollout-y.jsonl"), "y".repeat(120));
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-api-storage-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-api-storage-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(baseConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = "";
});

describe("GET /api/storage", () => {
  test("returns the scan report with buckets and totals, no error field", async () => {
    writeSessionsFixture(isolatedCodexHome!.path);
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/storage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.codexHome).toBe(isolatedCodexHome!.path);
      expect(body.generatedAt).toBeGreaterThan(0);
      expect(body.error).toBeUndefined();
      expect(Array.isArray(body.buckets)).toBe(true);

      const sessions = body.buckets.find((b: { key: string }) => b.key === "sessions");
      expect(sessions.bytes).toBe(500);
      expect(sessions.fileCount).toBe(1);
      const archived = body.buckets.find((b: { key: string }) => b.key === "archived_sessions");
      expect(archived.bytes).toBe(120);
      // config.toml written by the isolated-home helper lands in "other".
      expect(body.total.fileCount).toBe(3);
      expect(body.total.bytes).toBeGreaterThan(620);
    } finally {
      await server.stop(true);
    }
  });

  test("scan failure returns the fallback envelope with scan_failed", async () => {
    const server = startServer(0);
    try {
      // Point CODEX_HOME at a regular file: resolveCodexHomeDir() accepts it, the
      // scanner's root readdir then fails with ENOTDIR — the endpoint must answer
      // with the documented fallback envelope instead of a 500.
      const brokenHome = join(testDir, "codex-home-is-a-file");
      writeFileSync(brokenHome, "not a directory");
      process.env.CODEX_HOME = brokenHome;

      const res = await fetch(new URL("/api/storage", server.url));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe("scan_failed");
      expect(body.total).toEqual({ bytes: 0, fileCount: 0 });
      expect(body.buckets).toEqual([]);
      expect(typeof body.codexHome).toBe("string");
    } finally {
      await server.stop(true);
    }
  });
});
