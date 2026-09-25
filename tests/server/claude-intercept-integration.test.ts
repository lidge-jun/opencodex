/**
 * The Claude intercept pair wired into a real `startServer`: a client configured with nothing
 * but `HTTPS_PROXY` and the local CA reaches the router's Messages handler under the loopback
 * policy, while every other path on the intercepted host is relayed to the configured upstream
 * and never touches the router's own routes.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { findAvailablePort } from "../../src/server/ports";
import { claudeInterceptCaCertPath } from "../../src/claude/intercept/local-ca";
import { getClaudeInterceptState } from "../../src/claude/intercept/runtime";
import type { OcxConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-intercept-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_API_AUTH_TOKEN = "public-secret";
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

async function waitForIntercept(): Promise<NonNullable<ReturnType<typeof getClaudeInterceptState>>> {
  for (let i = 0; i < 100; i++) {
    const state = getClaudeInterceptState();
    if (state) return state;
    await Bun.sleep(20);
  }
  throw new Error("intercept pair did not start");
}

test("Messages through CONNECT reach the router; other paths relay to the configured upstream", async () => {
  const upstreamHits: string[] = [];
  const fakeUpstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      upstreamHits.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ upstream: true });
    },
  });
  const interceptPort = await findAvailablePort(0, "127.0.0.1");
  const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: interceptPort });
  saveConfig({
    port: publicPort,
    hostname: "127.0.0.1",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    claudeCode: {
      anthropicBaseUrl: `http://127.0.0.1:${fakeUpstream.port}`,
      intercept: { port: interceptPort },
    },
  } as unknown as OcxConfig);
  const server = startServer(publicPort);
  try {
    const state = await waitForIntercept();
    expect(state.proxyPort).toBe(interceptPort);
    expect(state.caCertPath).toBe(claudeInterceptCaCertPath(testDir));
    const ca = readFileSync(state.caCertPath, "utf8");
    const proxy = `http://127.0.0.1:${state.proxyPort}`;

    // No opencodex admission token is sent: the intercept ingress takes the loopback policy, so
    // the request is judged by the Messages handler (which fails on routing, since the test
    // config has no usable provider credential) rather than refused at admission.
    const messages = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      proxy,
      tls: { ca },
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-not-real" },
      body: JSON.stringify({ model: "no-such-model-for-intercept-test", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });
    const messagesBody = await messages.json() as { type: string; error: { message: string } };
    expect(messages.headers.get("content-type")).toContain("application/json");
    expect(messagesBody.type).toBe("error");
    expect(messagesBody.error.message).not.toContain("opencodex API key required");
    expect(messagesBody.error.message).not.toContain("Unknown endpoint");
    expect(upstreamHits).toEqual([]);

    // Anything else on the intercepted host is the client's own business with Anthropic.
    const models = await fetch("https://api.anthropic.com/v1/models", { proxy, tls: { ca } });
    expect(await models.json()).toEqual({ upstream: true });
    const health = await fetch("https://api.anthropic.com/healthz", { proxy, tls: { ca } });
    expect(await health.json()).toEqual({ upstream: true });
    expect(upstreamHits).toEqual(["GET /v1/models", "GET /healthz"]);
  } finally {
    await server.stop(true);
    fakeUpstream.stop(true);
  }
  expect(getClaudeInterceptState()).toBeNull();
}, SERVER_BUDGET_MS);

test("a first-party binding routes a picker id on the intercept only; the public listener still passes it through", async () => {
  const upstreamHits: string[] = [];
  const fakeAnthropic = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      upstreamHits.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ id: "msg_upstream", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "upstream" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    },
  });
  const providerHits: Array<{ path: string; model: unknown }> = [];
  const fakeProvider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json().catch(() => ({})) as { model?: unknown; stream?: unknown };
      providerHits.push({ path: new URL(req.url).pathname, model: body.model });
      const chunk = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: { role: "assistant", content: "bound" }, finish_reason: null }] };
      const done = { id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      if (body.stream) {
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json({ id: "c1", object: "chat.completion", created: 1, model: "fake-model", choices: [{ index: 0, message: { role: "assistant", content: "bound" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  const interceptPort = await findAvailablePort(0, "127.0.0.1");
  const publicPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: interceptPort });
  saveConfig({
    port: publicPort,
    hostname: "127.0.0.1",
    defaultProvider: "bindtarget",
    providers: {
      bindtarget: { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${fakeProvider.port}/v1`, allowPrivateNetwork: true, apiKey: "sk-fake", models: ["fake-model"], liveModels: false },
    },
    claudeCode: {
      anthropicBaseUrl: `http://127.0.0.1:${fakeAnthropic.port}`,
      intercept: { port: interceptPort, modelMap: { "claude-sonnet-4-6": "bindtarget/fake-model" } },
    },
  } as unknown as OcxConfig);
  const server = startServer(publicPort);
  try {
    const state = await waitForIntercept();
    const ca = readFileSync(state.caCertPath, "utf8");
    const proxy = `http://127.0.0.1:${state.proxyPort}`;
    const request = { model: "claude-sonnet-4-6", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
    const anthropicHeaders = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "sk-ant-not-real" };

    // Desktop's Code tab: the picker id arrives through the CONNECT tunnel and is served by the binding.
    const bound = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", proxy, tls: { ca }, headers: anthropicHeaders, body: JSON.stringify(request) });
    expect(bound.status).toBe(200);
    expect(providerHits.map(hit => hit.model)).toEqual(["fake-model"]);
    expect(upstreamHits).toEqual([]);

    // count_tokens for a bound id is estimated locally, never passed through to Anthropic.
    const counted = await fetch("https://api.anthropic.com/v1/messages/count_tokens", { method: "POST", proxy, tls: { ca }, headers: anthropicHeaders, body: JSON.stringify(request) });
    expect(counted.status).toBe(200);
    expect(upstreamHits).toEqual([]);

    // The same id on the public listener is not a first-party request: native passthrough as before.
    const direct = await fetch(`http://127.0.0.1:${publicPort}/v1/messages`, {
      method: "POST",
      headers: { ...anthropicHeaders, "x-opencodex-api-key": "public-secret" },
      body: JSON.stringify(request),
    });
    expect(direct.status).toBe(200);
    expect(upstreamHits).toEqual(["POST /v1/messages"]);
    expect(providerHits).toHaveLength(1);
  } finally {
    await server.stop(true);
    fakeAnthropic.stop(true);
    fakeProvider.stop(true);
  }
}, SERVER_BUDGET_MS);

test("an ephemeral public port starts no proxy unless intercept.port is explicit", async () => {
  const base = {
    hostname: "127.0.0.1",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
  };
  saveConfig({ ...base, port: 10100 } as unknown as OcxConfig);
  const implicit = startServer(0);
  try {
    await Bun.sleep(100);
    expect(getClaudeInterceptState()).toBeNull();
  } finally {
    await implicit.stop(true);
  }

  const proxyPort = await findAvailablePort(0, "127.0.0.1");
  saveConfig({ ...base, port: 10100, claudeCode: { intercept: { port: proxyPort } } } as unknown as OcxConfig);
  const explicit = startServer(0);
  try {
    const state = await waitForIntercept();
    expect(state.proxyPort).toBe(proxyPort);
  } finally {
    await explicit.stop(true);
  }
}, SERVER_BUDGET_MS);

test("intercept.enabled=false starts no proxy", async () => {
  const publicPort = await findAvailablePort(0, "127.0.0.1");
  saveConfig({
    port: publicPort,
    hostname: "127.0.0.1",
    defaultProvider: "chatgpt",
    providers: {
      chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    claudeCode: { intercept: { enabled: false } },
  } as unknown as OcxConfig);
  const server = startServer(publicPort);
  try {
    await Bun.sleep(100);
    expect(getClaudeInterceptState()).toBeNull();
    expect(existsSync(join(testDir, "claude-intercept"))).toBe(false);
  } finally {
    await server.stop(true);
  }
}, SERVER_BUDGET_MS);
