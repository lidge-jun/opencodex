import { describe, expect, test } from "bun:test";
import {
  createQoderCnAdapter,
  validateQoderGatewayUrl,
  QoderDestinationSecurityError,
  ALLOWED_QODER_GATEWAY_ORIGIN,
  messagesToQoderFormat,
  normalizeToolArguments,
} from "../src/adapters/qodercn";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "qodercn",
  baseUrl: ALLOWED_QODER_GATEWAY_ORIGIN,
  apiKey: "test_qoder_token",
  accountId: "test-account-123",
  machineId: "test-machine-456",
  modelMap: {
    "GLM-5.3-Flash": "gfmodel",
  },
};

const parsed: OcxParsedRequest = {
  modelId: "GLM-5.3-Flash",
  context: {
    systemPrompt: ["You are a test assistant."],
    messages: [
      { role: "user", content: "Hello Qoder" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I can help with tools." },
          { type: "toolCall", id: "call_123", name: "calculator", arguments: { a: 1 } },
        ],
      },
      { role: "toolResult", toolCallId: "call_123", content: [{ type: "text", text: "Result: 2" }] } as any,
    ],
  },
  stream: false,
  options: {},
};

describe("Qoder CN Adapter Trust Boundaries & Protocol", () => {
  test("factory produces valid adapter structure", () => {
    const adapter = createQoderCnAdapter(provider);
    expect(adapter.name).toBe("qodercn");
    expect(typeof adapter.runTurn).toBe("function");
    expect(typeof adapter.buildRequest).toBe("function");
    expect(typeof adapter.parseStream).toBe("function");
  });

  test("security: gateway origin allowlist permits official domain", () => {
    const url = "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?foo=bar";
    expect(validateQoderGatewayUrl(url)).toBe(url);
  });

  test("security: gateway origin rejects untrusted destinations", () => {
    expect(() => validateQoderGatewayUrl("https://malicious.com/api")).toThrow(QoderDestinationSecurityError);
    expect(() => validateQoderGatewayUrl("http://gateway.qoder.com.cn/api")).toThrow(QoderDestinationSecurityError);
    expect(() => validateQoderGatewayUrl("https://fake.gateway.qoder.com.cn.attacker.org")).toThrow(QoderDestinationSecurityError);
  });

  test("security: missing credential fails closed", async () => {
    const keylessProvider: OcxProviderConfig = {
      adapter: "qodercn",
      baseUrl: ALLOWED_QODER_GATEWAY_ORIGIN,
    };
    const adapter = createQoderCnAdapter(keylessProvider);
    const events: any[] = [];

    if (adapter.runTurn) {
      await adapter.runTurn(parsed, { headers: new Headers() } as any, (e: any) => { events.push(e); });
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("credential missing");
  });

  test("message serializer maps system, user, assistant tool_calls, and tool results", () => {
    const formatted = messagesToQoderFormat(parsed);
    expect(formatted.length).toBe(4);
    expect(formatted[0]).toEqual({ role: "system", content: "You are a test assistant." });
    expect(formatted[1]).toEqual({ role: "user", content: "Hello Qoder" });
    expect(formatted[2]).toMatchObject({
      role: "assistant",
      content: "I can help with tools.",
      tool_calls: [{ id: "call_123", type: "function", function: { name: "calculator", arguments: JSON.stringify({ a: 1 }) } }],
    });
    expect(formatted[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call_123",
      content: "Result: 2",
    });
  });

  test("pre-aborted runTurn emits error", async () => {
    const adapter = createQoderCnAdapter(provider);
    const events: any[] = [];
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    if (adapter.runTurn) {
      await adapter.runTurn(parsed, { headers: new Headers(), abortSignal: abortCtrl.signal } as any, (e: any) => { events.push(e); });
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("error");
    expect(events[0].message).toContain("aborted");
  });

  test("normalizeToolArguments unwraps envelope objects and coerces booleans", () => {
    const input1 = JSON.stringify({ parameters: { title: "Test Title", question: "Is this working?" } });
    const res1 = JSON.parse(normalizeToolArguments(input1));
    expect(res1).toEqual({ title: "Test Title", question: "Is this working?" });

    const input2 = JSON.stringify({ show_details: "true", nested: { flag: "false", timeout: "30000" } });
    const res2 = JSON.parse(normalizeToolArguments(input2));
    expect(res2).toEqual({ show_details: true, nested: { flag: false, timeout: 30000 } });

    const input3 = JSON.stringify({ code: "print(1)", description: "Test run" });
    const res3 = JSON.parse(normalizeToolArguments(input3, "executeCode"));
    expect(res3).toEqual({ code: "print(1)", description: "Test run", intent: "Test run", capturePlot: false, language: "python" });
  });

  test("message serializer maps multimodal image parts and text-only content arrays", () => {
    const multimodalReq: OcxParsedRequest = {
      modelId: "GLM-5.3-Flash",
      context: {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=", detail: "high" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Part 1 " },
              { type: "text", text: "Part 2" },
            ],
          },
        ],
      },
      stream: false,
      options: {},
    };

    const formatted = messagesToQoderFormat(multimodalReq);
    expect(formatted.length).toBe(2);
    expect(formatted[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "high" } },
      ],
    });
    expect(formatted[1]).toEqual({
      role: "user",
      content: "Part 1 Part 2",
    });
  });
  test("message serializer handles string assistant content and array assistant content", () => {
    const req: OcxParsedRequest = {
      modelId: "GLM-5.3-Flash",
      context: {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "Hi! How can I help?" } as any,
          { role: "user", content: "follow up" },
        ],
      },
      stream: false,
      options: {},
    };

    const formatted = messagesToQoderFormat(req);
    expect(formatted.length).toBe(3);
    expect(formatted[1]).toEqual({
      role: "assistant",
      content: "Hi! How can I help?",
    });
  });

  test("message serializer maps Responses-API developer role to system and accepts input_text parts", () => {
    const req: OcxParsedRequest = {
      modelId: "GLM-5.3-Flash",
      context: {
        messages: [
          { role: "developer", content: [{ type: "input_text", text: "You are a helpful assistant." }] } as any,
          { role: "user", content: [{ type: "input_text", text: "hi" }] } as any,
        ],
      },
      stream: false,
      options: {},
    };

    const formatted = messagesToQoderFormat(req);
    expect(formatted.length).toBe(2);
    expect(formatted[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(formatted[1]).toEqual({ role: "user", content: "hi" });
  });

  test("normalizeToolArguments repairs AskUser title and options for Positron schema", () => {
    // Case 1: title missing, options stringified (the observed failure mode).
    const r1 = JSON.parse(normalizeToolArguments(JSON.stringify({ question: "Which column casing should we use for the cleaned dataset?", options: "snake_case, keep_original, ALL_CAPS" }), "AskUser"));
    expect(r1.title).toBe("Which column casing should we use");
    expect(r1.question).toBe("Which column casing should we use for the cleaned dataset?");
    expect(Array.isArray(r1.options)).toBe(true);
    expect(r1.options).toEqual([{ label: "snake_case" }, { label: "keep_original" }, { label: "ALL_CAPS" }]);

    // Case 2: options as object array with extra keys keeps label/description/recommended.
    const r2 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "Impute age?", question: "How should missing ages be handled?", options: [{ label: "Median", recommended: "true" }, { text: "Drop rows", description: "lose 3 rows" }] }), "ask_user"));
    expect(r2.options).toEqual([
      { label: "Median", recommended: true },
      { label: "Drop rows", description: "lose 3 rows" },
    ]);

    // Case 3: scalar options are dropped (schema allows omission, not garbage).
    const r3 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "t", question: "q", options: 42 }), "AskUser"));
    expect("options" in r3).toBe(false);
    expect(r3.title).toBe("t");
    expect(r3.question).toBe("q");

    // Case 4: quoted Chinese options must not be split on enumeration marks.
    const r4 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "下一步", question: "演示已结束。请选择接下来要做的事：", options: "\"继续 diamonds 分析:检查切工、颜色、净度对价格的影响\", \"处理那 20 条尺寸为 0 的异常记录(决定删除或填补)\", \"开始一个新任务(我会描述需求)\"" }), "AskUser"));
    expect(r4.options).toEqual([
      { label: "继续 diamonds 分析:检查切工、颜色、净度对价格的影响" },
      { label: "处理那 20 条尺寸为 0 的异常记录(决定删除或填补)" },
      { label: "开始一个新任务(我会描述需求)" },
    ]);

    // Case 5: newline-separated options are preserved verbatim.
    const r5 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "t", question: "q", options: "删除\n填补\n保留" }), "AskUser"));
    expect(r5.options).toEqual([{ label: "删除" }, { label: "填补" }, { label: "保留" }]);

    // Case 6: stringified JSON array — the observed "label" ghost rows.
    // JSON.parse must win so key tokens never surface as options.
    const r6 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "选项演示", question: "这是一个选项选择的演示,请任选一项:", options: '[{"label":"选项 A:继续数据分析任务"},{"label":"选项 B:开始一个编码任务"}]' }), "AskUser"));
    expect(r6.options).toEqual([
      { label: "选项 A:继续数据分析任务" },
      { label: "选项 B:开始一个编码任务" },
    ]);

    // Case 7: half-formed JSON string keeps key tokens out of the fallback.
    const r7 = JSON.parse(normalizeToolArguments(JSON.stringify({ title: "t", question: "q", options: '"label": "甲", "label": "乙"' }), "AskUser"));
    expect(r7.options).toEqual([{ label: "甲" }, { label: "乙" }]);

    // Case 8: skill tool — schema is {skill: string}; recover from alias keys.
    const r8 = JSON.parse(normalizeToolArguments(JSON.stringify({ name: "modeling" }), "skill"));
    expect(r8.skill).toBe("modeling");
    expect("name" in r8).toBe(false);
    const r8b = JSON.parse(normalizeToolArguments(JSON.stringify({ skill: "cleaning" }), "skill"));
    expect(r8b.skill).toBe("cleaning");
  });
});
