import { afterEach, describe, expect, test } from "bun:test";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { M365_COPILOT_BASE_URL, M365_COPILOT_MODELS, getToneForModel, m365CopilotScenario } from "../../src/providers/m365-copilot-models";
import { createM365Conversation, M365TextComposer, runM365CopilotTurn } from "../../src/adapters/m365-copilot/transport";
import { m365CallbackCode } from "../../src/oauth/m365-copilot-browser";
import { m365CopilotAuthorizationUrl, M365_COPILOT_CLIENT_ID, m365CopilotClaims, refreshM365CopilotToken } from "../../src/oauth/m365-copilot";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { isPublicOAuthProvider } from "../../src/oauth";
import { providerSupportsLiveModelDiscovery } from "../../src/providers/static-model-discovery";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

const token = () => "header." + Buffer.from(JSON.stringify({ oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature";
const provider = () => ({ adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL, apiKey: token(), authMode: "oauth" as const });
const request = (): OcxParsedRequest => ({ modelId: "claude-sonnet", stream: true, options: {}, context: {
  messages: [{ role: "user", content: "Read /trial.txt", timestamp: 0 }],
  tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
} });
afterEach(clearM365CopilotConversations);

describe("Microsoft 365 Copilot registration and authentication", () => {
  test("publishes maintained aliases separately from GitHub Copilot", () => {
    const entry = getProviderRegistryEntry("m365-copilot")!;
    expect(entry.authKind).toBe("oauth"); expect(isPublicOAuthProvider(entry.id)).toBe(true);
    expect(entry.models).toEqual(M365_COPILOT_MODELS); expect(entry.models).toHaveLength(34);
    expect(providerSupportsLiveModelDiscovery(entry.id, provider())).toBe(false);
    expect(entry.liveModels).toBe(false); expect(getToneForModel("claude-sonnet")).toBe("Claude_Sonnet");
    expect(() => getToneForModel("not-a-model")).toThrow("Unknown");
    expect(() => getToneForModel("constructor")).toThrow("Unknown");
    expect(() => getToneForModel("__proto__")).toThrow("Unknown");
    expect(m365CopilotScenario("claude-opus").scenario).toBe("OfficeWebPaidCopilot");
    expect(m365CopilotScenario("gpt-6.1-sol").scenario).toBe("OfficeWebIncludedCopilot");
  });
  test("binds PKCE to Microsoft's fixed native-client callback", () => {
    const url = new URL(m365CopilotAuthorizationUrl("challenge", "state"));
    expect(url.origin).toBe("https://login.microsoftonline.com");
    expect(url.searchParams.get("client_id")).toBe(M365_COPILOT_CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("redirect_uri")).toBe("https://login.microsoftonline.com/common/oauth2/nativeclient");
  });
  test("rejects wrong state and foreign callback origins without echoing credentials", () => {
    const callback = "https://login.microsoftonline.com/common/oauth2/nativeclient?code=fixture&state=expected";
    expect(m365CallbackCode(callback, "expected")).toBe("fixture");
    expect(() => m365CallbackCode(callback, "different")).toThrow("state mismatch");
    expect(m365CallbackCode(callback.replace("login.microsoftonline.com", "example.invalid"), "expected")).toBeUndefined();
    expect(() => m365CopilotClaims("bad-token")).toThrow("invalid work-account token");
  });
  test("refreshes through Microsoft and preserves a refresh token when no replacement is returned", async () => {
    const previous = globalThis.fetch;
    let grant: URLSearchParams | undefined;
    globalThis.fetch = (async (url, options) => {
      expect(String(url)).toBe("https://login.microsoftonline.com/organizations/oauth2/v2.0/token");
      grant = options?.body as URLSearchParams;
      return Response.json({ access_token: token() });
    }) as typeof fetch;
    try {
      const credential = await refreshM365CopilotToken("fixture-refresh");
      expect(credential.refresh).toBe("fixture-refresh");
      expect(grant?.get("grant_type")).toBe("refresh_token");
      expect(grant?.get("scope")).toContain("M365Chat.Read");
      expect(grant?.get("scope")).not.toContain("powerplatform");
      expect(credential.expires).toBeGreaterThan(Date.now());
    } finally { globalThis.fetch = previous; }
  });
  test("does not expose token-endpoint bodies on a failed refresh", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ error: "invalid_grant", error_description: "fixture-private-material" }, { status: 400 })) as typeof fetch;
    try {
      await expect(refreshM365CopilotToken("fixture-refresh")).rejects.toThrow("OAuth invalid_grant");
    } finally { globalThis.fetch = previous; }
  });
});

describe("Microsoft 365 Copilot native transport", () => {
  test("reassembles distinct streamed messages without dropping their heads", () => {
    const text = new M365TextComposer();
    text.cursor("first"); text.snapshot("first", "Hello"); text.delta(" world");
    text.cursor("second"); text.snapshot("second", "Second"); text.delta(" message");
    expect(text.text).toBe("Hello world\n\nSecond message");
  });
  test("handles SignalR heartbeat, partial frames, completion and temporary conversations", async () => {
    let chatArguments: any;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: {
      message(ws, data) {
        const frame = JSON.parse(String(data).split("\x1e")[0]);
        if (frame.protocol) { ws.send('{"type":6}\x1e{}\x1e'); return; }
        if (frame.target !== "chat") return;
        chatArguments = frame.arguments[0];
        ws.send('{"type":1,"target":"update","arguments":[{"cursor":{"j":"$[\'first\'].adaptiveCards[0]"},"messages":[{"author":"bot","messageId":"first","text":"Hello"}]}]}\x1e');
        ws.send('{"type":1,"target":"update","arguments":[{"writeAtCursor":" world"}]}\x1e');
        ws.send('{"type":2,"item":{"result":{"value":"Success"}}}'); ws.send('\x1e');
      },
    } });
    const deltas: string[] = [];
    let sends = 0;
    try {
      const answer = await runM365CopilotTurn({ token: token(), model: "claude-sonnet", text: "hello", conversation: createM365Conversation(), onText: text => deltas.push(text), beforeSend: () => sends++,
        createSocket(url, headers) {
          expect(new URL(url).hostname).toBe("substrate.office.com"); expect(new URL(url).searchParams.get("disableMemory")).toBe("1");
          expect(headers["X-RoutingParameter-SessionKey"]).toBeTruthy(); return new WebSocket("ws://127.0.0.1:" + server.port);
        } });
      expect(answer).toBe("Hello world"); expect(deltas.join("")).toBe(answer); expect(sends).toBe(1);
      expect(chatArguments.threadLevelGptId).toEqual({}); expect(chatArguments.gpts).toBeUndefined();
    } finally { server.stop(true); }
  });
});

describe("Microsoft 365 Copilot adapter", () => {
  test("restores namespaced freeform patch calls for the client", async () => {
    const patch = ["*** Begin Patch", "*** Add File: fixture.txt", "+fixture", "*** End Patch"].join("\n");
    const fence = String.fromCharCode(96).repeat(3);
    const adapter = createM365CopilotAdapter(provider(), { turn: async () => [fence + "functions__apply_patch", patch, fence].join("\n") });
    const parsed = request();
    parsed.context.tools = [{ name: "apply_patch", namespace: "functions", description: "Apply a local patch", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] }, freeform: true }];
    const events: AdapterEvent[] = [];
    const budget = createTranslatorBudget();
    try {
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
      expect(events.find(event => event.type === "tool_call_start")).toMatchObject({ name: "functions__apply_patch" });
      expect(events.find(event => event.type === "tool_call_delta")).toMatchObject({ arguments: patch });
    } finally { budget.dispose(); }
  });
  test("honors a client request that forbids tools", async () => {
    const fence = String.fromCharCode(96).repeat(3);
    const adapter = createM365CopilotAdapter(provider(), { turn: async () => [fence + "read_file", "/trial.txt", fence].join("\n") });
    const parsed = request(); parsed.options.toolChoice = "none";
    const events: AdapterEvent[] = [];
    const budget = createTranslatorBudget();
    try {
      await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
    } finally { budget.dispose(); }
  });
  test("preserves client tool calls and uses the returned tool result on the same conversation", async () => {
    const turns: any[] = [];
    const adapter = createM365CopilotAdapter(provider(), { turn: async options => {
      options.beforeSend?.(); turns.push({ conversation: options.conversation.conversationId, prompt: options.text });
      const fence = String.fromCharCode(96).repeat(3);
      return turns.length === 1 ? [fence + "read_file", "/trial.txt", fence].join(String.fromCharCode(10)) : "The tool returned fixture-result";
    } });
    const parsed = request(); const first: AdapterEvent[] = [];
    const budget = createTranslatorBudget(); const meta = { headers: new Headers(), translatorBudget: budget };
    try {
      await adapter.runTurn!(parsed, meta, event => first.push(event));
      const start = first.find(event => event.type === "tool_call_start")!;
      expect(start).toMatchObject({ type: "tool_call_start", name: "read_file" });
      expect(first.find(event => event.type === "tool_call_delta")).toMatchObject({ arguments: '{"path":"/trial.txt"}' });
      expect(first.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false });
      const id = (start as Extract<AdapterEvent, { type: "tool_call_start" }>).id;
      parsed.context.messages.push({ role: "assistant", content: [], toolCalls: [{ id, name: "read_file", arguments: { path: "/trial.txt" } }], timestamp: 1 });
      parsed.context.messages.push({ role: "toolResult", toolCallId: id, toolName: "read_file", content: [{ type: "text", text: "fixture-result" }], isError: false, timestamp: 2 });
      const second: AdapterEvent[] = []; await adapter.runTurn!(parsed, meta, event => second.push(event));
      expect(turns[1].conversation).toBe(turns[0].conversation); expect(turns[1].prompt).toContain("fixture-result");
      expect(second).toContainEqual({ type: "text_delta", text: "The tool returned fixture-result" });
    } finally { budget.dispose(); }
  });
  test("refuses foreign credential destinations and aborted turns", async () => {
    const budget = createTranslatorBudget();
    try {
      const adapter = createM365CopilotAdapter({ ...provider(), baseUrl: "https://example.invalid" });
      await expect(adapter.runTurn!(request(), { headers: new Headers(), translatorBudget: budget }, () => {})).rejects.toThrow("fixed Microsoft endpoint");
      const abort = new AbortController(); abort.abort(); let called = false;
      const cancelled = createM365CopilotAdapter(provider(), { turn: async () => { called = true; return "bad"; } });
      await expect(cancelled.runTurn!(request(), { headers: new Headers(), translatorBudget: budget, abortSignal: abort.signal }, () => {})).rejects.toThrow();
      expect(called).toBe(false);
    } finally { budget.dispose(); }
  });
});
