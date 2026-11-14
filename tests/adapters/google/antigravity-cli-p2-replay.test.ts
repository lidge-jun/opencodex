import { describe, expect, test } from "bun:test";
import {
  ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT,
  ANTIGRAVITY_MCP_TOOL_PREFIX,
  ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT,
  AntigravityTerminalRefusalProtocolError,
  buildAntigravityAgentMarkdown,
  buildAntigravityCliConversationInput,
  buildAntigravityCliRulesMarkdown,
  buildAntigravityCliToolBridge,
  createAntigravityStreamState,
  mapAntigravityStreamFrame,
  stableAntigravityMessageText,
  usageFromAntigravityRecord,
} from "../../../src/adapters/antigravity-cli/protocol";
import { formatMessageForHistory } from "../../../src/adapters/coding-agent/protocol";
import { disjointTelemetryTokens } from "../../../src/telemetry/aggregate";
import type { OcxMessage, OcxParsedRequest } from "../../../src/types";
import { normalizeCostTokens } from "../../../src/usage/cost";

const ONE_BY_ONE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeParsedRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-4-carbon",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    },
    ...overrides,
  } as OcxParsedRequest;
}

describe("antigravity-cli Stage 2 replay separation, thinking omission, and prompt guards", () => {
  test("separates replayed content blocks with \\n\\n and keeps byte-identical prefix across turns", () => {
    const turn1Messages: OcxMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Check screenshot" },
          { type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL },
        ],
        timestamp: 0,
      },
    ];
    const turn2Messages: OcxMessage[] = [
      ...turn1Messages,
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning should be omitted" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "README.md" } },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_file",
        content: [{ type: "text", text: "file body" }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "user",
        content: "Summarize",
        timestamp: 3,
      },
    ];
    const turn3Messages: OcxMessage[] = [
      ...turn2Messages,
      {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        timestamp: 4,
      },
      {
        role: "user",
        content: "Next step?",
        timestamp: 5,
      },
    ];

    const turn1Frame = JSON.parse(buildAntigravityCliConversationInput(
      makeParsedRequest({ context: { messages: turn1Messages } }),
      {
        stagedImages: [{ index: 0, relativePath: ".ocx-images/img-0.png", absolutePath: "/tmp/t1/.ocx-images/img-0.png" }],
      },
    )[0]!) as { message: { content: Array<{ type: string; text: string }> } };

    const turn2Frame = JSON.parse(buildAntigravityCliConversationInput(
      makeParsedRequest({ context: { messages: turn2Messages } }),
      {
        stagedImages: [{ index: 0, relativePath: ".ocx-images/img-0.png", absolutePath: "/tmp/t2/.ocx-images/img-0.png" }],
      },
    )[0]!) as { message: { content: Array<{ type: string; text: string }> } };

    const turn3Frame = JSON.parse(buildAntigravityCliConversationInput(
      makeParsedRequest({ context: { messages: turn3Messages } }),
      {
        stagedImages: [{ index: 0, relativePath: ".ocx-images/img-0.png", absolutePath: "/tmp/t3/.ocx-images/img-0.png" }],
      },
    )[0]!) as { message: { content: Array<{ type: string; text: string }> } };

    expect(turn1Frame.message.content[0]?.text).toBe(
      "USER:\nCheck screenshot\n[Attached image: .ocx-images/img-0.png]",
    );
    expect(turn2Frame.message.content[0]?.text).toBe(turn1Frame.message.content[0]?.text);
    expect(turn3Frame.message.content.slice(0, 4).map(b => b.text)).toEqual(
      turn2Frame.message.content.slice(0, 4).map(b => b.text),
    );

    const joined2 = turn2Frame.message.content.map(b => b.text).join("");
    expect(joined2).not.toContain(")ASSISTANT:");
    expect(joined2).not.toContain("]TOOL RESULT");
    expect(joined2).not.toContain(">USER:");
    expect(joined2).toContain('{"path":"README.md"}]\n\nTOOL RESULT');
    expect(joined2).toContain("file body\n\nUSER:\nSummarize");
    expect(joined2).toContain("\n\n[Workspace absolute paths");
  });

  test("omits assistant thinking blocks in antigravity replay while keeping coding-agent default unchanged", () => {
    const assistantMsg: OcxMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "Visible answer" },
      ],
      timestamp: 1,
    };

    expect(formatMessageForHistory(assistantMsg)).toContain("[Thinking: secret chain of thought]");
    expect(formatMessageForHistory(assistantMsg, undefined, false, { omitThinking: true })).toBe(
      "ASSISTANT:\nVisible answer",
    );
    const agyRendered = stableAntigravityMessageText(assistantMsg);
    expect(agyRendered).toBe("ASSISTANT:\nVisible answer");
    expect(agyRendered).not.toContain("[Thinking:");
  });

  test("defaults cold replay history limit to ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT (180_000)", () => {
    expect(ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT).toBe(180_000);
    const bigText = "x".repeat(95_000);
    const req = makeParsedRequest({
      context: {
        messages: [
          { role: "user", content: bigText, timestamp: 0 },
          { role: "assistant", content: [{ type: "text", text: bigText }], timestamp: 1 },
          { role: "user", content: "final question", timestamp: 2 },
        ],
      },
    });
    const frame = JSON.parse(buildAntigravityCliConversationInput(req)[0]!) as {
      message: { content: Array<{ text: string }> };
    };
    const joined = frame.message.content.map(c => c.text).join("");
    expect(joined).toContain("[Earlier conversation history omitted at a whole-message checkpoint.]");
    expect(joined).toContain("USER:\nfinal question");
  });

  test("enforces F9 replay-marker prohibition and U7 global isolation override without mentioning opencodex", () => {
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toContain("USER:");
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toContain("ASSISTANT:");
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toContain("TOOL RESULT");
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toContain("[Tool call:");
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toContain("call_id");
    expect(ANTIGRAVITY_TOOL_BRIDGE_SYSTEM_PROMPT).toMatch(/ignore any inherited user or global rules/i);

    const bridge = buildAntigravityCliToolBridge(makeParsedRequest({
      context: {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        tools: [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }],
      },
    }));
    const rulesWithTools = buildAntigravityCliRulesMarkdown(makeParsedRequest(), bridge, false);
    const rulesDisabled = buildAntigravityCliRulesMarkdown(makeParsedRequest(), undefined, false);
    const agentMd = buildAntigravityAgentMarkdown(makeParsedRequest(), {
      toolBridge: bridge,
      hasStagedImages: true,
      mcpServer: { command: "/bin/bun", args: ["/app/mcp.ts", "/tmp/c.json"] },
    });

    expect(rulesWithTools).not.toMatch(/opencodex/i);
    expect(rulesDisabled).not.toMatch(/opencodex/i);
    expect(agentMd).not.toMatch(/opencodex/i);
    expect(rulesDisabled).toMatch(/ignore any inherited user or global rules/i);
    expect(agentMd).toContain("never emit them in your response text");
  });
});

describe("antigravity-cli Stage 2 streaming ASSISTANT: strip and F9 fake tool-call guard", () => {
  const toolBridge = buildAntigravityCliToolBridge(makeParsedRequest({
    context: {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
      tools: [
        { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
        { name: "bash_exec", description: "exec", parameters: { type: "object", properties: { cmd: { type: "string" } } } },
      ],
    },
  }))!;

  test("strips split leading ASSISTANT: prefix without duplicating result.response and emits normal replies with zero TTFT buffering", () => {
    // 1. Normal short reply: first char != A/a emits immediately on first frame
    const normalState = createAntigravityStreamState();
    const firstChunk = mapAntigravityStreamFrame(
      { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hi" } },
      normalState,
      toolBridge,
    );
    expect(firstChunk).toEqual([{ type: "text_delta", text: "Hi" }]);
    expect(normalState.emittedAssistantText).toBe("Hi");

    // 2. Split leading `  assistant: \r\n` prefix stripped cleanly across chunks; result.response not duplicated
    const splitState = createAntigravityStreamState();
    const ev1 = mapAntigravityStreamFrame(
      { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "  assi" } },
      splitState,
      toolBridge,
    );
    const ev2 = mapAntigravityStreamFrame(
      { event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "stant: \r" } },
      splitState,
      toolBridge,
    );
    const ev3 = mapAntigravityStreamFrame(
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\nHello world!" } },
      splitState,
      toolBridge,
    );
    const evDone = mapAntigravityStreamFrame(
      { event: "result", result: { status: "SUCCESS", response: "  assistant: \r\nHello world!" } },
      splitState,
      toolBridge,
    );
    expect([...ev1, ...ev2, ...ev3, ...evDone]).toEqual([
      { type: "text_delta", text: "Hello world!" },
      { type: "done", stopReason: "stop" },
    ]);
    expect(splitState.emittedAssistantText).toBe("Hello world!");

    // 3. Multi-step with leading ASSISTANT: stripped before tool step still deduplicates result.response accurately
    const multiStepState = createAntigravityStreamState(undefined, {
      stagedImagePaths: new Set(["/tmp/t/.ocx-images/img-0.png"]),
      turnDir: "/tmp/t",
      platform: "linux",
    });
    const m1 = mapAntigravityStreamFrame(
      { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ASSISTANT:\nInspecting." } },
      multiStepState,
    );
    const m2 = mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "view_file",
          tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/t/.ocx-images/img-0.png" } },
        },
      },
      multiStepState,
    );
    const m3 = mapAntigravityStreamFrame(
      { event: "result", result: { status: "SUCCESS", response: "ASSISTANT:\nInspecting.Done." } },
      multiStepState,
    );
    expect([...m1, ...m2, ...m3]).toEqual([
      { type: "text_delta", text: "Inspecting." },
      { type: "text_delta", text: "\n\nDone." },
      { type: "done", stopReason: "stop" },
    ]);
    expect(multiStepState.emittedAssistantText).toBe("Inspecting.\n\nDone.");
  });

  test("rejects forged [Tool call: ...] when capturedToolCalls === 0 across chunk splits and result.response fallback", () => {
    // 1. Bridged MCP name split across two deltas
    const splitMcpState = createAntigravityStreamState();
    const prefixEvents = mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Checking [Tool " },
      },
      splitMcpState,
      toolBridge,
    );
    expect(prefixEvents).toEqual([{ type: "text_delta", text: "Checking " }]);
    expect(() =>
      mapAntigravityStreamFrame(
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: `call: ${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file (call_id: 1)]`,
          },
        },
        splitMcpState,
        toolBridge,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);
    expect(splitMcpState.emittedAssistantText).toBe("Checking ");

    // 2. Declared wireName split mid-token
    const wireState = createAntigravityStreamState();
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "[Tool call: bash_" },
      },
      wireState,
      toolBridge,
    );
    try {
      mapAntigravityStreamFrame(
        {
          event: "step_update",
          step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "exec(cmd='ls')]" },
        },
        wireState,
        toolBridge,
      );
      expect.unreachable("expected AntigravityTerminalRefusalProtocolError");
    } catch (err) {
      expect(err).toBeInstanceOf(AntigravityTerminalRefusalProtocolError);
      expect((err as AntigravityTerminalRefusalProtocolError).terminalRefusal).toBe(true);
      expect((err as AntigravityTerminalRefusalProtocolError).status).toBe(502);
      expect((err as AntigravityTerminalRefusalProtocolError).code).toBe("protocol_error");
    }

    // 3. Unstreamed result.response fallback path
    const resultFallbackState = createAntigravityStreamState();
    expect(() =>
      mapAntigravityStreamFrame(
        {
          event: "result",
          result: {
            status: "SUCCESS",
            response: `[Tool call: ${ANTIGRAVITY_MCP_TOOL_PREFIX}bash_exec (call_id: c1)]`,
          },
        },
        resultFallbackState,
        toolBridge,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);

    // 4. Built-in read_file / view_file at EOF without trailing delimiter
    const eofToolState = createAntigravityStreamState();
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "[Tool call: view_file" },
      },
      eofToolState,
      toolBridge,
    );
    expect(() =>
      mapAntigravityStreamFrame(
        { event: "result", result: { status: "SUCCESS", response: "[Tool call: view_file" } },
        eofToolState,
        toolBridge,
      ),
    ).toThrow(AntigravityTerminalRefusalProtocolError);
  });

  test("does not false-trigger on normal brackets like [0]/[NOTE] or when capturedToolCalls > 0", () => {
    const proseState = createAntigravityStreamState();
    const prose = mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Array item [0] and [NOTE] and [Tool call: example] are safe.",
        },
      },
      proseState,
      toolBridge,
    );
    expect(prose).toEqual([
      { type: "text_delta", text: "Array item [0] and [NOTE] and [Tool call: example] are safe." },
    ]);

    const afterRealCallState = createAntigravityStreamState();
    mapAntigravityStreamFrame(
      { event: "init", init: { agent: "ocx_bridge", tools: ["call_mcp_tool"], permission_mode: "request-review" } },
      afterRealCallState,
      toolBridge,
    );
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`,
          tool_info: { name: `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`, parameters: { path: "a.txt" } },
        },
      },
      afterRealCallState,
      toolBridge,
    );
    expect(afterRealCallState.capturedToolCalls).toBe(1);
    const allowedMention = mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 2,
          state: "DONE",
          step_type: "agent_response",
          text_delta: `[Tool call: ${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file]`,
        },
      },
      afterRealCallState,
      toolBridge,
    );
    expect(allowedMention).toEqual([
      { type: "text_delta", text: `[Tool call: ${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file]` },
    ]);
  });
});

describe("antigravity-cli Stage 3 schema pre-sanitization & Stage 4 F13/F19 usage", () => {
  test("pre-sanitizes non-/u pattern, empty enum, duplicate required, and inverted min/max without mutating request or bypassing external $ref", () => {
    const rawParams = {
      type: "object",
      properties: {
        regexField: { type: "string", pattern: "(?P<bad>\\w+)" },
        emptyEnum: { type: "string", enum: [] },
        boundedNum: { type: "number", minimum: 10, maximum: 5 },
      },
      required: ["regexField", "regexField"],
      additionalProperties: false,
    };
    const originalSnapshot = JSON.stringify(rawParams);

    const bridge = buildAntigravityCliToolBridge(makeParsedRequest({
      context: {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
        tools: [{ name: "mcp_custom_tool", description: "custom", parameters: rawParams }],
      },
    }));
    expect(bridge?.tools).toHaveLength(1);
    expect(JSON.stringify(rawParams)).toBe(originalSnapshot);
    const schema = bridge?.tools[0]?.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(["regexField"]);
    expect((schema.properties as Record<string, Record<string, unknown>>).emptyEnum?.enum).toBeUndefined();

    expect(() =>
      buildAntigravityCliToolBridge(makeParsedRequest({
        context: {
          messages: [{ role: "user", content: "hi", timestamp: 0 }],
          tools: [{
            name: "external_ref_tool",
            description: "bad",
            parameters: { type: "object", properties: { ext: { $ref: "https://example.com/schema.json" } } },
          }],
        },
      })),
    ).toThrow(/local fragment reference/i);
  });

  test("preserves uncached input alongside cache_read (F13/F19) and handles cumulative vs reset usageBaseline", () => {
    // 1. Disjoint rawInput < cacheRead (F13)
    const f13 = usageFromAntigravityRecord({
      input_tokens: 2071,
      cache_read_tokens: 16713,
      output_tokens: 80,
      thinking_tokens: 20,
      total_tokens: 18864,
    });
    expect(f13).toEqual({
      inputTokens: 18784,
      outputTokens: 80,
      totalTokens: 18864,
      cachedInputTokens: 16713,
      cacheReadInputTokens: 16713,
      reasoningOutputTokens: 20,
    });
    expect(normalizeCostTokens(f13!)).toEqual({
      input: 2071,
      output: 80,
      cacheRead: 16713,
      cacheWrite: 0,
    });
    expect(disjointTelemetryTokens(f13)).toEqual({
      inputTokens: 2071,
      cacheReadTokens: 16713,
      cacheWriteTokens: 0,
      outputTokens: 60,
      reasoningTokens: 20,
    });

    // 2. mergeAntigravityUsage does not let cacheRead swallow freshInput
    const mergeState = createAntigravityStreamState();
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "ok",
          usage: { input_tokens: 2071, cache_read_tokens: 0, output_tokens: 10 },
        },
      },
      mergeState,
    );
    const doneMerged = mapAntigravityStreamFrame(
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "ok",
          usage: { input_tokens: 0, cache_read_tokens: 16713, output_tokens: 15, total_tokens: 16728 },
        },
      },
      mergeState,
    );
    expect(doneMerged.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: {
        inputTokens: 18784,
        outputTokens: 15,
        totalTokens: 18799,
        cachedInputTokens: 16713,
        cacheReadInputTokens: 16713,
      },
    });

    // 3. Per-step step_update.usage stays unsubtracted while cumulative usageBaseline is subtracted only from result.usage
    const baseline = {
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 0,
      thinking_tokens: 10,
      total_tokens: 1050,
    };
    const cumulativeState = createAntigravityStreamState(undefined, { usageBaseline: baseline });
    mapAntigravityStreamFrame(
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "hi",
          usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 8000, thinking_tokens: 5, total_tokens: 520 },
        },
      },
      cumulativeState,
    );
    expect(cumulativeState.stepRawUsages.get(1)).toEqual({
      input_tokens: 500,
      output_tokens: 20,
      cache_read_tokens: 8000,
      thinking_tokens: 5,
      total_tokens: 520,
    });
    const cumulativeDone = mapAntigravityStreamFrame(
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "hi",
          usage: { input_tokens: 1500, output_tokens: 70, cache_read_tokens: 8000, thinking_tokens: 15, total_tokens: 1570 },
        },
      },
      cumulativeState,
    );
    expect(cumulativeDone.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: {
        inputTokens: 8500,
        outputTokens: 20,
        totalTokens: 8520,
        cachedInputTokens: 8000,
        cacheReadInputTokens: 8000,
        reasoningOutputTokens: 5,
      },
    });

    // 4. Reset counter (< usageBaseline) is NOT subtracted
    const resetState = createAntigravityStreamState(undefined, { usageBaseline: baseline });
    const resetDone = mapAntigravityStreamFrame(
      {
        event: "result",
        result: {
          status: "SUCCESS",
          response: "ok",
          usage: { input_tokens: 400, output_tokens: 12, cache_read_tokens: 3000, thinking_tokens: 4, total_tokens: 3412 },
        },
      },
      resetState,
    );
    expect(resetDone.at(-1)).toEqual({
      type: "done",
      stopReason: "stop",
      usage: {
        inputTokens: 3400,
        outputTokens: 12,
        totalTokens: 3412,
        cachedInputTokens: 3000,
        cacheReadInputTokens: 3000,
        reasoningOutputTokens: 4,
      },
    });
  });

  test("accounts for active tail user and toolResult message size when trimming cold history within 180k limit", () => {
    const priorHistory: OcxMessage[] = [
      { role: "user", content: `HIST_0_${"h".repeat(35_000 - 7)}`, timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: `HIST_1_${"a".repeat(35_000 - 7)}` }], timestamp: 1 },
      { role: "user", content: `HIST_2_${"h".repeat(35_000 - 7)}`, timestamp: 2 },
      { role: "assistant", content: [{ type: "text", text: `HIST_3_${"a".repeat(35_000 - 7)}` }], timestamp: 3 },
    ];

    // 1. 140,000 chars of prior history + 60,000 chars in active tail user message
    const tailUserText = `ACTIVE_USER_TAIL_${"u".repeat(60_000 - "ACTIVE_USER_TAIL_".length)}`;
    expect(tailUserText).toHaveLength(60_000);
    const [userFrameJson] = buildAntigravityCliConversationInput(
      makeParsedRequest({
        context: {
          messages: [
            ...priorHistory,
            { role: "user", content: tailUserText, timestamp: 4 },
          ],
        },
      }),
    );
    expect(userFrameJson).toBeDefined();
    expect(userFrameJson!.length).toBeLessThanOrEqual(ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT);
    const userFrame = JSON.parse(userFrameJson!) as { message: { content: Array<{ text: string }> } };
    const userJoined = userFrame.message.content.map(part => part.text).join("");
    expect(userJoined.length).toBeLessThanOrEqual(ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT);
    expect(userJoined).toContain("[Earlier conversation history omitted at a whole-message checkpoint.]");
    expect(userJoined).not.toContain("HIST_0_");
    expect(userJoined).toContain(tailUserText);

    // 2. 140,000 chars of prior history + 60,000 chars in active tail toolResult message
    const tailToolText = `ACTIVE_TOOL_TAIL_${"t".repeat(60_000 - "ACTIVE_TOOL_TAIL_".length)}`;
    expect(tailToolText).toHaveLength(60_000);
    const [toolFrameJson] = buildAntigravityCliConversationInput(
      makeParsedRequest({
        context: {
          messages: [
            ...priorHistory,
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "call_tail_1", name: "read_file", arguments: { path: "big.log" } }],
              timestamp: 4,
            },
            {
              role: "toolResult",
              toolCallId: "call_tail_1",
              toolName: "read_file",
              content: [{ type: "text", text: tailToolText }],
              isError: false,
              timestamp: 5,
            },
          ],
        },
      }),
    );
    expect(toolFrameJson).toBeDefined();
    expect(toolFrameJson!.length).toBeLessThanOrEqual(ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT);
    const toolFrame = JSON.parse(toolFrameJson!) as { message: { content: Array<{ text: string }> } };
    const toolJoined = toolFrame.message.content.map(part => part.text).join("");
    expect(toolJoined.length).toBeLessThanOrEqual(ANTIGRAVITY_COLD_HISTORY_CHAR_LIMIT);
    expect(toolJoined).toContain("[Earlier conversation history omitted at a whole-message checkpoint.]");
    expect(toolJoined).not.toContain("HIST_0_");
    expect(toolJoined).toContain("call_tail_1");
    expect(toolJoined).toContain(tailToolText);
  });
});
