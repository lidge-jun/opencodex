import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum } from "../../src/oauth/anthropic-routing";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { nativeMessagesToolScopeDenial } from "../../src/server/messages-native-scope";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

type Rec = Record<string, unknown>;
// This pair supports both Advisor and inline system-message tool changes.
const EXECUTOR = "claude-sonnet-5-5";
const ADVISOR = "claude-opus-5-5";
const advisor = (model: unknown = ADVISOR): Rec => ({ type: "advisor_20260301", name: "advisor", model });
const custom = { name: "lookup", input_schema: { type: "object", properties: {} } };
const user = { role: "user", content: "fixture question" };
const system = (type: string, tool: Rec): Rec => ({ role: "system", content: [{ type, tool }] });
const addition = (definition: Rec): Rec => system("tool_addition", { type: "tool_definition", definition });
const reference = (type: string): Rec => system(type, { type: "tool_reference", name: "advisor" });

let home: string;
let oldHome: string | undefined;
let originalFetch: typeof fetch;
let release: (() => void) | undefined;
let sent: Rec[];

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-scope-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("unexpected real transport"); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  release?.();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});

async function send(body: Rec, options: {
  oauth?: boolean; models?: string[]; providers?: string[]; configured?: boolean;
} = {}) {
  const name = options.oauth ? "anthropic" : "operator-anth";
  if (options.oauth) await saveCredential("anthropic", {
    access: "synthetic-advisor-scope-access", refresh: "synthetic-advisor-scope-refresh",
    expires: Date.now() + 3_600_000, accountId: "synthetic-advisor-scope-account", source: "oauth",
  });
  const transport = (async (_input, init) => {
    expect(new Headers(init?.headers).get("anthropic-beta")).toContain("advisor-tool-2026-03-01");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "msg_scope", type: "message", role: "assistant", model: EXECUTOR,
      content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 } });
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://api.anthropic.com", models: [EXECUTOR],
    authMode: options.oauth ? "oauth" : "key", apiKey: "synthetic-advisor-scope-key", fetch: transport,
    headers: { "anthropic-beta": "advisor-tool-2026-03-01,inline-tools-2026-09-15,mid-conversation-system-clear-at-2026-08-21" },
  };
  const config = { port: 0, defaultProvider: name, providers: { [name]: provider },
    anthropicAccountPool: { enabled: false },
    protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } },
    apiKeys: [{ id: "scoped", name: "fixture", key: "ocx_data_" + "b".repeat(40), createdAt: "2026-01-01T00:00:00.000Z",
      allowedModels: options.models ?? [EXECUTOR], allowedProviders: options.providers ?? [] }],
  } as OcxConfig;
  saveConfig(config);
  const source = { model: `${name}/${EXECUTOR}`, max_tokens: 64, stream: false, messages: [user], ...body };
  const snapshot = JSON.stringify(source);
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "advisor-tool-2026-03-01,inline-tools-2026-09-15" },
    body: snapshot,
  }), config, { model: "", provider: "" }, { requestId: crypto.randomUUID(), start: Date.now(),
    admission: options.configured === false ? { kind: "loopback", source: "loopback" }
      : { kind: "configured", keyId: "scoped", source: "bearer" } });
  expect(JSON.stringify(source)).toBe(snapshot);
  return { response, text: await response.text() };
}

describe("managed native Messages billed tool scope", () => {
  for (const oauth of [false, true]) {
    test(`denies a separate unlisted advisor destination before dispatch (OAuth=${oauth})`, async () => {
      const { response, text } = await send({ tools: [advisor()] }, { oauth });
      expect(response.status, text).toBe(403);
      expect(text).toContain("model_not_allowed_for_key");
      expect(sent).toHaveLength(0);
    });
    test(`denies an inline advisor declaration before dispatch (OAuth=${oauth})`, async () => {
      const { response, text } = await send({ tools: [custom], messages: [user, addition(advisor())] }, { oauth });
      expect(response.status, text).toBe(403);
      expect(sent).toHaveLength(0);
    });
    test(`an allowed advisor remains byte-equivalent on the wire (OAuth=${oauth})`, async () => {
      const tool = advisor();
      const { response, text } = await send({ tools: [tool] }, { oauth, models: [EXECUTOR, ADVISOR] });
      expect(response.status, text).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.tools).toEqual([tool]);
    });
    test(`clear_at never retains inline scope enforcement (OAuth=${oauth})`, async () => {
      const { response, text } = await send({ tools: [custom], messages: [user, { ...addition(advisor()), clear_at: "never" }] }, { oauth });
      expect(response.status, text).toBe(403);
      expect(sent).toHaveLength(0);
    });
    test(`a turn-scoped inline advisor declaration is refused defensively (OAuth=${oauth})`, async () => {
      const { response, text } = await send({ tools: [custom], messages: [user, { ...addition(advisor()), clear_at: "next_user_message" }] }, { oauth });
      expect(response.status, text).toBe(403);
      expect(sent).toHaveLength(0);
    });
  }

  test("clear_at never retains a legitimate removal", async () => {
    const { response, text } = await send({ tools: [advisor()], messages: [user, { ...reference("tool_removal"), clear_at: "never" }] });
    expect(response.status, text).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["unrestricted key", { models: [] }],
    ["provider-only key", { models: [], providers: ["operator-anth"] }],
    ["loopback admission", { configured: false }],
    ["operator-qualified model", { models: [EXECUTOR, `operator-anth/${ADVISOR}`] }],
  ])("preserves %s", async (_name, options) => {
    const { response, text } = await send({ tools: [advisor()] }, options);
    expect(response.status, text).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["removed top-level declaration", { tools: [advisor()], messages: [user, reference("tool_removal")] }],
    ["removed inline declaration", { tools: [custom], messages: [user, addition(advisor()), reference("tool_removal")] }],
    ["allowed replacement", { tools: [advisor()], messages: [user, addition(advisor(EXECUTOR))] }],
    ["completed historic result", { tools: [custom], messages: [user, { role: "assistant", content: [
      { type: "advisor_tool_result", tool_use_id: "srvtoolu_fixture", content: { type: "advisor_result", text: "historic advice" } },
    ] }, user] }],
    ["opaque custom schema", { tools: [{ ...custom, input_schema: { type: "object", properties: { example: advisor() } } }] }],
  ])("preserves %s without invoking a denied destination", async (_name, body) => {
    const { response, text } = await send(body);
    expect(response.status, text).toBe(200);
    expect(sent).toHaveLength(1);
  });

  test.each([
    ["re-offered tool", { tools: [advisor()], messages: [user, reference("tool_removal"), reference("tool_addition")] }],
    ["denied replacement", { tools: [advisor(EXECUTOR)], messages: [user, addition(advisor())] }],
    ["deferred declaration", { tools: [{ ...advisor(), defer_loading: true }] }],
    ["missing model", { tools: [{ type: "advisor_20260301", name: "advisor" }] }],
    ["nonstring model", { tools: [advisor(7)] }],
    ["temporary removal", { tools: [advisor()], messages: [user, { ...reference("tool_removal"), clear_at: "next_user_message" }] }],
    ["temporary re-offer", { tools: [advisor()], messages: [user, reference("tool_removal"), { ...reference("tool_addition"), clear_at: "next_user_message" }] }],
    ["temporary allowed replacement", { tools: [advisor()], messages: [user, { ...addition(advisor(EXECUTOR)), clear_at: "next_user_message" }] }],
    ["paused advisor resume", { tools: [advisor()], messages: [user, { role: "assistant", content: [
      { type: "server_tool_use", id: "srvtoolu_fixture", name: "advisor", input: {} },
    ] }] }],
  ])("denies %s", async (_name, body) => {
    const { response, text } = await send(body);
    expect(response.status, text).toBe(403);
    expect(sent).toHaveLength(0);
  });
});


// Count prefix traversal instead of timing a busy shared CI runner.
describe("temporary native tool declaration accumulation", () => {
  const scope = { providers: [], models: [EXECUTOR] };
  const blocks = (name: string, count: number) => Array.from({ length: count }, () => ({
    type: "tool_addition", tool: { type: "tool_definition", definition: { name } },
  }));

  test("same-name temporary additions do not rewalk the accumulated prefix", () => {
    const seed = Object.freeze({ name: "lookup" });
    const additions = blocks(seed.name, 1_024);
    const body = { tools: Object.freeze([seed]), messages: [{
      role: "system", clear_at: "next_user_message", content: additions,
    }] };
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!;
    let visits = 0;
    let denial: ReturnType<typeof nativeMessagesToolScopeDenial>;
    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, { ...descriptor,
        value: function(this: unknown[]) {
          const iterator = descriptor.value.call(this) as IterableIterator<unknown>;
          if (this[0] === seed) {
            const next = iterator.next.bind(iterator);
            iterator.next = () => {
              const item = next();
              if (!item.done) visits += 1;
              return item;
            };
          }
          return iterator;
        },
      });
      denial = nativeMessagesToolScopeDenial(scope, "operator-anth", EXECUTOR, body);
    } finally { Object.defineProperty(Array.prototype, Symbol.iterator, descriptor); }
    expect(denial).toBeUndefined();
    expect(visits).toBeLessThanOrEqual(3 * (additions.length + 1));
    expect(body.tools).toEqual([seed]);
  });

  test("large temporary chains retain a denied shadow without changing frozen inputs", () => {
    const denied = Object.freeze(advisor());
    const content = blocks("advisor", 2_048);
    for (const block of content) {
      Object.freeze(block.tool.definition); Object.freeze(block.tool); Object.freeze(block);
    }
    const temporary = Object.freeze({ role: "system", clear_at: "next_user_message", content: Object.freeze(content) });
    const body = Object.freeze({ tools: Object.freeze([denied]), messages: Object.freeze([temporary]) });
    const snapshot = JSON.stringify(body);
    expect(nativeMessagesToolScopeDenial(scope, "operator-anth", EXECUTOR, body)?.deniedModel).toBe(ADVISOR);
    expect(JSON.stringify(body)).toBe(snapshot);
    // A permanent replacement may remove that shadow; a temporary one may not.
    const permanent = { ...body, messages: [...body.messages, addition({ ...custom, name: "advisor" })] };
    expect(nativeMessagesToolScopeDenial(scope, "operator-anth", EXECUTOR, permanent)).toBeUndefined();
  });

  test("the production native handler preserves dense additions and rejects a denied tail", async () => {
    const content: Rec[] = blocks("lookup", 2_048);
    const message = { role: "system", clear_at: "next_user_message", content };
    const allowed = await send({ tools: [custom], messages: [user, message] });
    expect(allowed.response.status, allowed.text).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages).toEqual([user, message]);
    content.push({ type: "tool_addition", tool: { type: "tool_definition", definition: advisor() } });
    const denied = await send({ tools: [custom], messages: [user, message] });
    expect(denied.response.status, denied.text).toBe(403);
    expect(sent).toHaveLength(1);
  });
});
