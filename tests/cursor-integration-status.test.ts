import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../src/codex/model-entitlements";
import { cursorProductJsonCandidates, detectCursorInstalls, type CursorDetectDeps } from "../src/integrations/cursor-detect";
import { parseCursorEffortTable, type CursorEffortTable } from "../src/integrations/cursor-effort-table";
import { cursorLastSeen, recordCursorSeen, resetCursorSeenForTests } from "../src/integrations/cursor-seen";
import { cursorEffortFamily } from "../src/server/models-capabilities";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { removeTreeWithRetry } from "./helpers/remove-tree";

setDefaultTimeout(SERVER_BUDGET_MS);

function fakeDeps(platform: string, tree: Record<string, string | string[]>, env: Record<string, string> = {}): CursorDetectDeps {
  return {
    platform,
    homedir: "/home/u",
    env,
    readText: path => {
      const value = tree[path];
      return typeof value === "string" ? value : null;
    },
    listDir: path => {
      const value = tree[path];
      return Array.isArray(value) ? value : [];
    },
  };
}

describe("detectCursorInstalls", () => {
  test("tells Private Inference apart from regular Cursor by product.json nameLong on macOS", () => {
    const deps = fakeDeps("darwin", {
      "/Applications": ["Cursor.app", "Cursor Private Inference.app", "Xcode.app"],
      "/Applications/Cursor.app/Contents/Resources/app/product.json": JSON.stringify({ nameLong: "Cursor", version: "3.18.9" }),
      "/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json": JSON.stringify({ nameLong: "Cursor Private Inference", version: "3.18.25" }),
    });
    expect(detectCursorInstalls(deps)).toEqual([
      { build: "regular", path: "/Applications/Cursor.app", version: "3.18.9" },
      { build: "private-inference", path: "/Applications/Cursor Private Inference.app", version: "3.18.25" },
    ]);
  });

  test("looks under LOCALAPPDATA/Programs on Windows and skips malformed product.json", () => {
    const deps = fakeDeps("win32", {
      "C:\\Users\\u\\AppData\\Local\\Programs": ["cursor", "cursor-private-inference"],
      "C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\resources\\app\\product.json": "{not json",
      "C:\\Users\\u\\AppData\\Local\\Programs\\cursor-private-inference\\resources\\app\\product.json": JSON.stringify({ nameLong: "Cursor Private Inference" }),
    }, { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
    const candidates = cursorProductJsonCandidates(deps);
    expect(candidates.length).toBe(2);
    const installs = detectCursorInstalls(deps);
    expect(installs.map(install => install.build)).toEqual(["private-inference"]);
    expect(installs[0].version).toBeNull();
  });

  test("finds nothing when no candidate directory exists", () => {
    expect(detectCursorInstalls(fakeDeps("linux", {}))).toEqual([]);
  });
});

describe("cursor last-seen recorder", () => {
  beforeEach(() => resetCursorSeenForTests());
  afterEach(() => resetCursorSeenForTests());

  test("records only a Cursor user agent, bounded and validated", () => {
    recordCursorSeen(new Headers({ "user-agent": "curl/8.7.1" }), 1000);
    expect(cursorLastSeen()).toBeNull();
    recordCursorSeen(new Headers({ "user-agent": "Cursor/3.18.25" }), 2000);
    expect(cursorLastSeen()).toEqual({ at: 2000, userAgent: "Cursor/3.18.25" });
    // A padded or oversized value is not the shape Cursor sends and is ignored.
    recordCursorSeen(new Headers({ "user-agent": `Cursor/${"x".repeat(60)}` }), 3000);
    recordCursorSeen(new Headers({ "user-agent": "Cursor/3.18.25 <script>" }), 4000);
    expect(cursorLastSeen()?.at).toBe(2000);
  });
});

describe("cursorEffortFamily", () => {
  test("mirrors Cursor's local picker table and strips provider prefixes", () => {
    expect(cursorEffortFamily("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cursorEffortFamily("anthropic/claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cursorEffortFamily("xai/grok-4.6")).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(cursorEffortFamily("cursor/gemini-3.7-flash")).toEqual(["minimal", "low", "medium", "high"]);
    expect(cursorEffortFamily("anthropic/claude-fable-5-1")).toBeNull();
    expect(cursorEffortFamily("kimi/k3")).toBeNull();
  });
});

const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";
const CURSOR_EFFORT_FIXTURE = readFileSync(join(import.meta.dir, "fixtures/cursor-agent-exec-effort-table.min.js"), "utf8");
const STATIC_CURSOR_EFFORT_DEPS = { managementApi: { loadCursorEffortTable: () => null } };

function fixtureEffortTable(): CursorEffortTable {
  const parsed = parseCursorEffortTable(CURSOR_EFFORT_FIXTURE);
  if (!parsed) throw new Error("Cursor effort fixture did not parse");
  return { ...parsed, version: "3.18.25", bundlePath: "/fixture/main.js" };
}

function statusConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kimi",
    providers: {
      kimi: {
        adapter: "openai-chat",
        baseUrl: "https://kimi.test/v1",
        liveModels: false,
        models: ["k3"],
      },
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        liveModels: false,
      },
    },
  };
}

describe("GET /api/native-integrations/cursor", () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-cursor-status-"));
    process.env.OPENCODEX_HOME = testHome;
    resetCursorSeenForTests();
  });

  afterEach(() => {
    resetCodexModelEntitlementCacheForTests();
    resetCursorSeenForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testHome) removeTreeWithRetry(testHome);
    testHome = "";
  });

  test("reports gateway values, model expectations, and a last-seen Cursor request", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    saveConfig(statusConfig());
    const server = startServer(0, STATIC_CURSOR_EFFORT_DEPS);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      const headers = { "x-opencodex-api-key": adminToken };

      const before = await fetch(new URL("/api/native-integrations/cursor", server.url), { headers });
      expect(before.status).toBe(200);
      const first = await before.json() as {
        gateway: { baseUrl: string; apiKeyMode: string; placeholder: string };
        lastSeen: unknown;
        effortTable: { source: string };
        models: Array<{ id: string; reasoning: string[] | null; family: string | null; context: { defaultWindow: number; longWindow: number } | null }>;
        privateInference: { installed: boolean };
        guideUrl: string;
      };
      expect(first.gateway.baseUrl).toBe(`http://127.0.0.1:${server.port}/v1`);
      expect(first.gateway.apiKeyMode).toBe("placeholder");
      expect(first.gateway.placeholder).toBe("opencodex-loopback");
      expect(first.lastSeen).toBeNull();
      expect(first.effortTable.source).toBe("static");
      expect(typeof first.privateInference.installed).toBe("boolean");
      expect(first.guideUrl).toContain("cursor-private-inference");
      const k3 = first.models.find(model => model.id === "kimi/k3");
      expect(k3).toEqual({
        id: "kimi/k3",
        reasoning: null,
        family: null,
        tableLess: true,
        effortRows: [],
        context: null,
      });
      const sol = first.models.find(model => model.id === "gpt-5.6-sol");
      expect(sol).toEqual({
        id: "gpt-5.6-sol",
        reasoning: ["low", "medium", "high", "xhigh"],
        family: null,
        tableLess: false,
        effortRows: [],
        context: { defaultWindow: 272000, longWindow: 922000 },
      });

      const discovery = await fetch(new URL("/v1/models", server.url), { headers: { "user-agent": "Cursor/3.18.25" } });
      expect(discovery.status).toBe(200);
      const after = await fetch(new URL("/api/native-integrations/cursor", server.url), { headers });
      const second = await after.json() as { lastSeen: { at: number; userAgent: string } | null };
      expect(second.lastSeen?.userAgent).toBe("Cursor/3.18.25");
      expect(typeof second.lastSeen?.at).toBe("number");
    } finally {
      await server.stop(true);
    }
  });

  test("reports credential mode when an API key is configured", async () => {
    const config = statusConfig();
    config.apiKeys = [{ id: "k1", name: "test", key: "ocx_test_key_value_1234567890", createdAt: new Date(0).toISOString() }];
    saveConfig(config);
    const server = startServer(0, STATIC_CURSOR_EFFORT_DEPS);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      const res = await fetch(new URL("/api/native-integrations/cursor", server.url), { headers: { "x-opencodex-api-key": adminToken } });
      const body = await res.json() as { gateway: { apiKeyMode: string } };
      expect(body.gateway.apiKeyMode).toBe("credential");
    } finally {
      await server.stop(true);
    }
  });

  test("a disabled model leaves the prediction the same way it leaves /v1/models", async () => {
    seedCodexModelEntitlementsForTests("main", ["gpt-5.6-sol"]);
    saveConfig({ ...statusConfig(), disabledModels: ["kimi/k3"] });
    const server = startServer(0, STATIC_CURSOR_EFFORT_DEPS);
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      const status = await fetch(new URL("/api/native-integrations/cursor", server.url), { headers: { "x-opencodex-api-key": adminToken } });
      const body = await status.json() as { models: Array<{ id: string }> };
      expect(body.models.some(model => model.id === "kimi/k3")).toBe(false);
      const raw = await fetch(new URL("/v1/models", server.url), { headers: { "user-agent": "Cursor/3.18.25" } });
      const list = await raw.json() as { data: Array<{ id: string }> };
      expect(list.data.some(model => model.id === "kimi/k3")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("reports bundle effort-table provenance and unmatched model families through the server deps seam", async () => {
    saveConfig(statusConfig());
    const server = startServer(0, { managementApi: { loadCursorEffortTable: () => fixtureEffortTable() } });
    try {
      const adminToken = readFileSync(join(testHome, "admin-api-token"), "utf8").trim();
      const status = await fetch(new URL("/api/native-integrations/cursor", server.url), {
        headers: { "x-opencodex-api-key": adminToken },
      });
      expect(status.status).toBe(200);
      const body = await status.json() as {
        effortTable: { source: string; version: string | null; families: number | null };
        models: Array<{ id: string; family: string | null }>;
      };
      expect(body.effortTable).toEqual({ source: "bundle", version: "3.18.25", families: 16 });
      expect(body.models.find(model => model.id === "kimi/k3")?.family).toBeNull();
    } finally {
      await server.stop(true);
    }
  });
});
