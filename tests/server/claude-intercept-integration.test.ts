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
