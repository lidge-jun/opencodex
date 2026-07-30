import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Full-suite Windows load: startServer + management flows often exceed bun's default
// 5s per-test budget (same flake class as claude-management-api.test.ts).
setDefaultTimeout(30_000);

let testDir = "";
let grokRoot = "";
let previousHome: string | undefined;
let previousGrokHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousGrokHome = process.env.GROK_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-grok-mgmt-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-grok-mgmt-"));
  grokRoot = mkdtempSync(join(tmpdir(), "ocx-grok-home-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.GROK_HOME = grokRoot;
  saveConfig({
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, liveModels: false, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = previousGrokHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  if (grokRoot) rmSync(grokRoot, { recursive: true, force: true });
});

test("PUT /api/grok/selection rejects a non-array body", async () => {
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/api/grok/selection", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excluded: "kimi/k3" }),
    });
    expect(res.status).toBe(400);
  } finally {
    server.stop(true);
  }
});

test("PUT /api/grok/selection dedupes, sorts, and persists", async () => {
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/api/grok/selection", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excluded: ["b", "a", "a"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; excluded: string[] };
    expect(body.excluded).toEqual(["a", "b"]);
    expect(loadConfig().grokExcludedModels).toEqual(["a", "b"]);
  } finally {
    server.stop(true);
  }
});

test("PUT /api/grok/selection with an empty list removes the field", async () => {
  const server = startServer(0);
  try {
    const config = loadConfig();
    config.grokExcludedModels = ["a"];
    saveConfig(config);

    const res = await fetch(new URL("/api/grok/selection", server.url), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ excluded: [] }),
    });
    expect(res.status).toBe(200);
    expect(loadConfig().grokExcludedModels).toBeUndefined();
  } finally {
    server.stop(true);
  }
});

test("GET /api/grok includes candidates and the saved exclusion list", async () => {
  // The server reads config at startup, so the exclusion must be on disk BEFORE it boots.
  const config = loadConfig();
  config.grokExcludedModels = ["cursor/grok-4.5"];
  saveConfig(config);
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/api/grok", server.url));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      present: boolean;
      candidates: Array<{ id: string; native: boolean }>;
      excluded: string[];
    };
    expect(body.excluded).toEqual(["cursor/grok-4.5"]);
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates.some(c => c.native)).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("POST /api/grok/apply reports no-grok-home as a policy skip, not an error", async () => {
  const server = startServer(0);
  try {
    // resolveGrokHome reads GROK_HOME at CALL time, so point it at a path that does
    // not exist: the no-grok-home guard must fire and be observable, not a 500.
    process.env.GROK_HOME = join(grokRoot, "does-not-exist");
    const res = await fetch(new URL("/api/grok/apply", server.url), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; skippedReason?: string };
    expect(body.ok).toBe(true);
    expect(body.skippedReason).toBe("no-grok-home");
  } finally {
    server.stop(true);
  }
});

test("POST /api/grok/apply writes through the guarded writer and is idempotent", async () => {
  const server = startServer(0);
  try {
    // Give Grok a real home so the writer engages; the second apply must report
    // changed:false — proving the HTTP path really reaches injectGrokConfig.
    mkdirSync(join(grokRoot, ".grok"));
    const first = await fetch(new URL("/api/grok/apply", server.url), { method: "POST" });
    const firstBody = await first.json() as { ok: boolean; changed: boolean; skippedReason?: string };
    expect(firstBody.ok).toBe(true);

    const second = await fetch(new URL("/api/grok/apply", server.url), { method: "POST" });
    const secondBody = await second.json() as { ok: boolean; changed: boolean };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.changed).toBe(false);
  } finally {
    server.stop(true);
  }
});
