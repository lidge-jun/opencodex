import { describe, expect, test } from "bun:test";
import {
  analyzeTerminalTurn,
  buildContinuationRequest,
  guardTerminalEventStream,
} from "../src/server/responses/terminal-guard";
import { buildResponseJSON } from "../src/bridge";
import type { AdapterEvent, OcxParsedRequest } from "../src/types";

function parsed(userText: string, withTools = true): OcxParsedRequest {
  return {
    modelId: "se-claude-opus-4.8",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: userText, timestamp: 1 }],
      ...(withTools ? { tools: [{ name: "exec_command", description: "run a command", parameters: {} }] } : {}),
    },
  };
}

describe("terminal guard", () => {
  test("recognizes an actionable no-tool completion as suspicious", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查这个问题并修复代码"), [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
    expect(analysis.hasToolCall).toBe(false);
  });

  test("treats an explicit continue command as actionable", () => {
    const analysis = analyzeTerminalTurn(parsed("继续"), [
      { type: "text_delta", text: "Let me poll again for completion." },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
  });

  test("does not continue when the user explicitly requested a plan without tool execution", () => {
    const analysis = analyzeTerminalTurn(parsed("先给我一个修改方案，暂时不要调用工具，只回复计划"), [
      { type: "text_delta", text: "我会先列出修改计划。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
  });

  test("does not auto-repeat an explicit continue after a recent tool-backed turn", () => {
    const request = parsed("继续");
    request.context.messages = [
      { role: "user", content: "请检查代码", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
      { role: "user", content: "继续", timestamp: 4 },
    ];

    const analysis = analyzeTerminalTurn(request, [
      { type: "text_delta", text: "已经完成了。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("recent_tool_activity");
  });

  test("continues when the last assistant message was a plan-only stop after earlier tools", () => {
    const request = parsed("继续");
    request.context.messages = [
      { role: "user", content: "请检查代码", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "ok", isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "Let me verify the final result." }], timestamp: 4 },
      { role: "user", content: "继续", timestamp: 5 },
    ];

    const analysis = analyzeTerminalTurn(request, [
      { type: "text_delta", text: "Let me poll again for completion." },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
  });

  test("continues a Chinese progress plan after earlier tools when the user says continue", () => {
    const request = parsed("继续");
    request.context.messages = [
      { role: "user", content: "请查清账户信息表的真实来源", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "exec_command", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "exec_command", content: "凭据已读出", isError: false, timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "直连预发账库时，我得用刚从 AppConfigStore 读出的凭据。" }], timestamp: 4 },
      { role: "user", content: "继续", timestamp: 5 },
    ];

    const analysis = analyzeTerminalTurn(request, [
      { type: "text_delta", text: "让我用 AppConfigStore 读出完整服务凭据并直接给 pymysql，查那张账户信息表。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("continue");
  });

  test("does not continue a normal explanatory answer", () => {
    const analysis = analyzeTerminalTurn(parsed("为什么会出现这个错误？", false), [
      { type: "text_delta", text: "这是因为请求在上游被限流。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
  });

  test("does not continue a substantive final answer that merely contains a completion phrase", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查这个问题并给出分析"), [
      { type: "text_delta", text: `已完成分析。${"这是完整结论和依据。".repeat(30)}` },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("substantive_answer");
  });

  test("does not continue after a real tool call", () => {
    const analysis = analyzeTerminalTurn(parsed("请检查并修复代码"), [
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "text_delta", text: "已完成。" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.hasToolCall).toBe(true);
  });

  test("does not auto-continue an explicit clarification question", () => {
    const analysis = analyzeTerminalTurn(parsed("请修复这个问题"), [
      { type: "text_delta", text: "需要我修改哪个文件？" },
      { type: "done" },
    ]);

    expect(analysis.decision).toBe("pass");
    expect(analysis.reason).toBe("waiting_for_user");
  });

  test("builds an internal continuation request without changing the original history", () => {
    const original = parsed("请检查这个问题并修复代码");
    const next = buildContinuationRequest(original, [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
      { type: "done" },
    ]);

    expect(original.context.messages).toHaveLength(1);
    expect(next.context.messages).toHaveLength(3);
    expect(next.context.messages[1]).toMatchObject({ role: "assistant" });
    expect(next.context.messages[2]).toMatchObject({ role: "developer" });
  });

  test("can guard a fetch-based adapter stream with a continuation callback", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("请检查这个问题并修复代码"),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "我接下来会修改相关文件。" } as AdapterEvent;
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } } as AdapterEvent;
      })(),
      continuation: next => {
        continuations += 1;
        expect(next.context.messages.at(-1)).toMatchObject({ role: "developer" });
        return (async function* () {
          yield { type: "tool_call_start", id: "call_1", name: "exec_command" } as AdapterEvent;
          yield { type: "tool_call_end" } as AdapterEvent;
          yield { type: "done", usage: { inputTokens: 20, outputTokens: 3 } } as AdapterEvent;
        })();
      },
      adapterName: "anthropic",
    })) actual.push(event);

    expect(continuations).toBe(1);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
    expect(actual.some(event => event.type === "assistant_boundary")).toBe(true);
    expect(actual.at(-1)).toMatchObject({ usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } });
  });

  test("stops after the configured continuation bound", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    const suspicious = () => (async function* () {
      yield { type: "text_delta", text: "Let me check again." } as AdapterEvent;
      yield { type: "done" } as AdapterEvent;
    })();

    for await (const event of guardTerminalEventStream({
      parsed: parsed("继续"),
      firstEvents: suspicious(),
      continuation: () => {
        continuations += 1;
        return suspicious();
      },
      adapterName: "anthropic",
      maxAutoContinuations: 1,
    })) actual.push(event);

    expect(continuations).toBe(1);
    expect(actual.filter(event => event.type === "assistant_boundary")).toHaveLength(1);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
  });

  test("serializes the guarded boundary as separate assistant output items", () => {
    const response = buildResponseJSON([
      { type: "text_delta", text: "我接下来会修改。" },
      { type: "assistant_boundary" },
      { type: "tool_call_start", id: "call_1", name: "exec_command" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "se-claude-opus-4.8");

    expect((response.output as { type: string }[]).map(item => item.type)).toEqual(["message", "function_call"]);
  });
});
