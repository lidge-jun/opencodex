import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { handleResponses } from "../../../src/server/responses";
import { saveConfig } from "../../../src/config";
import { setActiveProviderApiKey } from "../../../src/providers/api-keys";
import type { OcxConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const ACCOUNT_A_ORIGIN = "https://a.githubcopilot.com";
const ACCOUNT_B_ORIGIN = "https://b.githubcopilot.com";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const GITHUB_USER_URL = "https://api.github.com/user";

const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let beforeBuildReturns: (() => Promise<void>) | undefined;
let beforePacingReturns: (() => Promise<void>) | undefined;
const actualPacing = await import("../../../src/providers/request-pacing");
const originalWaitForSlot = actualPacing.waitForProviderRequestSlot;
mock.module("../../../src/providers/request-pacing", () => ({
  ...actualPacing,
  waitForProviderRequestSlot: async (...args: Parameters<typeof originalWaitForSlot>) => {
    const result = await originalWaitForSlot(...args);
    const gate = beforePacingReturns;
    beforePacingReturns = undefined;
    await gate?.();
    return result;
  },
}));
const actualAdapterResolver = await import("../../../src/server/adapter-resolve");
const originalResolveAdapter = actualAdapterResolver.resolveAdapter;
mock.module("../../../src/server/adapter-resolve", () => ({
  ...actualAdapterResolver,
  resolveAdapter: (...args: Parameters<typeof originalResolveAdapter>) => {
    const adapter = originalResolveAdapter(...args);
    const build = adapter.buildRequest.bind(adapter);
    adapter.buildRequest = async (...buildArgs) => {
      const built = await build(...buildArgs);
      const gate = beforeBuildReturns;
      beforeBuildReturns = undefined;
      await gate?.();
      return built;
    };
    return adapter;
  },
}));

type Wire = "chat" | "responses";

function bearer(accessToken: string): string {
  return ["Bearer", accessToken].join(" ");
}

function config(wire: Wire): OcxConfig {
  const model = wire === "chat" ? "gpt-4o" : "gpt-5.4";
  return {
    port: 0,
    defaultProvider: "github-copilot",
    providers: {
      "github-copilot": {
        adapter: "openai-chat",
        authMode: "oauth",
        baseUrl: "https://api.githubcopilot.com",
        models: [model],
        ...(wire === "responses" ? { modelAdapters: { [model]: "openai-responses" } } : {}),
      },
    },
  } as OcxConfig;
}

function request(wire: Wire, extra: Record<string, unknown> = {}): Request {
  const model = wire === "chat" ? "gpt-4o" : "gpt-5.4";
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `github-copilot/${model}`, input: "hello", stream: false, ...extra }),
  });
}

function successResponse(wire: Wire): Response {
  if (wire === "responses") {
    return Response.json({
      id: "resp-copilot-origin",
      object: "response",
      status: "completed",
      model: "gpt-5.4",
      output: [{
        id: "msg-copilot-origin",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }
  return Response.json({
    id: "chatcmpl-copilot-origin",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function seedAccounts(aExpires = Date.now() + 3_600_000): Promise<{ a: string; b: string }> {
  await saveCredential("github-copilot", {
    access: "copilot-access-a",
    refresh: "gho-account-a",
    expires: aExpires,
    accountId: "101",
    apiBaseUrl: ACCOUNT_A_ORIGIN,
    source: "oauth",
  });
  await saveCredential("github-copilot", {
    access: "copilot-access-b",
    refresh: "gho-account-b",
    expires: Date.now() + 3_600_000,
    accountId: "202",
    apiBaseUrl: ACCOUNT_B_ORIGIN,
    source: "oauth",
  });
  const set = getAccountSet("github-copilot");
  const a = set?.accounts.find(account => account.credential.accountId === "101")?.id;
  const b = set?.accounts.find(account => account.credential.accountId === "202")?.id;
  if (!a || !b) throw new Error("failed to seed Copilot account fixtures");
  await setActiveAccount("github-copilot", a);
  return { a, b };
}

function installFetch(options: {
  wire: Wire;
  statuses: number[];
  switchToAccountId?: string;
  switchOn: "refresh" | "first-dispatch" | "never";
  emptyFirst?: boolean;
}): { dispatches: { origin: string; authorization: string }[] } {
  const dispatches: { origin: string; authorization: string }[] = [];
  let refreshSwitched = false;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === COPILOT_TOKEN_URL) {
      if (options.switchOn === "refresh" && options.switchToAccountId && !refreshSwitched) {
        refreshSwitched = true;
        await setActiveAccount("github-copilot", options.switchToAccountId);
      }
      return Response.json({
        token: "copilot-access-a-refreshed",
        refresh_in: 1500,
        endpoints: { api: ACCOUNT_A_ORIGIN },
      });
    }
    if (url === GITHUB_USER_URL) return Response.json({ id: 101 });

    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".githubcopilot.com") || parsed.hostname === "api.githubcopilot.com") {
      dispatches.push({
        origin: parsed.origin,
        authorization: new Headers(init?.headers).get("authorization") ?? "",
      });
      if (options.switchOn === "first-dispatch" && options.switchToAccountId && dispatches.length === 1) {
        await setActiveAccount("github-copilot", options.switchToAccountId);
      }
      const status = options.statuses.shift() ?? 200;
      if (status !== 200) {
        return Response.json({ error: { message: status === 401 ? "rejected" : "limited" } }, {
          status,
          headers: status === 429 ? { "retry-after": "1" } : undefined,
        });
      }
      if (options.emptyFirst && dispatches.length === 1) {
        return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }] });
      }
      if (JSON.parse(String(init?.body ?? "{}")).stream === true && options.wire === "chat") {
        return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return successResponse(options.wire);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return { dispatches };
}

beforeEach(() => {
  beforeBuildReturns = undefined;
  beforePacingReturns = undefined;
  home = mkdtempSync(join(tmpdir(), "ocx-copilot-origin-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

describe("GitHub Copilot bearer/origin snapshot atomicity", () => {
  test.each(["chat", "responses", "image", "web-search"] as const)("%s API-key dispatch uses a selection committed during pacing", async path => {
    const cfg = config("chat");
    cfg.defaultProvider = "fixture";
    cfg.providers = { fixture: {
      adapter: path === "responses" ? "openai-responses" : "openai-chat", authMode: "key",
      baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-a", models: ["model"],
      apiKeyPool: [{ id: "a", key: "synthetic-a" }, { id: "b", key: "synthetic-b" }],
    } };
    if (path === "image") {
      cfg.images = { bridgeEnabled: true };
      cfg.providers.xai = { adapter: "openai-chat", authMode: "key", apiKey: "synthetic-image-key", baseUrl: "https://api.x.ai/v1" };
    } else if (path === "web-search") cfg.webSearchSidecar = { enabled: true, backend: "exa", exaApiKey: "synthetic-search-key" };
    saveConfig(cfg);
    beforePacingReturns = async () => { expect(setActiveProviderApiKey(cfg, "fixture", "b")).toBe(true); };
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      if (path === "image" || path === "web-search") return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      return successResponse(path);
    }) as typeof fetch;
    const response = await handleResponses(request("chat", {
      model: "fixture/model", stream: path === "image" || path === "web-search",
      ...(path === "image" || path === "web-search" ? { tools: [{ type: path === "image" ? "image_generation" : "web_search" }] } : {}),
    }), cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("ok");
    expect(sent).toEqual(["Bearer synthetic-b"]);
  });

  test("a pacing switch to B keeps B when Anthropic rebuilds an image after 413", async () => {
    for (const id of ["a", "b"]) await saveCredential("anthropic", {
      access: `synthetic-anthropic-${id}`, refresh: `synthetic-refresh-${id}`,
      expires: Date.now() + 3_600_000, accountId: id,
    });
    const rows = getAccountSet("anthropic")!.accounts;
    await setActiveAccount("anthropic", rows[0]!.id);
    beforePacingReturns = async () => { await setActiveAccount("anthropic", rows[1]!.id); };
    const sent: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      if (sent.length === 1) return Response.json({ error: { type: "request_too_large", message: "too large" } }, { status: 413 });
      return Response.json({ id: "message-selection", type: "message", role: "assistant",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const cfg = config("chat");
    cfg.providers = { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", models: ["claude-fable-5"] } };
    cfg.defaultProvider = "anthropic";
    const response = await handleResponses(request("chat", {
      model: "anthropic/claude-fable-5",
      input: [{ role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
      ] }],
    }), cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("ok");
    expect(sent).toEqual(["Bearer synthetic-anthropic-b", "Bearer synthetic-anthropic-b"]);
  });

  test("a pacing switch to B keeps B for an empty-completion continuation", async () => {
    const accounts = await seedAccounts();
    beforePacingReturns = async () => { await setActiveAccount("github-copilot", accounts.b); };
    const observed = installFetch({ wire: "chat", statuses: [200, 200], switchOn: "never", emptyFirst: true });
    const cfg = config("chat");
    cfg.emptyCompletionRetry = true;
    const response = await handleResponses(request("chat"), cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("ok");
    expect(observed.dispatches).toEqual([
      { origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") },
      { origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") },
    ]);
  });

  test.each(["image", "web-search"] as const)("%s main-model dispatch follows a manual choice made during pacing", async path => {
    const accounts = await seedAccounts();
    beforePacingReturns = async () => { await setActiveAccount("github-copilot", accounts.b); };
    const observed = installFetch({ wire: "chat", statuses: [200], switchOn: "never" });
    const cfg = config("chat");
    if (path === "image") {
      cfg.images = { bridgeEnabled: true };
      cfg.providers.xai = { adapter: "openai-chat", authMode: "key", apiKey: "synthetic-image-key", baseUrl: "https://api.x.ai/v1" };
    } else {
      cfg.webSearchSidecar = { enabled: true, backend: "exa", exaApiKey: "synthetic-search-key" };
    }
    const response = await handleResponses(request("chat", {
      stream: true, tools: [{ type: path === "image" ? "image_generation" : "web_search" }],
    }), cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("ok");
    expect(observed.dispatches).toEqual([{ origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") }]);
  });

  test("a cached search-loop adapter cannot bless A wire with B's current snapshot", async () => {
    const accounts = await seedAccounts();
    beforePacingReturns = async () => { await setActiveAccount("github-copilot", accounts.b); };
    const sent: string[] = [];
    const bodies: Array<{ messages: Array<{ role: string }> }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.exa.ai") return Response.json({ results: [] });
      if (!url.hostname.endsWith(".githubcopilot.com")) throw new Error("Unexpected fixture request");
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      bodies.push(JSON.parse(String(init?.body)));
      const delta = sent.length === 1
        ? { tool_calls: [{ index: 0, id: "search-1", type: "function", function: { name: "web_search", arguments: '{"query":"fixture"}' } }] }
        : { content: "ok after search" };
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: sent.length === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const cfg = config("chat");
    cfg.webSearchSidecar = { enabled: true, backend: "exa", exaApiKey: "synthetic-search-key" };
    const response = await handleResponses(request("chat", { stream: true, tools: [{ type: "web_search" }] }), cfg, { model: "", provider: "" });
    expect(await response.text()).toContain("ok after search");
    expect(sent).toEqual(["Bearer copilot-access-b", "Bearer copilot-access-b"]);
    expect(bodies[1]!.messages.some(message => message.role === "tool")).toBe(true);
  });

  test("a key removed during pacing is never dispatched", async () => {
    const cfg = config("chat");
    cfg.defaultProvider = "fixture";
    cfg.providers = { fixture: { adapter: "openai-chat", authMode: "key", baseUrl: "https://fixture.invalid/v1", apiKey: "synthetic-a" } };
    beforePacingReturns = async () => { delete cfg.providers.fixture; };
    let sends = 0;
    globalThis.fetch = (async () => { sends++; return successResponse("chat"); }) as typeof fetch;
    const response = await handleResponses(request("chat", { model: "fixture/model" }), cfg, { model: "", provider: "" });
    await response.text();
    expect(response.status).not.toBe(200);
    expect(sends).toBe(0);
  });

  for (const wire of ["chat", "responses"] as const) {
    test(`${wire} revalidates selection after pacing and before physical dispatch`, async () => {
      const accounts = await seedAccounts();
      beforePacingReturns = async () => { await setActiveAccount("github-copilot", accounts.b); };
      const observed = installFetch({ wire, statuses: [200], switchOn: "never" });
      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([{ origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") }]);
    });
    test(`${wire} rebuilds after a manual selection during asynchronous request building`, async () => {
      const accounts = await seedAccounts();
      beforeBuildReturns = async () => { await setActiveAccount("github-copilot", accounts.b); };
      const observed = installFetch({ wire, statuses: [200], switchOn: "never" });
      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();
      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([{ origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") }]);
    });
    test(`${wire} initial admission follows a newer manual selection with its matching origin`, async () => {
      const accounts = await seedAccounts(0);
      const observed = installFetch({
        wire,
        statuses: [200],
        switchToAccountId: accounts.b,
        switchOn: "refresh",
      });

      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();

      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([{
        origin: ACCOUNT_B_ORIGIN,
        authorization: bearer("copilot-access-b"),
      }]);
    });

    test(`${wire} 401 replay follows a newer manual selection with its matching origin`, async () => {
      const accounts = await seedAccounts();
      const observed = installFetch({
        wire,
        statuses: [401, 200],
        switchToAccountId: accounts.b,
        switchOn: "first-dispatch",
      });

      const response = await handleResponses(request(wire), config(wire), { model: "", provider: "" });
      await response.text();

      expect(response.status).toBe(200);
      expect(observed.dispatches).toEqual([
        { origin: ACCOUNT_A_ORIGIN, authorization: bearer("copilot-access-a") },
        { origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") },
      ]);
    });
  }

  test("chat 429 failover moves bearer and origin together to account B", async () => {
    await seedAccounts();
    const observed = installFetch({ wire: "chat", statuses: [429, 200], switchOn: "never" });

    const response = await handleResponses(request("chat"), config("chat"), { model: "", provider: "" });
    await response.text();

    expect(response.status).toBe(200);
    expect(observed.dispatches).toEqual([
      { origin: ACCOUNT_A_ORIGIN, authorization: bearer("copilot-access-a") },
      { origin: ACCOUNT_B_ORIGIN, authorization: bearer("copilot-access-b") },
    ]);
  });
});
