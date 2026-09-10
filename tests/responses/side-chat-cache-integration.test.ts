import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSideChatCache, SIDE_CHAT_BOUNDARY, SIDE_CHAT_RULES } from "../../src/codex/side-chat-cache";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import { handleResponses } from "../../src/server/responses";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const message = (role: string, text: string) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const history = [message("developer", "Parent rules"), message("user", "Parent question")];
const childInput = [...history, message("user", SIDE_CHAT_BOUNDARY), message("user", "Child question")];
const model = "gpt-5.6-luna";
type Captured = { body: Record<string, unknown>; headers: Headers };
let captured: Captured[];
let terminal: "completed" | "failed" | "incomplete";
let home: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-side-cache-handler-"));
  process.env.OPENCODEX_HOME = home;
  codexHome = installIsolatedCodexHome();
  prepareSideChatCache({}, {}, false);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  captured = [];
  terminal = "completed";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "chatgpt.com") throw new Error("Unexpected upstream destination");
    if (!url.pathname.endsWith("/responses")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
    captured.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    const response = { id: `resp_fixture_${captured.length}`, object: "response", model, status: terminal, output: [],
      ...(terminal === "failed" ? { error: { code: "server_error", message: "Fixture failed" } } : {}),
      usage: { input_tokens: 2048, output_tokens: 1, total_tokens: 2049, input_tokens_details: { cached_tokens: 1024 } } };
    const payloads = [{ type: `response.${terminal}`, response }, ...(terminal === "completed" ? [] : [
      { type: "response.completed", response: { ...response, status: "completed" } },
    ])];
    return new Response(payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  prepareSideChatCache({}, {}, false);
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

async function send(thread: string, options: { parent?: string; account?: string; credential?: string;
  enabled?: boolean; input?: ReturnType<typeof message>[] } = {}): Promise<Captured> {
  const account = options.account ?? "fixture-account-a";
  const config: OcxConfig = { port: 0, defaultProvider: "openai", providers: { openai: {
    adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex",
    codexAccountMode: "direct", ...(options.enabled === undefined ? {} : { experimentalCodexSideChatCache: options.enabled }),
  } } };
  const body = { model, stream: true, store: false, instructions: "Base instructions", tools: [],
    input: options.input ?? (options.parent ? childInput : history), prompt_cache_key: thread,
    client_metadata: { session_id: thread, thread_id: thread, turn_id: `turn-${thread}` } };
  const request = new Request("http://localhost/v1/responses", { method: "POST", headers: {
    "content-type": "application/json", authorization: `Bearer ${fakeChatGptJwt({ chatgpt_account_id: account,
      jti: options.credential ?? "fixture-credential" })}`, "chatgpt-account-id": account,
    "thread-id": thread, "session-id": thread, "x-client-request-id": `request-${thread}`,
    "x-codex-turn-metadata": JSON.stringify({ session_id: thread, thread_id: thread, turn_id: `turn-${thread}`,
      ...(options.parent ? { forked_from_thread_id: options.parent } : {}) }),
  }, body: JSON.stringify(body) });
  const count = captured.length;
  const response = await handleResponses(request, config, { model: "", provider: "" } as RequestLogContext);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain(`response.${terminal}`);
  expect(captured.length).toBe(count + 1);
  return captured.at(-1)!;
}

describe("side-chat cache through the Responses handler", () => {
  test("completed parent reuse keeps sibling task, turn, and request ownership distinct", async () => {
    await send("parent", { enabled: true });
    for (const child of ["child-a", "child-b"]) {
      const wire = await send(child, { parent: "parent", enabled: true });
      expect(wire.body.prompt_cache_key).toBe("parent");
      expect(wire.headers.get("session-id")).toBe("parent");
      expect(wire.headers.get("thread-id")).toBe(child);
      expect(wire.headers.get("x-client-request-id")).toBe(`request-${child}`);
      expect(wire.body.client_metadata).toMatchObject({ session_id: "parent", thread_id: child, turn_id: `turn-${child}` });
      expect(wire.body).not.toHaveProperty("previous_response_id");
      expect(wire.headers.has("x-codex-parent-thread-id")).toBe(false);
      expect(wire.body.input).toEqual([...history, message("developer", SIDE_CHAT_BOUNDARY), ...childInput.slice(2)]);
    }
  });

  test("selected account and credential changes cannot acquire the parent's session", async () => {
    await send("parent", { enabled: true });
    for (const change of [{ account: "fixture-account-b" }, { credential: "refreshed-credential" }]) {
      const child = "account" in change ? "other-account" : "other-credential";
      const wire = await send(child, { parent: "parent", enabled: true, ...change });
      expect(wire.body.prompt_cache_key).toBe(child);
      expect(wire.headers.get("session-id")).toBe(child);
      expect(wire.body.input).toEqual(childInput);
    }
  });

  test.each([undefined, false])("default/off (%s) does not normalize rules or inherit identity", async enabled => {
    await send("parent", { enabled: true });
    const input = [message("developer", `Parent rules\n\n${SIDE_CHAT_RULES}`), ...childInput.slice(1)];
    const wire = await send("child", { parent: "parent", enabled, input });
    expect(wire.body.input).toEqual(input);
    expect(wire.body.prompt_cache_key).toBe("child");
    expect(wire.headers.get("session-id")).toBe("child");
  });

  test.each(["failed", "incomplete"] as const)("a %s terminal followed by completed does not seed reuse", async status => {
    terminal = status;
    await send("parent", { enabled: true });
    terminal = "completed";
    const wire = await send("child", { parent: "parent", enabled: true });
    expect(wire.body.prompt_cache_key).toBe("child");
    expect(wire.headers.get("session-id")).toBe("child");
  });
});
