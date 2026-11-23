import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createM365CopilotAdapter, clearM365CopilotConversations } from "../../src/adapters/m365-copilot";
import { M365_COPILOT_BASE_URL, M365_COPILOT_MODELS, getToneForModel, m365CopilotScenario } from "../../src/providers/m365-copilot-models";
import { createM365Conversation, M365TextComposer, m365SocketDialOptions, runM365CopilotTurn } from "../../src/adapters/m365-copilot/transport";
import { credentialPinnedProviderConfigError, modelAdapterRecordConfigError } from "../../src/config/provider-validation";
import { captureM365BrowserCode, m365CallbackCode } from "../../src/oauth/m365-copilot-browser";
import { m365CopilotAuthorizationUrl, M365_COPILOT_CLIENT_ID, m365CopilotClaims, refreshM365CopilotToken } from "../../src/oauth/m365-copilot";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { deriveProviderPresets } from "../../src/providers/derive";
import { isPublicOAuthProvider } from "../../src/oauth";
import { providerSupportsLiveModelDiscovery } from "../../src/providers/static-model-discovery";
import { parseToolAnswer, parseToolCalls } from "../../src/adapters/m365-copilot/tools";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

const token = () => "header." + Buffer.from(JSON.stringify({ oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature";
const provider = () => ({ adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL, apiKey: token(), authMode: "oauth" as const });
const rsFrame = (body: unknown) => JSON.stringify(body) + "\x1e";
const chatLoopback = (script: (send: (body: unknown) => void) => void) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: {
  message(ws, data) {
    const frame = JSON.parse(String(data).split("\x1e")[0]);
    if (frame.protocol) { ws.send(rsFrame({})); return; }
    if (frame.target === "chat") script(body => ws.send(rsFrame(body)));
  },
} });
const request = (): OcxParsedRequest => ({ modelId: "claude-sonnet", stream: true, options: {}, context: {
  messages: [{ role: "user", content: "Read /trial.txt", timestamp: 0 }],
  tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
} });
afterEach(clearM365CopilotConversations);

describe("Microsoft 365 Copilot registration and authentication", () => {
  test("offers the non-featured OAuth preset in Add provider", () => {
    expect(getProviderRegistryEntry("m365-copilot")?.featured).toBe(false);
    expect(deriveProviderPresets().find(preset => preset.id === "m365-copilot")).toMatchObject({
      label: "Microsoft 365 Copilot",
      auth: "oauth",
      oauthProvider: "m365-copilot",
      adapter: "m365-copilot",
    });
  });

  test("discovers account models separately from GitHub Copilot and retains legacy request aliases", () => {
    const entry = getProviderRegistryEntry("m365-copilot")!;
    expect(entry.authKind).toBe("oauth"); expect(isPublicOAuthProvider(entry.id)).toBe(true);
    expect(entry.models).toEqual([]);
    expect(providerSupportsLiveModelDiscovery(entry.id, provider())).toBe(true);
    expect(entry.liveModels).toBe(true); expect(getToneForModel("claude-sonnet")).toBe("Claude_Sonnet");
    expect(() => getToneForModel("not-a-model")).toThrow("Unknown");
    expect(() => getToneForModel("constructor")).toThrow("Unknown");
    expect(() => getToneForModel("__proto__")).toThrow("Unknown");
    expect(m365CopilotScenario("claude-opus").scenario).toBe("OfficeWebPaidCopilot");
    expect(m365CopilotScenario("claude-sonnet")).toEqual(m365CopilotScenario("Claude_Sonnet"));
    expect(m365CopilotScenario("Claude_Sonnet")).toMatchObject({ scenario: "OfficeWebPaidCopilot", licenseType: "Premium" });
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
  test("uses private inherited pipes with NUL-framed browser commands and replies", async () => {
    const oldSpawn = spyOn(Bun, "spawn").mockImplementation(args => {
      expect(args).toContain("--remote-debugging-pipe");
      throw new Error("Unexpected legacy browser launcher");
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, input, output], exitCode: null as number | null, kill() {
      child.exitCode = 0;
      child.emit("exit", 0);
      return true;
    } });
    const methods: string[] = [];
    let launch: { args: string[]; stdio: unknown } | undefined;
    const spawn = (_file: string, args: string[], options: { stdio: unknown }) => {
      launch = { args, stdio: options.stdio };
      return child;
    };
    input.on("data", (chunk: Buffer) => {
      const frame = chunk.toString();
      expect(frame.endsWith("\0")).toBe(true);
      const request = JSON.parse(frame.slice(0, -1));
      methods.push(request.method);
      const oid = "11111111-1111-1111-1111-111111111111", tid = "22222222-2222-2222-2222-222222222222";
      const result = request.method === "Target.createTarget" ? { targetId: "target" }
        : request.method === "Target.attachToTarget" ? { sessionId: "session" }
        : request.method === "Runtime.evaluate" ? { result: { value: oid + "@" + tid } }
        : request.method === "Network.getCookies" ? { cookies: [{ name: "OhpAuth", value: "fixture", domain: ".copilot.cloud.microsoft", path: "/", secure: true }] }
        : {};
      const reply = Buffer.from(JSON.stringify({ id: request.id, result }) + "\0");
      output.write(reply.subarray(0, 4));
      const callback = request.method === "Page.navigate" && request.params.url === "https://fixture.invalid/auth"
        ? Buffer.from(JSON.stringify({ method: "Fetch.requestPaused", sessionId: "session", params: { requestId: "fixture", request: { url: "https://login.microsoftonline.com/common/oauth2/nativeclient?state=state&code=fixture" } } }) + "\0")
        : Buffer.alloc(0);
      output.write(Buffer.concat([reply.subarray(4), callback]));
      if (request.method === "Browser.close") child.kill();
    });
    try {
      const deps = { executable: "/fixture/chrome", spawn } as NonNullable<Parameters<typeof captureM365BrowserCode>[3]>;
      const captured = await captureM365BrowserCode("https://fixture.invalid/auth", "state", {}, deps);
      expect(launch?.args).toContain("--remote-debugging-pipe");
      expect(launch?.args.some(arg => /^--remote-debugging-(port|address)/.test(arg))).toBe(false);
      expect(launch?.stdio).toEqual(["ignore", "ignore", "ignore", "pipe", "pipe"]);
      expect(captured).toMatchObject({ code: "fixture", m365: { cookie: "OhpAuth=fixture" } });
      expect(methods).toContain("Fetch.fulfillRequest");
      expect(methods.at(-1)).toBe("Browser.close");
    } finally { oldSpawn.mockRestore(); }
  });

  test("refuses managed Firefox with Chromium guidance before launch", async () => {
    const launch = spyOn(Bun, "serve").mockImplementation(() => { throw new Error("Unexpected local listener"); });
    try {
      await expect(captureM365BrowserCode("https://fixture.invalid/auth", "state", {}, { executable: "/fixture/firefox" }))
        .rejects.toThrow("Install Chrome, Chromium, or Edge on the proxy machine");
      expect(launch).not.toHaveBeenCalled();
    } finally { launch.mockRestore(); }
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
  const fixtureTools = [{ function: { name: "lookup", parameters: { properties: { query: { type: "string" } } } } }];
  const block = (name: string, body: string) => ["```" + name, body, "```"].join("\n");

  test("reuses the call IDs when the result marker follows the exact delivery text", () => {
    const text = [block("lookup", "one"), block("lookup", "two")].join("\n");
    const ids = spyOn(crypto, "randomUUID");
    try {
      const answer = parseToolAnswer(text + "<tool_response>example</tool_response>", fixtureTools);
      expect(answer).toMatchObject({ accepted: text, document: false, truncated: true });
      expect(answer.result.toolCalls.map(call => JSON.parse(call.function.arguments))).toEqual([{ query: "one" }, { query: "two" }]);
      expect(new Set(answer.result.toolCalls.map(call => call.id)).size).toBe(2);
      expect(ids).toHaveBeenCalledTimes(2);
    } finally { ids.mockRestore(); }
  });

  test("checks the original prefix before trimming text for delivery", () => {
    const first = block("lookup", "one"), second = block("lookup", "two");
    const marker = "<tool_response>example</tool_response>";
    const prose = first + "\u00a0" + marker;
    const untouched = parseToolAnswer(prose, fixtureTools);
    expect(untouched).toMatchObject({ accepted: prose, truncated: false });
    expect(untouched.result.toolCalls).toHaveLength(0);

    const accepted = first + "\n" + second;
    const both = parseToolAnswer(accepted + "\u00a0" + marker, fixtureTools);
    expect(both).toMatchObject({ accepted, truncated: true });
    expect(both.result.toolCalls.map(call => JSON.parse(call.function.arguments))).toEqual([{ query: "one" }, { query: "two" }]);
  });

  test("keeps an identical tool example nested in a document fence", () => {
    const call = block("lookup", "sample");
    const example = block("markdown", call);
    const answer = parseToolAnswer([example, "Then", call].join("\n"), fixtureTools);
    expect(answer.result.toolCalls).toHaveLength(1);
    expect(answer.result.textContent).toBe(example + "\nThen");
    const document = ["# Examples", call, call].join("\r\n");
    expect(parseToolAnswer(document, fixtureTools)).toMatchObject({ accepted: document, document: true, truncated: false });
  });

  test("preserves nested JSON in fenced calls and inline call precedence", () => {
    const args = { fields: [{ label: "one", tags: ["a"] }], text: "two" };
    const fence = block("tool_call", JSON.stringify({ name: "lookup", arguments: args }));
    const fenced = parseToolAnswer(fence, fixtureTools);
    expect(JSON.parse(fenced.result.toolCalls[0]!.function.arguments)).toEqual(args);
    const toolFence = block("tool_call", JSON.stringify({ tool: "lookup", arguments: { field: { key: "blue" } } }));
    const nested = parseToolAnswer(["Before", toolFence, "After"].join("\n"), fixtureTools);
    expect(nested.result.textContent).toBe("Before\n\nAfter");
    expect(JSON.parse(nested.result.toolCalls[0]!.function.arguments)).toEqual({ field: { key: "blue" } });
    const inline = JSON.stringify({ tool: "lookup", arguments: { query: "inline" } });
    const mixed = parseToolAnswer([inline, toolFence, fence].join("\n"), fixtureTools);
    expect(mixed.result.toolCalls.map(call => JSON.parse(call.function.arguments))).toEqual([{ query: "inline" }]);
    expect(mixed.result.textContent).toBeNull();
    const documentation = block("sql", "SELECT 1");
    expect(parseToolAnswer([documentation, block("json", inline)].join("\n"), fixtureTools).result.textContent).toBe(documentation);
  });

  test("retains YAML header values and separates repeated named fences by source position", () => {
    const tools = [{ function: { name: "lookup", parameters: { properties: { options: { type: "object" }, label: { type: "string" } } } } }];
    const fence = block("lookup", "options:\n  tags:\n    - blue\n    - green\nlabel: summary");
    const answer = parseToolAnswer([fence, "Next", fence].join("\n"), tools);
    expect(answer.document).toBe(false);
    expect(answer.result.textContent).toBe("Next");
    expect(answer.result.toolCalls.map(call => JSON.parse(call.function.arguments))).toEqual(
      Array(2).fill({ options: { tags: ["blue", "green"] }, label: "summary" }),
    );
  });

  test("keeps notes inside a tool_call wrapper without emitting the wrapper as a call", () => {
    const call = (query: string) => JSON.stringify({ tool: "lookup", arguments: { query } });
    const one = call("one"), two = call("two");
    for (const [body, expected] of [
      [[one, "Keep this note.", two].join("\n"), "Keep this note."],
      [["Opening note.", one, two, "Closing note."].join("\r\n"), "Opening note.\r\n\r\n\r\nClosing note."],
    ] as const) {
      const answer = parseToolAnswer(block("tool_call", body), fixtureTools);
      expect(answer.result.toolCalls.map(tool => JSON.parse(tool.function.arguments).query)).toEqual(["one", "two"]);
      expect(answer.result.textContent).toBe(expected);
      expect(answer.document).toBe(false);
    }
  });

  test("preserves unaccepted JSON text alongside real calls without changing eligibility", () => {
    const call = JSON.stringify({ tool: "lookup", arguments: { query: "one" } });
    const example = '{"tool":"lookup","arguments":{"query":"' + "a".repeat(300) + '",}}';
    const answer = parseToolAnswer([call, example, call].join("\n"), fixtureTools);
    expect(answer.result.textContent).toBe(example);
    expect(answer.result.toolCalls).toHaveLength(2);
    expect(answer.document).toBe(false);
    const note = '{"memo":"Keep this note."}';
    expect(parseToolAnswer([call, block("tool_call", note)].join("\n"), fixtureTools).result.textContent).toBe(note);
  });

  test("stripping a mixed tool_call wrapper keeps its line endings and indentation", () => {
    const call = JSON.stringify({ tool: "lookup", arguments: { query: "one" } });
    for (const eol of ["\n", "\r\n"]) {
      const answer = ["Before", "  ```tool_call  ", call, "  Keep the note.", call, "  ```  ", "After"].join(eol);
      const expected = ["Before", "    ", "", "  Keep the note.", "", "    ", "After"].join(eol);
      expect(parseToolAnswer(answer, fixtureTools).result.textContent).toBe(expected);
    }
  });

  test("JSON call eligibility keeps its document threshold when Markdown display changes", () => {
    const call = JSON.stringify({ tool: "lookup", arguments: { query: "one" } });
    const prose = "a".repeat(289) + "\n" + block("sql", "q");
    const actionable = parseToolAnswer([prose, call, call].join("\n"), fixtureTools);
    expect(actionable.result.textContent).toBe(prose);
    expect(prose.length).toBeGreaterThanOrEqual(300);
    expect(actionable.document).toBe(false);

    const intro = "a".repeat(299);
    const example = block("tool_call", JSON.stringify({ tool: "lookup", arguments: { options: { label: "blue" } } }));
    const document = parseToolAnswer([intro, call, call, example].join("\n"), fixtureTools);
    expect(document.result.textContent).toBe(intro);
    expect(document.document).toBe(true);
  });

  test("a named fence repeated in documentation keeps the original document decision", () => {
    const first = block("lookup", "one");
    const example = block("markdown", first);
    const document = [example, "a".repeat(265), first, block("lookup", "two")].join("\n");
    const answer = parseToolAnswer(document, fixtureTools);
    expect(answer.result.textContent).toBe(example + "\n" + "a".repeat(265));
    expect(answer.result.textContent?.length).toBe(299);
    expect(answer.document).toBe(true);
    const headingExample = ["```markdown", first + "# Notes", "```", "```", first, block("lookup", "two")].join("\n");
    const heading = parseToolAnswer(headingExample, fixtureTools);
    expect(heading.result.toolCalls).toHaveLength(2);
    expect(heading.result.textContent).not.toMatch(/^#{1,6}\s/m);
    expect(heading.document).toBe(true);
  });

  test("a result marker in plain prose does not truncate a later call", () => {
    const answer = parseToolAnswer("About <tool_result> formatting\n" + block("lookup", "test"), fixtureTools);
    expect(answer.truncated).toBe(false);
    expect(answer.result.textContent).toBe("About <tool_result> formatting");
  });

  test("invalid tool JSON remains text instead of becoming a client execution", () => {
    const malformed = '{"tool":"read_file","arguments":invalid}';
    const result = parseToolCalls(malformed);
    expect(result.hasToolCalls).toBe(false);
    expect(result.textContent).toContain(malformed);
  });
  test("reports socket cleanup failure without leaking the underlying error", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: {
      message(ws, data) {
        const frame = JSON.parse(String(data).split("\x1e")[0]);
        if (frame.protocol) ws.send('{}\x1e');
        else if (frame.target === "chat") { ws.send('{"type":1,"target":"update","arguments":[{"messages":[{"author":"bot","messageId":"fixture","text":"ok"}]}]}\x1e'); ws.send('{"type":2,"item":{"result":{"value":"Success"}}}\x1e'); }
      },
    } });
    try {
      await expect(runM365CopilotTurn({ token: token(), model: "Claude_Sonnet", text: "fixture", conversation: createM365Conversation(), onText() {}, createSocket() {
        const socket = new WebSocket("ws://127.0.0.1:" + server.port), close = socket.close.bind(socket);
        socket.close = () => { close(); throw new Error("fixture-private-transport-detail"); };
        return socket;
      } })).rejects.toThrow("connection cleanup failed");
    } finally { server.stop(true); }
  });
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
  test("fails the turn when an earlier streamed message changes after a later one started", async () => {
    const server = chatLoopback(send => {
      send({ type: 1, target: "update", arguments: [{ cursor: { j: "$['first'].adaptiveCards[0]" }, messages: [{ author: "bot", messageId: "first", text: "Hello" }] }] });
      send({ type: 1, target: "update", arguments: [{ cursor: { j: "$['second'].adaptiveCards[0]" }, messages: [{ author: "bot", messageId: "second", text: "Second" }] }] });
      send({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageId: "first", text: "Hello again" }] }] });
    });
    try {
      await expect(runM365CopilotTurn({ token: token(), model: "Claude_Sonnet", text: "fixture", conversation: createM365Conversation(), onText() {}, createSocket: () => new WebSocket("ws://127.0.0.1:" + server.port) }))
        .rejects.toThrow("changed previously emitted text");
    } finally { server.stop(true); }
  });
  test("fails the turn when the terminal snapshot rewrites already streamed text", async () => {
    const server = chatLoopback(send => {
      send({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageId: "first", text: "Hello" }] }] });
      send({ type: 2, item: { messages: [{ author: "bot", messageId: "first", text: "Jello world" }], result: { value: "Success" } } });
    });
    try {
      await expect(runM365CopilotTurn({ token: token(), model: "Claude_Sonnet", text: "fixture", conversation: createM365Conversation(), onText() {}, createSocket: () => new WebSocket("ws://127.0.0.1:" + server.port) }))
        .rejects.toThrow("changed previously emitted text");
    } finally { server.stop(true); }
  });
  test("replays chain-of-thought summaries once and emits only the growing suffix", async () => {
    const thinking: string[] = [];
    const server = chatLoopback(send => {
      const summary = (text: string) => ({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageType: "ChainOfThoughtSummary", messageId: "think", text }] }] });
      send(summary("Step one")); send(summary("Step one")); send(summary("Step one and two"));
      send({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageId: "answer", text: "Answer" }] }] });
      send({ type: 2, item: { result: { value: "Success" } } });
    });
    try {
      const answer = await runM365CopilotTurn({ token: token(), model: "Claude_Sonnet", text: "fixture", conversation: createM365Conversation(), onText() {}, onThinking: text => thinking.push(text), createSocket: () => new WebSocket("ws://127.0.0.1:" + server.port) });
      expect(answer).toBe("Answer");
      expect(thinking).toEqual(["Step one", " and two"]);
    } finally { server.stop(true); }
  });
  test("caps keyed reasoning rows instead of retaining an unbounded map", async () => {
    const server = chatLoopback(send => {
      for (let index = 0; index < 257; index++) send({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", messageType: "ChainOfThoughtSummary", messageId: "think-" + index, text: "step " + index }] }] });
    });
    try {
      await expect(runM365CopilotTurn({ token: token(), model: "Claude_Sonnet", text: "fixture", conversation: createM365Conversation(), onText() {}, onThinking() {}, createSocket: () => new WebSocket("ws://127.0.0.1:" + server.port) }))
        .rejects.toThrow("too many messages");
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
  test("validates every returned call before emitting partial output", async () => {
    const fence = String.fromCharCode(96).repeat(3);
    // A fenced call may carry a non-JSON arguments string; nothing may be emitted before it is validated.
    const adapter = createM365CopilotAdapter(provider(), { turn: async () => ["Here you go", fence + "tool_call", JSON.stringify({ tool: "read_file", arguments: "{not-json" }), fence].join("\n") });
    const events: AdapterEvent[] = [];
    const budget = createTranslatorBudget();
    try {
      await adapter.runTurn!(request(), { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
      expect(events.some(event => event.type === "text_delta")).toBe(false);
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      expect(events.find(event => event.type === "error")).toMatchObject({ type: "error", message: "Microsoft 365 Copilot returned invalid tool arguments" });
    } finally { budget.dispose(); }
  });
  test("an undeclared second call prevents all client output in the batch", async () => {
    const answer = ["Notes", JSON.stringify({ tool: "read_file", arguments: { path: "sample.txt" } }),
      JSON.stringify({ tool: "other", arguments: {} })].join("\n");
    const adapter = createM365CopilotAdapter(provider(), { turn: async () => answer });
    const events: AdapterEvent[] = [];
    const budget = createTranslatorBudget();
    try {
      await adapter.runTurn!(request(), { headers: new Headers(), translatorBudget: budget }, event => events.push(event));
      expect(events.some(event => event.type === "text_delta" || event.type === "tool_call_start")).toBe(false);
      expect(events.find(event => event.type === "error")).toMatchObject({ message: "Microsoft 365 Copilot returned an undeclared tool" });
    } finally { budget.dispose(); }
  });
  test("isolates a shared conversation prefix by authenticated caller and resolved conversation", async () => {
    const ids: string[] = [];
    const adapter = createM365CopilotAdapter(provider(), { turn: async options => {
      ids.push(options.conversation.conversationId);
      return "fixture";
    } });
    const budget = createTranslatorBudget();
    const headers = new Headers({ session_id: "shared" });
    const run = (principal: string | undefined, thread: string | undefined, count: number) => {
      const parsed = request();
      if (thread) parsed._reasoningReplayScope = { clientThreadId: thread, clientPrincipalId: principal };
      for (let i = 1; i < count; i++) parsed.context.messages.push({ role: "user", content: "Follow up " + i, timestamp: i });
      return adapter.runTurn!(parsed, { headers, translatorBudget: budget }, () => {});
    };
    try {
      await run("caller-a", "thread-a", 1);
      await run("caller-b", "thread-a", 2);
      await run("caller-a", "thread-a", 3);
      await run("caller-a", "thread-b", 4);
      await run(undefined, "thread-a", 5);
      await run(undefined, "thread-a", 6);
      await run("caller-a", undefined, 7);
      await run("caller-a", undefined, 8);
      expect(ids[1]).not.toBe(ids[0]);
      expect(ids[2]).toBe(ids[0]);
      expect(new Set(ids).size).toBe(7);
    } finally { budget.dispose(); }
  });

  test("rotation while queued prevents a socket upgrade with the old credential", async () => {
    let current = true;
    let active!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { active = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let turns = 0;
    let dials = 0;
    const adapter = createM365CopilotAdapter(provider(), { turn: async options => {
      if (++turns === 1) { active(); await held; return "fixture"; }
      return runM365CopilotTurn({ ...options, createSocket: () => { dials++; throw new Error("Fixture dial"); } });
    } });
    const budget = createTranslatorBudget();
    const parsed = request();
    parsed._reasoningReplayScope = { clientThreadId: "thread", clientPrincipalId: "caller" };
    const check = () => { if (!current) throw new Error("fixture credential was rotated"); };
    const incoming = { headers: new Headers({ session_id: "thread" }), translatorBudget: budget, beforePhysicalSend: check, beforeCredentialSend: check };
    try {
      const first = adapter.runTurn!(parsed, incoming, () => {});
      await entered;
      const next = request();
      next._reasoningReplayScope = parsed._reasoningReplayScope;
      next.context.messages.push({ role: "user", content: "Follow up", timestamp: 1 });
      const second = adapter.runTurn!(next, incoming, () => {});
      const outcome = second.then(() => undefined, (error: unknown) => error);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(dials).toBe(0);
      current = false;
      release();
      await first;
      const error = await outcome;
      expect(dials).toBe(0);
      expect(error).toEqual(new Error("fixture credential was rotated"));
    } finally { release(); budget.dispose(); }
  });

  test("preserves client tool calls and uses the returned tool result on the same conversation", async () => {
    const turns: any[] = [];
    const adapter = createM365CopilotAdapter(provider(), { turn: async options => {
      options.beforeSend?.(); turns.push({ conversation: options.conversation.conversationId, prompt: options.text });
      const fence = String.fromCharCode(96).repeat(3);
      return turns.length === 1 ? [fence + "read_file", "/trial.txt", fence].join(String.fromCharCode(10)) : "The tool returned fixture-result";
    } });
    const parsed = request(); const first: AdapterEvent[] = [];
    parsed._reasoningReplayScope = { clientThreadId: "thread", clientPrincipalId: "caller" };
    const budget = createTranslatorBudget(); const meta = { headers: new Headers(), translatorBudget: budget };
    try {
      await adapter.runTurn!(parsed, meta, event => first.push(event));
      const start = first.find(event => event.type === "tool_call_start")!;
      expect(start).toMatchObject({ type: "tool_call_start", name: "read_file" });
      expect(first.find(event => event.type === "tool_call_delta")).toMatchObject({ arguments: '{"path":"/trial.txt"}' });
      expect(first.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false, usage: { estimated: true } });
      const usage = (first.at(-1) as Extract<AdapterEvent, { type: "done" }>).usage!;
      expect(usage.inputTokens).toBeGreaterThan(0); expect(usage.outputTokens).toBeGreaterThan(0);
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

describe("Microsoft 365 Copilot credential pinning", () => {
  test("rejects a retargeted row, a foreign adapter and model wire overrides", () => {
    expect(credentialPinnedProviderConfigError("m365-copilot", { adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL })).toBeNull();
    expect(credentialPinnedProviderConfigError("m365-copilot", { adapter: "m365-copilot" })).toBeNull();
    expect(credentialPinnedProviderConfigError("m365-copilot", { adapter: "openai-chat", baseUrl: "https://evil.example" })).toContain("adapter must stay");
    expect(credentialPinnedProviderConfigError("m365-copilot", { adapter: "m365-copilot", baseUrl: "https://evil.example/v1" })).toContain("baseUrl must stay");
    expect(modelAdapterRecordConfigError({ "claude-sonnet": "openai-chat" }, "modelAdapters", "m365-copilot", { adapter: "m365-copilot", baseUrl: M365_COPILOT_BASE_URL }))
      .toContain("cannot be overridden");
  });
});

describe("Microsoft 365 Copilot socket egress", () => {
  const socketUrl = "wss://substrate.office.com/m365Copilot/Chathub/oid@tid?access_token=fixture";
  const headers = { Origin: "https://m365.cloud.microsoft" };
  test("applies the provider route to the ChatHub socket", () => {
    expect(m365SocketDialOptions({ proxy: "http://127.0.0.1:9" }, socketUrl, headers).proxy).toBe("http://127.0.0.1:9/");
    expect(() => m365SocketDialOptions({ proxy: "socks5://127.0.0.1:9" }, socketUrl, headers)).toThrow("supports only HTTP(S) proxies");
    expect(m365SocketDialOptions({ proxy: "direct" }, socketUrl, headers).proxy).toBeUndefined();
    expect(m365SocketDialOptions({ proxy: "http://127.0.0.1:9", noProxy: ["substrate.office.com"] }, socketUrl, headers).proxy).toBeUndefined();
    expect(m365SocketDialOptions(undefined, socketUrl, headers).proxy).toBeUndefined();
  });
  test("inherit adopts the global proxy decision Bun's WebSocket would otherwise ignore", () => {
    const previous = process.env.HTTPS_PROXY, previousNoProxy = process.env.NO_PROXY, previousLowerNoProxy = process.env.no_proxy;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    // An inherited bypass entry would select a direct connection and fail this assertion for the wrong reason.
    delete process.env.NO_PROXY; delete process.env.no_proxy;
    try {
      expect(m365SocketDialOptions({}, socketUrl, headers).proxy).toBe("http://127.0.0.1:9");
      expect(m365SocketDialOptions({ noProxy: ["substrate.office.com"] }, socketUrl, headers).proxy).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previousNoProxy;
      if (previousLowerNoProxy === undefined) delete process.env.no_proxy; else process.env.no_proxy = previousLowerNoProxy;
    }
  });
  test("refuses a custom fetch executor and a malformed route before dialing", () => {
    expect(() => m365SocketDialOptions({ fetch: globalThis.fetch }, socketUrl, headers)).toThrow("cannot use a custom fetch executor");
    expect(() => m365SocketDialOptions({ proxy: "" }, socketUrl, headers)).toThrow(/providers[.]m365-copilot[.]proxy is invalid/);
  });
  test("inherited proxy respects the global bypass list without overriding an explicit provider proxy", () => {
    const previousProxy = process.env.HTTPS_PROXY, previousNoProxy = process.env.NO_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.NO_PROXY = "substrate.office.com";
    try {
      expect(m365SocketDialOptions({}, socketUrl, headers).proxy).toBeUndefined();
      expect(m365SocketDialOptions({ proxy: "http://127.0.0.1:9" }, socketUrl, headers).proxy).toBe("http://127.0.0.1:9/");
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previousProxy;
      if (previousNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previousNoProxy;
    }
  });
});
