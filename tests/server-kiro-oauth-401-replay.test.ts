import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KIRO_COMPLETION_TOOL_NAME } from "../src/adapters/kiro-constants";
import { encodeMessage } from "../src/lib/eventstream-decoder";
import { saveConfig } from "../src/config";
import { saveCredential } from "../src/oauth/store";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const enc = new TextEncoder();
const CHAT_ENDPOINT = "https://runtime.us-east-1.kiro.dev/";
const REFRESH_ENDPOINT = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";

let testDir = "";
let emptyHome = "";
let previousOpenCodexHome: string | undefined;
let previousHome: string | undefined;
let previousRegion: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousHome = process.env.HOME;
  previousRegion = process.env.KIRO_REGION;
  isolatedCodexHome = installIsolatedCodexHome("ocx-kiro-401-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-kiro-401-"));
  emptyHome = mkdtempSync(join(tmpdir(), "ocx-kiro-401-home-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.HOME = emptyHome;
  process.env.KIRO_REGION = "us-east-1";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = previousRegion;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  rmSync(testDir, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "kiro",
    providers: {
      kiro: {
        adapter: "kiro",
        baseUrl: CHAT_ENDPOINT.slice(0, -1),
        authMode: "oauth",
        models: ["claude-sonnet-4.5"],
      },
    },
  } as OcxConfig;
}

function eventFrame(eventType: string, payload: Record<string, unknown>): Uint8Array {
  return encodeMessage(
    { ":message-type": "event", ":event-type": eventType },
    enc.encode(JSON.stringify(payload)),
  );
}

function eventStream(text: string): Uint8Array {
  return eventFrame("assistantResponseEvent", { content: text });
}

function completionStream(answer: string): Uint8Array {
  const id = "completion-1";
  return Buffer.concat([
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, input: JSON.stringify({ answer }) }),
    eventFrame("toolUseEvent", { name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, stop: true }),
  ]);
}

async function post(server: ReturnType<typeof startServer>, toolEnabled = false): Promise<Response> {
  return originalFetch(new URL("/v1/responses", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "kiro/claude-sonnet-4.5",
      input: "hello",
      stream: false,
      ...(toolEnabled ? {
        tools: [{ type: "function", name: "bash", description: "Run a command", parameters: { type: "object" } }],
      } : {}),
    }),
  });
}

async function seedOAuth(): Promise<void> {
  await saveCredential("kiro", {
    access: "rejected-access",
    refresh: "initial-refresh",
    expires: Date.now() + 3_600_000,
    accountId: "kiro-test-account",
    source: "oauth",
  });
}

function installFetch(chatStatuses: number[]): { chatAuth: string[]; refreshCalls: () => number } {
  const chatAuth: string[] = [];
  let refreshCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === REFRESH_ENDPOINT) {
      refreshCalls += 1;
      return new Response(JSON.stringify({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresIn: 3600,
      }), { headers: { "content-type": "application/json" } });
    }
    if (url === CHAT_ENDPOINT) {
      chatAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      const status = chatStatuses.shift() ?? 200;
      if (status === 401) return new Response("rejected", { status: 401 });
      return new Response(eventStream("ok after refresh"), {
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { chatAuth, refreshCalls: () => refreshCalls };
}

describe("Kiro OAuth upstream 401 replay", () => {
  test("401 then 200 performs one refresh and one replay", async () => {
    await seedOAuth();
    saveConfig(config());
    const observed = installFetch([401, 200]);
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      const json = await response.json() as { output?: Array<{ type: string; content?: Array<{ text?: string }> }> };
      expect(json.output?.find(item => item.type === "message")?.content?.[0]?.text).toBe("ok after refresh");
      expect(observed.refreshCalls()).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      server.stop(true);
    }
  });

  test("a second 401 is propagated without a second refresh or replay", async () => {
    await seedOAuth();
    saveConfig(config());
    const observed = installFetch([401, 401]);
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(401);
      expect(observed.refreshCalls()).toBe(1);
      expect(observed.chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access"]);
    } finally {
      server.stop(true);
    }
  });

  test("bounded completion fallback keeps the refreshed adapter after replay", async () => {
    await seedOAuth();
    saveConfig(config());
    const chatAuth: string[] = [];
    let refreshCalls = 0;
    let chatCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === REFRESH_ENDPOINT) {
        refreshCalls += 1;
        return new Response(JSON.stringify({
          accessToken: "fresh-access",
          refreshToken: "fresh-refresh",
          expiresIn: 3600,
        }), { headers: { "content-type": "application/json" } });
      }
      if (url === CHAT_ENDPOINT) {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        chatAuth.push(authorization);
        chatCalls += 1;
        if (chatCalls === 1) return new Response("rejected", { status: 401 });
        if (authorization !== "Bearer fresh-access") return new Response("stale token", { status: 401 });
        return new Response(
          chatCalls === 2 ? eventStream("working") : completionStream("done"),
          { headers: { "content-type": "application/vnd.amazon.eventstream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const server = startServer(0);
    try {
      const response = await post(server, true);
      expect(response.status).toBe(200);
      const json = await response.json() as { output?: Array<{ type: string; phase?: string; content?: Array<{ text?: string }> }> };
      const messages = json.output?.filter(item => item.type === "message") ?? [];
      expect(messages.map(item => [item.content?.[0]?.text, item.phase])).toEqual([
        ["working", "commentary"],
        ["done", "final_answer"],
      ]);
      expect(refreshCalls).toBe(1);
      expect(chatAuth).toEqual(["Bearer rejected-access", "Bearer fresh-access", "Bearer fresh-access"]);
    } finally {
      server.stop(true);
    }
  });
});
