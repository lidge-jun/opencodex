import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { flushNativeMainStartupReleases } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { spendLedgerOwnerSnapshot } from "../../src/lib/spend-ledger-owner";
import { flushWindowsSecretAclReapsBeforeRemoval } from "../../src/lib/windows-secret-acl";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { estimateTokens } from "../../src/lib/token-estimate";
import { getRequestLogEntries } from "../../src/server/request-log";
import * as stateStores from "../../src/lib/state-store-registrations";

let previousHome: string | undefined;
let testDir = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
let activeServer: ReturnType<typeof startServer> | undefined;
let activeUpstream: ReturnType<typeof Bun.serve> | undefined;
let activeRawUpstream: ReturnType<typeof createServer> | undefined;
let stopping: Promise<void> | undefined;
function stopFixtureServers(): Promise<void> {
  // A timed-out body and its afterEach join one owner instead of racing two stops.
  return stopping ??= (async () => {
    try { await activeServer?.stop(true); }
    finally {
      await activeUpstream?.stop(true);
      if (activeRawUpstream) {
        const raw = activeRawUpstream;
        await new Promise<void>(resolve => raw.close(() => resolve()));
      }
    }
  })();
}
beforeEach(() => {
  activeServer = undefined;
  activeUpstream = undefined;
  activeRawUpstream = undefined;
  stopping = undefined;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-chat-spend-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-chat-spend-"));
  process.env.OPENCODEX_HOME = testDir;
});
afterEach(async () => {
  await stopFixtureServers();
  // Stop background owners before removing the home they can still harden/open.
  await flushNativeMainStartupReleases();
  await flushConfigDirHardeningForTests();
  // A caller-facing ACL timeout is not evidence that its child released the path.
  await flushWindowsSecretAclReapsBeforeRemoval(testDir);
  if (isolatedCodexHome) await flushWindowsSecretAclReapsBeforeRemoval(isolatedCodexHome.path);
  expect(spendLedgerOwnerSnapshot().ownership).toBe("unheld");
  resetProviderRequestPacingForTest();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function mockChatUpstreamCapturing() {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ error: { message: `unexpected path ${url.pathname}` } }, { status: 404 });
      }
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " from mock" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  activeUpstream = server;
  return { server, captured };
}

function mockConfig(baseUrl: string, providerOverrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...providerOverrides,
      },
    },
  } as OcxConfig;
}

test("native Chat refuses a physical send that exceeds the configured pool spend ceiling", async () => {
  const upstream = mockChatUpstreamCapturing();
  const config = mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`);
  config.spend = { pool: { maxTokens: 1 } };
  saveConfig(config);
  const server = startServer(0);
  activeServer = server;
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    expect(upstream.captured).toHaveLength(0);
  } finally {
    await stopFixtureServers();
  }
});

test("native Chat reports a spend refusal on a transient retry leg as local 429", async () => {
  const messages = [{ role: "user", content: "hello" }];
  let upstreamSends = 0;
  const upstream = Bun.serve({
    port: 0,
    fetch() {
      upstreamSends += 1;
      return Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 });
    },
  });
  activeUpstream = upstream;
  const config = mockConfig(`${upstream.url.toString().replace(/\/$/, "")}/v1`, {
    transientRetryOn5xx: { attempts: 2 },
  });
  config.spend = { pool: { maxTokens: estimateTokens(JSON.stringify(messages), "mock/test-model") + 1 } };
  saveConfig(config);
  const server = startServer(0);
  activeServer = server;
  const response = await fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/test-model", messages, max_tokens: 1 }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
  expect(upstreamSends).toBe(1);
  expect(getRequestLogEntries().findLast(row => row.inboundProtocol === "chat")).toMatchObject({
    status: 429, errorCode: "workflow_spend_exhausted",
  });
});

test("native Chat includes tool definitions in its pre-dispatch spend reservation", async () => {
  const upstream = mockChatUpstreamCapturing();
  const config = mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`);
  config.spend = { pool: { maxTokens: 500 } };
  saveConfig(config);
  const server = startServer(0);
  activeServer = server;
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock/test-model", messages: [{ role: "user", content: "hello" }],
        max_tokens: 1, tools: [{ type: "function", function: { name: "large_tool", description: "large schema ".repeat(2_000), parameters: { type: "object" } } }] }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-opencodex-local-refusal")).toBe("workflow_spend_exhausted");
    expect(upstream.captured).toHaveLength(0);
  } finally {
    await stopFixtureServers();
  }
});

/**
 * A raw TCP upstream, because `Bun.serve` turns a body error into a CLEAN EOF: the client would
 * read an empty 200 instead of the reset under test. Only a real socket close after the head
 * produces the `ECONNRESET` the zero-output wrapper is built for, so the fixture writes the head
 * by hand and destroys the socket before the first chunk.
 */
async function mockResettingChatUpstream(
  opts: {
    onSend?: (sendIndex: number, headers: string) => void;
    replacementFrames?: string;
  } = {},
): Promise<{ baseUrl: string; sends: () => number }> {
  let sends = 0;
  const server = createServer(socket => {
    let buffered = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headers = buffered.subarray(0, headerEnd).toString("latin1");
      const declared = /content-length:\s*(\d+)/i.exec(headers);
      if (buffered.length < headerEnd + 4 + (declared ? Number(declared[1]) : 0)) return;
      sends += 1;
      opts.onSend?.(sends, headers);
      if (sends === 1) {
        // A real 200 head, chunked, then a hard close before the first chunk: the head is
        // genuine and the body never carried a byte, which is the stage under test.
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const body = opts.replacementFrames ?? recoveredChatFrames();
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  activeRawUpstream = server;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, sends: () => sends };
}

function recoveredChatFrames(): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Recovered" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

async function postStreamingChat(
  server: ReturnType<typeof startServer>,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      ...extra,
    }),
  });
  return { status: response.status, text: await response.text() };
}

test("native Chat replaces a zero-output mid-stream reset exactly once under the operator opt-in", async () => {
  const upstream = await mockResettingChatUpstream();
  saveConfig(mockConfig(upstream.baseUrl, { retryOnReset: {} }));
  const server = startServer(0);
  activeServer = server;
  try {
    const { status, text } = await postStreamingChat(server);
    expect(status).toBe(200);
    expect(text).toContain("Recovered");
    // The allowance buys ONE replacement send, not one more retry ladder.
    expect(upstream.sends()).toBe(2);
  } finally {
    await stopFixtureServers();
  }
});

test("native Chat leaves a zero-output mid-stream reset alone without the operator opt-in", async () => {
  const upstream = await mockResettingChatUpstream();
  saveConfig(mockConfig(upstream.baseUrl));
  const server = startServer(0);
  activeServer = server;
  try {
    const { text } = await postStreamingChat(server);
    expect(upstream.sends()).toBe(1);
    expect(text).not.toContain("Recovered");
  } finally {
    await stopFixtureServers();
  }
});

test("native Chat refuses the replacement when the tool catalog cannot be replayed", async () => {
  const upstream = await mockResettingChatUpstream();
  saveConfig(mockConfig(upstream.baseUrl, { retryOnReset: {} }));
  const server = startServer(0);
  activeServer = server;
  try {
    // A malformed catalog still routes native -- eligibility judges only the Responses-only
    // fields -- so this is the case that actually reaches selfContainedChatBody.
    const { text } = await postStreamingChat(server, { tools: "not a list" });
    expect(upstream.sends()).toBe(1);
    expect(text).not.toContain("Recovered");
  } finally {
    await stopFixtureServers();
  }
});

test("native Chat refuses the replacement when the body asks for hosted search", async () => {
  const upstream = await mockResettingChatUpstream();
  saveConfig(mockConfig(upstream.baseUrl, { retryOnReset: {} }));
  const server = startServer(0);
  activeServer = server;
  try {
    const { text } = await postStreamingChat(server, { web_search_options: {} });
    expect(upstream.sends()).toBe(1);
    expect(text).not.toContain("Recovered");
  } finally {
    await stopFixtureServers();
  }
});

test("a store-enabled turn leaves the native lane, so its reset is not replaced", async () => {
  const upstream = await mockResettingChatUpstream();
  saveConfig(mockConfig(upstream.baseUrl, { retryOnReset: {} }));
  const server = startServer(0);
  activeServer = server;
  try {
    // `store: true` is a Responses-only feature, so eligibility declines the native lane before
    // selfContainedChatBody is consulted. The replacement is the native lane's, so none is made.
    const { text } = await postStreamingChat(server, { store: true });
    expect(upstream.sends()).toBe(1);
    expect(text).not.toContain("Recovered");
  } finally {
    await stopFixtureServers();
  }
});

test("native Chat releases retained request bytes after key reselection on replacement send", async () => {
  let liveConfig: OcxConfig | null = null;
  const realSetLive = stateStores.setLiveStateStoreConfig;
  const liveSpy = spyOn(stateStores, "setLiveStateStoreConfig").mockImplementation(cfg => {
    liveConfig = cfg;
    return realSetLive(cfg);
  });
  const seenAuth: string[] = [];
  const largeDelta = "X".repeat(64 * 1024);
  const largeFrames = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: largeDelta } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 100 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  const upstream = await mockResettingChatUpstream({
    onSend: (sendIndex, headers) => {
      const auth = /authorization:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();
      if (auth) seenAuth.push(auth);
      if (sendIndex === 1 && liveConfig?.providers.mock) {
        liveConfig.providers.mock.apiKey = "k-rotated";
      }
    },
    replacementFrames: largeFrames,
  });

  saveConfig(mockConfig(upstream.baseUrl, { retryOnReset: {} }));
  const server = startServer(0);
  activeServer = server;
  try {
    const { status, text } = await postStreamingChat(server, {
      messages: [{ role: "user", content: "hello ".repeat(500) }],
    });
    expect(status).toBe(200);
    expect(text).toContain(largeDelta);
    expect(upstream.sends()).toBe(2);
    expect(seenAuth).toEqual(["Bearer k", "Bearer k-rotated"]);
  } finally {
    liveSpy.mockRestore();
    await stopFixtureServers();
  }
});
