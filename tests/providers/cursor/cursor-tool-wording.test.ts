import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema, BackgroundShellSpawnArgsSchema, DeleteArgsSchema, ExecServerMessageSchema,
  FetchArgsSchema, GrepArgsSchema, LsArgsSchema, ReadArgsSchema, ShellArgsSchema, WriteArgsSchema, WriteShellStdinArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { createCursorAdapter } from "../../../src/adapters/cursor";
import { CURSOR_ROUTING_COMMENTARY_RETRY_TEXT } from "../../../src/adapters/cursor/envelope-echo";
import { createLiveCursorTransport } from "../../../src/adapters/cursor/live-transport";
import { cursorBlobTextForEstimate, cursorNativeExecRedirectHint, handleCursorNativeExec, resetCursorBlobStateForTests, type CursorNativeExecContext } from "../../../src/adapters/cursor/native-exec";
import { nativeShellDisabledMessage } from "../../../src/adapters/cursor/native-exec-shell";
import { encodeCursorRunRequest } from "../../../src/adapters/cursor/protobuf-request";
import { createCursorRequest } from "../../../src/adapters/cursor/request-builder";
import { buildCursorToolGuidanceSystemNote } from "../../../src/adapters/cursor/tool-guidance";
import { buildCursorToolDefinitions } from "../../../src/adapters/cursor/tool-definitions";
import { CURSOR_TOOL_CALL_CONTINUATION, cursorUsesPlainToolWording } from "../../../src/adapters/cursor/tool-wording";
import { parseRequest } from "../../../src/responses/parser";
import type { CursorRunRequest, CursorServerMessage } from "../../../src/adapters/cursor/types";
import type { AdapterEvent } from "../../../src/types";
import legacy from "../../fixtures/cursor-tool-wording.json";
import { createTestTranslatorBudget } from "../../helpers/translator-budget";

const CONCEALMENT = /do not (narrate|comment|mention|re-announce)|commentary is forbidden|must not appear in your output/i;
const CLAUDE_MODELS = ["claude-sonnet-5-5", "cursor/claude-4.6-opus-high", "claude-opus-5-thinking-high-fast", "claude-4.5-haiku", "claude-fable-5", "claude-4-sonnet-1m"];
const OTHER_MODELS = [undefined, "cursor-grok-4.6-high", "cursor/gpt-5", "gemini-3-pro", "composer-2.5", "cursor/auto", "default", "not-claude-sonnet"];
const CLAUDE_CLIENT_CATALOGS = [
  { names: ["Bash", "Read"], wireNames: ["Bash", "Read"] },
  { names: ["Read", "exec_command"], wireNames: ["ocx_client_Read", "exec_command"] },
  { names: ["exec_command", "Read"], wireNames: ["exec_command", "ocx_client_Read"] },
];

function execMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 1, execId: "wording-test", message });
}
function refusalTexts(bytes: Uint8Array[]): string[] {
  const texts: string[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (["error", "reason", "stderr", "data"].includes(key) && typeof entry === "string" && entry) texts.push(entry);
      else visit(entry);
    }
  }
  for (const reply of bytes) visit(fromBinary(AgentClientMessageSchema, reply));
  expect(texts.length).toBeGreaterThan(0);
  return texts;
}
const frames = {
  read: execMessage({ case: "readArgs", value: create(ReadArgsSchema, { path: "fixture.txt" }) }),
  ls: execMessage({ case: "lsArgs", value: create(LsArgsSchema, { path: "fixture-dir" }) }),
  grep: execMessage({ case: "grepArgs", value: create(GrepArgsSchema, { path: "fixture-dir", pattern: "fixture" }) }),
  write: execMessage({ case: "writeArgs", value: create(WriteArgsSchema, { path: "fixture.txt", fileText: "unwritten" }) }),
  delete: execMessage({ case: "deleteArgs", value: create(DeleteArgsSchema, { path: "fixture.txt" }) }),
  shell: execMessage({ case: "shellArgs", value: create(ShellArgsSchema, { command: "echo fixture" }) }),
  stream: execMessage({ case: "shellStreamArgs", value: create(ShellArgsSchema, { command: "echo fixture" }) }),
  background: execMessage({ case: "backgroundShellSpawnArgs", value: create(BackgroundShellSpawnArgsSchema, { command: "echo fixture" }) }),
  stdin: execMessage({ case: "writeShellStdinArgs", value: create(WriteShellStdinArgsSchema, { shellId: 1, chars: "fixture" }) }),
  fetch: execMessage({ case: "fetchArgs", value: create(FetchArgsSchema, { url: "https://example.com" }) }),
};

afterEach(() => resetCursorBlobStateForTests());

describe("Cursor target-specific tool wording", () => {
  test.each(CLAUDE_CLIENT_CATALOGS)("Claude redirect matches the request catalog: %j", ({ names, wireNames }) => {
    const tools = names.map(name => ({ name, description: "Fixture tool", parameters: {} }));
    const definitions = buildCursorToolDefinitions(tools);
    expect(definitions.map(tool => tool.name)).toEqual(wireNames);
    const hint = cursorNativeExecRedirectHint(tools, [], "claude-sonnet-5-5")!;
    expect(hint.match(/Available tools in this request's catalog: (.*?)\. /)?.[1])
      .toBe(wireNames.map(name => `\`${name}\``).join(", "));
    const guidance = buildCursorToolGuidanceSystemNote(tools, undefined, "claude-sonnet-5-5")!;
    for (const name of wireNames) expect(guidance).toContain(`\`${name}\``);
  });
  test.each(CLAUDE_CLIENT_CATALOGS)("Claude live transport prepares the request catalog: %j", async ({ names, wireNames }) => {
    const transport = createLiveCursorTransport({ provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "fixture-token" },
      translatorBudget: createTestTranslatorBudget(), headers: new Headers() });
    const internal = transport as unknown as { open(bytes: Uint8Array): void; execContext: CursorNativeExecContext };
    let preparedBytes: Uint8Array | undefined;
    internal.open = bytes => { preparedBytes = bytes; throw new Error("catalog fixture stops before network"); };
    try {
      const request: CursorRunRequest = { modelId: "claude-sonnet-5-5", conversationId: "catalog-fixture", system: [],
        messages: [{ role: "user", content: "Inspect the project." }],
        tools: names.map(name => ({ name, description: "Fixture tool", parameters: {} })) };
      await expect(transport.run(request)[Symbol.asyncIterator]().next()).rejects.toThrow("catalog fixture stops before network");
      expect(preparedBytes).toBeDefined();
      const decoded = fromBinary(AgentClientMessageSchema, preparedBytes!);
      if (decoded.message.case !== "runRequest") throw new Error("Expected runRequest");
      expect(decoded.message.value.mcpTools?.mcpTools.map(tool => tool.name)).toEqual(wireNames);
      expect(internal.execContext.clientToolDefs?.map(tool => tool.name)).toEqual(wireNames);
      expect(internal.execContext.nativeExecRedirectHint?.match(/Available tools in this request's catalog: (.*?)\. /)?.[1])
        .toBe(wireNames.map(name => `\`${name}\``).join(", "));
      expect(internal.execContext.plainToolWording).toBe(true);
    } finally { await transport.close?.(); }
  });
  test.each(CLAUDE_MODELS)("recognizes Claude target %s", modelId => {
    expect(cursorUsesPlainToolWording(modelId)).toBe(true);
  });
  test.each(OTHER_MODELS)("preserves legacy mode for %s", modelId => {
    expect(cursorUsesPlainToolWording(modelId)).toBe(false);
  });
  test.each(CLAUDE_MODELS)("Claude guidance and redirects contain no concealment: %s", modelId => {
    for (const tools of Object.values(legacy.catalogs)) {
      const guidance = buildCursorToolGuidanceSystemNote(tools, undefined, modelId)!;
      const hint = cursorNativeExecRedirectHint(tools, [], modelId)!;
      for (const text of [guidance, hint]) {
        expect(text).not.toMatch(CONCEALMENT);
        expect(text).toContain("not available");
        expect(text.endsWith(CURSOR_TOOL_CALL_CONTINUATION)).toBe(true);
      }
    }
    const codeHint = cursorNativeExecRedirectHint(legacy.catalogs.code, [], modelId)!;
    expect(codeHint).toContain("text(await tools.exec_command(");
    expect(codeHint).toContain("not top-level tools");
    expect(codeHint).toContain("Every other listed tool remains callable");
    expect(cursorNativeExecRedirectHint(legacy.catalogs.client, [], modelId)).not.toContain("shell_command");
  });
  test.each(OTHER_MODELS)("non-Claude text matches pre-change snapshots byte-for-byte: %s", modelId => {
    for (const key of Object.keys(legacy.catalogs) as Array<keyof typeof legacy.catalogs>) {
      expect(buildCursorToolGuidanceSystemNote(legacy.catalogs[key], undefined, modelId)).toBe(legacy.guidance[key]);
    }
    expect(cursorNativeExecRedirectHint(legacy.catalogs.code, [], modelId)).toBe(legacy.redirect.code);
    expect(cursorNativeExecRedirectHint(legacy.catalogs.client, [], modelId)).toBe(legacy.redirect.client);
    expect(cursorNativeExecRedirectHint(undefined, [{ name: "lookup", providerIdentifier: "docs" }], modelId)).toBe(legacy.redirect.mcp);
    for (const tools of [undefined, [], legacy.catalogs.shell, legacy.catalogs.mixed, [{ name: "exec" }]]) {
      expect(cursorNativeExecRedirectHint(tools, [], modelId)).toBeUndefined();
    }
    expect(nativeShellDisabledMessage()).toBe(legacy.defaults.shell);
  });
  test("Claude catalog guidance respects tool choice, MCP names, and display caps", () => {
    const modelId = CLAUDE_MODELS[0];
    expect(buildCursorToolGuidanceSystemNote(legacy.catalogs.shell, "none", modelId)).toBeUndefined();
    const hint = cursorNativeExecRedirectHint(undefined, [{ name: "lookup", providerIdentifier: "docs" }], modelId)!;
    expect(hint).toContain("`mcp_docs_lookup`");
    expect(hint).not.toContain("shell_command");
    const capped = cursorNativeExecRedirectHint(Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}` })), [], modelId)!;
    expect(capped).toContain("`ocx_client_tool_15`");
    expect(capped).not.toContain("`ocx_client_tool_16`");
    expect(capped).toContain("(+4 more)");
  });
  test.each(["code", "shell"] as const)("Claude factual routing prose reaches the next tool call without retry (%s)", async catalog => {
    const tools = legacy.catalogs[catalog];
    const toolName = tools[0]!.name;
    const fragments = ["Cursor-native Shell is unavailable. ", "I will use the advertised ", `${toolName} tool.\n`];
    const runRequests: CursorRunRequest[] = [];
    let reachedToolCall = 0;
    const adapter = createCursorAdapter({ adapter: "cursor", apiKey: "fixture-token" }, {
      createTransport: () => ({
        async *run(request) {
          runRequests.push(request);
          for (const text of fragments) yield { type: "text", text } satisfies CursorServerMessage;
          reachedToolCall++;
          yield { type: "tool_call_start", id: "call-next", name: toolName } satisfies CursorServerMessage;
          yield { type: "tool_call_delta", arguments: catalog === "code" ? "text(await tools.exec_command({cmd: 'pwd'}))" : '{"cmd":"pwd"}' } satisfies CursorServerMessage;
          yield { type: "tool_call_end", id: "call-next" } satisfies CursorServerMessage;
          yield { type: "done" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });
    const parsed = parseRequest({ model: "cursor/claude-4.6-opus-high", input: [
      { role: "user", content: "Inspect the project." },
      { type: "function_call", call_id: "call-prior", name: toolName, arguments: "{}" },
      { type: "function_call_output", call_id: "call-prior", output: "prior result" },
    ], tools: tools.map(tool => ({ type: ("freeform" in tool && tool.freeform) ? "custom" : "function", name: tool.name, description: "Fixture tool", parameters: {} })) });
    expect(parsed.context.messages.at(-1)?.role).toBe("toolResult");
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(runRequests).toHaveLength(1);
    expect(runRequests[0]!.echoRetryContinuationText).toBeUndefined();
    expect(reachedToolCall).toBe(1);
    expect(events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe(fragments.join(""));
    expect(events.some(event => event.type === "tool_call_end")).toBe(true);
  });
  test("non-Claude factual routing prose retains the legacy abort and corrective retry", async () => {
    const runRequests: CursorRunRequest[] = [];
    let reachedToolCall = 0;
    const adapter = createCursorAdapter({ adapter: "cursor", apiKey: "fixture-token" }, {
      createTransport: () => ({
        async *run(request) {
          runRequests.push(request);
          yield { type: "text", text: "Cursor-native Shell is unavailable. I will use exec.\n" } satisfies CursorServerMessage;
          reachedToolCall++;
          yield { type: "tool_call_start", id: "call-next", name: "exec" } satisfies CursorServerMessage;
        },
        writeClient() {},
      }),
    });
    const parsed = parseRequest({ model: "cursor/kimi-k3-1m", input: "Inspect the project.", tools: [{ type: "custom", name: "exec", description: "Fixture tool" }] });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(runRequests).toHaveLength(2);
    expect(runRequests[1]!.echoRetryContinuationText).toBe(CURSOR_ROUTING_COMMENTARY_RETRY_TEXT);
    expect(reachedToolCall).toBe(0);
    expect(events.some(event => event.type === "error")).toBe(true);
    expect(events.some(event => event.type === "text_delta" || event.type === "tool_call_start")).toBe(false);
  });
  test.each(["explicit empty catalog", "empty dispatcher catalog"])("Claude denials accurately report no tools (%s)", async kind => {
    const deps: CursorNativeExecContext = kind === "explicit empty catalog"
      ? { plainToolWording: true, nativeExecRedirectHint: cursorNativeExecRedirectHint([], [], CLAUDE_MODELS[0]) }
      : { plainToolWording: true, clientToolDefs: [], mcpToolDefs: [] };
    for (const frame of Object.values(frames)) {
      for (const text of refusalTexts(await handleCursorNativeExec(frame, deps))) {
        expect(text).toContain("No client tools are available");
        expect(text).toContain("Answer without tools");
        expect(text).toContain("report");
        expect(text).not.toMatch(/shell_command|exec_command|apply_patch|curl|wget|tool call/i);
        expect(text).not.toMatch(CONCEALMENT);
      }
    }
  });
  test("Claude fallback uses the dispatcher catalog without inventing a shell tool", async () => {
    const deps: CursorNativeExecContext = { plainToolWording: true, clientToolDefs: [], mcpToolDefs: [{ name: "lookup", providerIdentifier: "docs" } as NonNullable<CursorNativeExecContext["mcpToolDefs"]>[number]] };
    const [text] = refusalTexts(await handleCursorNativeExec(frames.fetch, deps));
    expect(text).toContain("`mcp_docs_lookup`");
    expect(text).not.toMatch(/shell_command|exec_command|curl|wget/);
    expect(text!.endsWith(CURSOR_TOOL_CALL_CONTINUATION)).toBe(true);
  });
  test("all Claude fs/shell/fetch policy denials use factual wording, including fallback dispatch", async () => {
    let fetchCalls = 0;
    for (const tools of [undefined, ...Object.values(legacy.catalogs)]) {
      const deps: CursorNativeExecContext = {
        plainToolWording: true,
        nativeExecRedirectHint: cursorNativeExecRedirectHint(tools, [], CLAUDE_MODELS[0]),
        fetch: async () => { fetchCalls++; return new Response("unexpected"); },
      };
      for (const frame of Object.values(frames)) {
        for (const text of refusalTexts(await handleCursorNativeExec(frame, deps))) {
          expect(text).not.toMatch(CONCEALMENT);
          expect(text).toContain("not available");
          if (tools?.length) expect(text.endsWith(CURSOR_TOOL_CALL_CONTINUATION)).toBe(true);
          else expect(text).toContain("Answer without tools");
        }
      }
    }
    expect(fetchCalls).toBe(0);
  });
  test("default non-Claude fs/shell/fetch denials are byte-identical", async () => {
    const expected = { ...legacy.defaults, read: legacy.defaults.fs, ls: legacy.defaults.fs, grep: legacy.defaults.fs,
      stream: legacy.defaults.shell, background: legacy.defaults.shell, stdin: legacy.defaults.shell };
    for (const [key, frame] of Object.entries(frames)) {
      for (const text of refusalTexts(await handleCursorNativeExec(frame))) {
        expect(text).toBe(expected[key as keyof typeof expected]);
      }
    }
  });
  test.each([false, true])("mutation redirects preserve non-Claude snapshots and remove concealment for Claude (structured=%s)", async structuredEditAvailable => {
    for (const operation of ["write", "delete"] as const) {
      const deps = { unsafeAllowNativeLocalExec: true, rejectNativeFileMutations: true, structuredEditAvailable };
      const [original] = refusalTexts(await handleCursorNativeExec(frames[operation], deps));
      expect(original).toBe(legacy.mutation[structuredEditAvailable ? "true" : "false"][operation]);
      const [plain] = refusalTexts(await handleCursorNativeExec(frames[operation], { ...deps, plainToolWording: true }));
      expect(plain).not.toMatch(CONCEALMENT);
      expect(plain).toContain("No file was changed.");
      expect(plain!.endsWith(CURSOR_TOOL_CALL_CONTINUATION)).toBe(true);
    }
  });
  test("foreground native shells retain factual redirects even with unsafe native exec enabled", async () => {
    for (const key of ["shell", "stream"] as const) {
      const texts = refusalTexts(await handleCursorNativeExec(frames[key], { unsafeAllowNativeLocalExec: true, plainToolWording: true }));
      for (const text of texts) {
        expect(text).not.toMatch(CONCEALMENT);
        expect(text).toContain("not available");
        expect(text).toContain("Answer without tools");
        expect(text).not.toMatch(/shell_command|exec_command/);
      }
    }
  });
  test.each(["claude-sonnet-5-5", "cursor-grok-4.6-high"])("encoded system roots use the final target model: %s", modelId => {
    for (const tools of [legacy.catalogs.shell, legacy.catalogs.code]) {
      const request = createCursorRequest(parseRequest({ model: `cursor/${modelId}`, input: "Inspect the project.",
        tools: tools.map(tool => ({ type: ("freeform" in tool && tool.freeform) ? "custom" : "function", name: tool.name, description: "Fixture tool", parameters: {} })) }));
      const decoded = fromBinary(AgentClientMessageSchema, encodeCursorRunRequest(request));
      if (decoded.message.case !== "runRequest") throw new Error("Expected runRequest");
      const roots = decoded.message.value.conversationState!.rootPromptMessagesJson.map(id => JSON.parse(cursorBlobTextForEstimate(id)!));
      const expected = buildCursorToolGuidanceSystemNote(request.tools, request.toolChoice, request.modelId)!;
      expect(roots.some(root => root.role === "system" && root.content === expected)).toBe(true);
      if (cursorUsesPlainToolWording(modelId)) expect(expected).not.toMatch(CONCEALMENT);
      else expect(expected).toMatch(CONCEALMENT);
    }
  });
  test("live transport refreshes wording with each turn's target rather than retaining a Claude flag", async () => {
    const transport = createLiveCursorTransport({ provider: { adapter: "cursor", baseUrl: "https://api2.cursor.sh", apiKey: "fixture-token" },
      translatorBudget: createTestTranslatorBudget(), headers: new Headers() });
    const internal = transport as unknown as { open(): void; execContext: CursorNativeExecContext };
    internal.open = () => { throw new Error("wording fixture stops before network"); };
    try {
      for (const modelId of ["claude-sonnet-5-5", "cursor-grok-4.6-high", "claude-4.6-opus-high"]) {
        const request = { modelId, conversationId: "wording-fixture", system: [], messages: [{ role: "user" as const, content: "Inspect the project." }], tools: legacy.catalogs.shell.map(tool => ({ ...tool, description: "Run", parameters: {} })) };
        await expect(transport.run(request)[Symbol.asyncIterator]().next()).rejects.toThrow("wording fixture stops before network");
        expect(internal.execContext.plainToolWording).toBe(cursorUsesPlainToolWording(modelId));
        expect(internal.execContext.nativeExecRedirectHint).toBe(cursorNativeExecRedirectHint(request.tools, [], modelId));
        const [text] = refusalTexts(await handleCursorNativeExec(frames.fetch, internal.execContext));
        if (cursorUsesPlainToolWording(modelId)) expect(text).not.toMatch(CONCEALMENT);
        else expect(text).toBe(legacy.defaults.fetch);
      }
    } finally { await transport.close?.(); }
  });
});
