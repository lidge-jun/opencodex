import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveMeter, catalogContextLimit, handleLiveMeterData, liveMeterPreflight, resetLiveMeterCatalogCacheForTests } from "../../src/server/live-meter-handler";
import { isAllowedRequestOrigin } from "../../src/server/auth-cors";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import { clearRequestLogsForTests, getRequestLogEntries, type RequestLogEntry } from "../../src/server/request-log";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS, removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

const CONVERSATION = "thread-raw-id-7f3a";
const DIGEST = normalizeLogConversationId(CONVERSATION)!;

const row = (o: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  requestId: "r", timestamp: 100, model: "gpt-6-astra", provider: "native", client: "codex_desktop", status: 200,
  durationMs: 10000, genStartMs: 2000, lastOutputMs: 8000, usageStatus: "reported",
  usage: { inputTokens: 1000, outputTokens: 600, cacheReadInputTokens: 750 }, ...o,
} as RequestLogEntry);

const entries = [
  row({ timestamp: 100, conversationId: DIGEST }),
  row({ timestamp: 200, client: "claude_code", model: "claude-x", conversationId: "someone-else" }),
  row({ timestamp: 300, client: "codex_cli", model: "codex-auto-review" }),
  row({ timestamp: 150, client: "codex_cli", conversationId: DIGEST, usage: { inputTokens: 10, outputTokens: 5 } }),
];
const deps = { entries: () => entries, contextLimit: (m: string) => (m === "gpt-6-astra" ? 872000 : null), now: () => 42 };

describe("live meter body", () => {
  test("latest overall and per family, auto-review rows never selected", () => {
    const r = buildLiveMeter(new URLSearchParams(), deps);
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body.generatedAt).toBe(42);
    expect(r.body.latest?.client).toBe("claude_code");
    expect(Object.keys(r.body.byClient).sort()).toEqual(["claude", "codex"]);
    expect(r.body.byClient.codex?.timestamp).toBe(150);
    expect(r.body.byClient.claude?.context).toMatchObject({ limitTokens: null, reason: "limit_unknown" });
  });

  test("client filter narrows latest and byClient", () => {
    const r = buildLiveMeter(new URLSearchParams("client=codex"), deps);
    expect(r.status === 200 && r.body.latest?.timestamp).toBe(150);
    expect(r.status === 200 && Object.keys(r.body.byClient)).toEqual(["codex"]);
    const none = buildLiveMeter(new URLSearchParams("client=other"), deps);
    expect(none.status === 200 && none.body).toEqual({ latest: null, byClient: {}, generatedAt: 42 });
  });

  test("conversation filter accepts raw id, digest and thread link, and echoes none of them", () => {
    for (const q of [CONVERSATION, DIGEST, `codex://threads/${CONVERSATION}`]) {
      const r = buildLiveMeter(new URLSearchParams({ conversation: q }), deps);
      expect(r.status === 200 && r.body.latest?.timestamp).toBe(150);
      const text = JSON.stringify(r);
      expect(text).not.toContain(CONVERSATION);
      expect(text).not.toContain(DIGEST);
    }
    const miss = buildLiveMeter(new URLSearchParams({ conversation: "unknown" }), deps);
    expect(miss.status === 200 && miss.body.latest).toBeNull();
  });

  test("bad queries are 400 with a code, not an empty meter", () => {
    for (const q of ["client=gemini", "conversation=", "client=codex&client=claude", "x=1"]) {
      expect(buildLiveMeter(new URLSearchParams(q), deps)).toMatchObject({ status: 400, code: "live_meter_query_invalid" });
    }
  });

  test("no request yet means a null latest, not a zeroed meter", () => {
    const r = buildLiveMeter(new URLSearchParams(), { ...deps, entries: () => [] });
    expect(r.status === 200 && r.body.latest).toBeNull();
  });
});

describe("catalog context limit", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    resetLiveMeterCatalogCacheForTests();
  });

  test("maps client-facing slug to context_window and re-reads only when the file changes", () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-live-meter-"));
    const path = join(dir, "opencodex-catalog.json");
    const catalog = (window: number) => JSON.stringify({ models: [
      { slug: "gpt-6-astra", context_window: window, max_context_window: 872000 },
      { slug: "google-vertex/gemini-4-argon", context_window: 1000000 },
      { slug: "no-window" },
    ] });
    writeFileSync(path, catalog(872000));
    expect(catalogContextLimit("gpt-6-astra", path)).toBe(872000);
    expect(catalogContextLimit("google-vertex/gemini-4-argon", path)).toBe(1000000);
    expect(catalogContextLimit("no-window", path)).toBeNull();
    expect(catalogContextLimit("missing", path)).toBeNull();
    writeFileSync(path, catalog(400000));
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    expect(catalogContextLimit("gpt-6-astra", path)).toBe(400000);
    rmSync(path);
    expect(catalogContextLimit("gpt-6-astra", path)).toBeNull();
  });
});

describe("data-plane admission and CORS", () => {
  const key = { id: "k", name: "k", key: "ocx_data_livemeterkey", createdAt: "2026-01-01" };
  const loopback = { hostname: "127.0.0.1", corsAllowOrigins: [], apiKeys: [] };
  const remote = { hostname: "0.0.0.0", corsAllowOrigins: [], apiKeys: [key] };
  const get = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

  test("loopback needs no key and answers the Codex desktop origin with that exact origin", async () => {
    const res = await handleLiveMeterData(get("http://127.0.0.1:1/v1/usage/live", { origin: "app://-", host: "127.0.0.1:1" }), loopback, deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("app://-");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).latest.client).toBe("claude_code");
  });

  test("loopback still refuses a rebinding Host and any other foreign origin", async () => {
    const rebound = await handleLiveMeterData(get("http://evil.test/v1/usage/live", { origin: "app://-", host: "evil.test" }), loopback, deps);
    expect(rebound.status).toBe(403);
    const foreign = await handleLiveMeterData(get("http://127.0.0.1:1/v1/usage/live", { origin: "https://evil.test", host: "127.0.0.1:1" }), loopback, deps);
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).not.toBe("https://evil.test");
  });

  test("a non-loopback bind without a data key is rejected, with a key it is served", async () => {
    const anon = await handleLiveMeterData(get("http://10.0.0.2:1/v1/usage/live", { origin: "app://-" }), remote, deps);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("access-control-allow-origin")).not.toBe("app://-");
    const wrong = await handleLiveMeterData(get("http://10.0.0.2:1/v1/usage/live", { "x-opencodex-api-key": "nope" }), remote, deps);
    expect(wrong.status).toBe(401);
    for (const headers of [{ "x-opencodex-api-key": key.key }, { authorization: `Bearer ${key.key}` }, { "x-api-key": key.key }]) {
      const ok = await handleLiveMeterData(get("http://10.0.0.2:1/v1/usage/live", { origin: "app://-", ...headers }), remote, deps);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("app://-");
    }
  });

  test("the app origin is not admitted anywhere else: the data-plane origin policy is unchanged", () => {
    expect(isAllowedRequestOrigin(get("http://127.0.0.1:1/v1/models", { origin: "app://-", host: "127.0.0.1:1" }), loopback)).toBe(false);
  });

  test("preflight answers only the Codex desktop origin, with GET only and the exact origin", () => {
    const pre = (headers: Record<string, string>, config = loopback) => liveMeterPreflight(new Request("http://127.0.0.1:1/v1/usage/live", { method: "OPTIONS", headers }), config);
    const ok = pre({ origin: "app://-", host: "127.0.0.1:1", "access-control-request-headers": "x-opencodex-api-key" });
    expect(ok?.status).toBe(204);
    expect(ok?.headers.get("access-control-allow-origin")).toBe("app://-");
    expect(ok?.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(ok?.headers.get("access-control-allow-headers")).toContain("X-OpenCodex-API-Key");
    expect(pre({ origin: "https://evil.test", host: "127.0.0.1:1" })).toBeNull();
    expect(pre({ host: "127.0.0.1:1" })).toBeNull();
    expect(pre({ origin: "app://-", host: "evil.test" })).toBeNull();
  });
});

describe("running server", () => {
  const envKeys = ["OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
  let saved: Record<string, string | undefined>;
  let home: string;
  let codex: IsolatedCodexHome;
  let server: ReturnType<typeof startServer> | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
    home = mkdtempSync(join(tmpdir(), "ocx-live-meter-server-"));
    codex = installIsolatedCodexHome();
    process.env.OPENCODEX_HOME = home;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({ ...getDefaultConfig(), port: 0, hostname: "127.0.0.1", providers: {} });
    clearRequestLogsForTests();
  });
  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
    clearRequestLogsForTests();
    for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    codex.restore();
    await removeTreeAfterBackgroundWork(home);
  }, BACKGROUND_WORK_TEARDOWN_TIMEOUT_MS);

  test("the route, its preflight and the rest of the data plane behave as specified for app://-", async () => {
    server = startServer(0);
    getRequestLogEntries().push(row({ timestamp: Date.now(), model: "unlisted-model" }));
    const base = server.url;
    const app = { origin: "app://-" };
    const res = await fetch(new URL("/v1/usage/live", base), { headers: app });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("app://-");
    const body = await res.json();
    expect(body.latest).toMatchObject({ model: "unlisted-model", speed: { value: 100, reason: null }, context: { reason: "limit_unknown" } });
    expect(body.byClient.codex.model).toBe("unlisted-model");

    const pre = await fetch(new URL("/v1/usage/live", base), { method: "OPTIONS", headers: { ...app, "access-control-request-method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("app://-");

    const models = await fetch(new URL("/v1/models", base), { headers: app });
    expect(models.status).toBe(403);
    const otherPre = await fetch(new URL("/v1/models", base), { method: "OPTIONS", headers: { ...app, "access-control-request-method": "GET" } });
    expect(otherPre.status).toBe(403);
    const postRes = await fetch(new URL("/v1/usage/live", base), { method: "POST", headers: app });
    expect(postRes.status).not.toBe(200);
  }, 60000);
});
