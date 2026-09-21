import { describe, expect, test } from "bun:test";
import {
  analyzeTerminalTurn,
  buildContinuationRequest,
  guardTerminalEventStream,
  isTerminalGuardPassthroughOnly,
} from "../../src/server/responses/terminal-guard";
import { buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent, OcxParsedRequest } from "../../src/types";

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

  test("does not force tools for an ordinary plan/proposal request without explicit tool prohibition", () => {
    // Regression (#394 review blocker 2): a plain 'write a concise implementation plan' request
    // must NOT be treated as a suspicious no-tool completion, even though it contains the
    // actionable verbs 'write'/'implementation'. Otherwise the guard nudges Claude to run tools
    // against a plan-only ask, causing side effects.
    for (const ask of [
      "Write a concise implementation plan for this change",
      "Give me a high-level plan before we start",
      "Draft a migration plan for the schema",
      "Propose an approach for refactoring the router",
      "先写一个实现方案",
      "给我一个重构计划",
    ]) {
      const analysis = analyzeTerminalTurn(parsed(ask), [
        { type: "text_delta", text: "Here is the plan: 1) ... 2) ... 3) ..." },
        { type: "done" },
      ]);
      expect(analysis.decision).toBe("pass");
      expect(analysis.reason).toBe("no_actionable_request");
    }
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


  // A heartbeat is adapter liveness, not turn content. The openai-chat adapter emits one per
  // tool-call delta while it buffers, so retaining them here would let a single large argument
  // payload grow `seen` without bound — and `seen` is what both the continuation analysis and
  // the rebuilt request read. Passing them through unretained is what the empty-completion
  // guard already does.
  // A heartbeat is adapter liveness, not turn content. The openai-chat adapter emits one per
  // tool-call delta while it buffers, so retaining them would grow the guard's record without
  // bound on a large argument payload. `analyzeTerminalTurn` and `buildContinuationRequest`
  // both read that record, so pin the contract on the pure functions that consume it plus the
  // observable passthrough.
  test("a retained heartbeat would corrupt the continuation record", () => {
    const clean: AdapterEvent[] = [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
    ];
    const padded: AdapterEvent[] = [
      { type: "text_delta", text: "我接下来会修改相关文件。" },
      ...Array.from({ length: 50 }, () => ({ type: "heartbeat" }) as AdapterEvent),
    ];
    const request = parsed("继续检查");
    // The guard must not let liveness markers change what the continuation decides or sends.
    expect(analyzeTerminalTurn(request, padded).assistantText)
      .toBe(analyzeTerminalTurn(request, clean).assistantText);
    // Compare the CONTENT of the two rebuilds, not their wall-clock stamps. Each call reads the
    // clock once (see the next test), but two separate calls legitimately land in different
    // milliseconds — comparing raw JSON made this assert the scheduler rather than the heartbeat
    // contract, and it failed intermittently on CI for exactly that reason.
    const withoutTimestamps = (events: AdapterEvent[]) =>
      JSON.stringify(buildContinuationRequest(request, events).context.messages
        .map(({ timestamp: _timestamp, ...rest }) => rest));
    expect(withoutTimestamps(padded)).toBe(withoutTimestamps(clean));
  });

  // The rebuild used to read the clock twice — once for the assistant message, once for the
  // nudge pushed after it — so a millisecond boundary between the two reads gave one rebuild two
  // different timestamps. That is what made the contract test above fail intermittently on CI
  // (shard 2/4, twice in a row) while passing locally: the compared records differed by 1ms.
  // Pin the invariant on the rebuild itself rather than on the comparison that exposed it.
  test("one rebuild carries a single timestamp across a millisecond boundary", () => {
    const events: AdapterEvent[] = [{ type: "text_delta", text: "我接下来会修改相关文件。" }];
    const request = parsed("继续检查");
    // Sample across real boundary crossings: a single-shot assertion passes even on the
    // two-clock-read version whenever both reads land in the same millisecond.
    const deadline = Date.now() + 25;
    let sampled = 0;
    while (Date.now() < deadline) {
      const messages = buildContinuationRequest(request, events).context.messages;
      const assistant = messages.at(-2);
      const nudge = messages.at(-1);
      expect(assistant?.role).toBe("assistant");
      expect(nudge?.role).toBe("developer");
      expect(assistant?.timestamp).toBe(nudge?.timestamp);
      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(0);
  });

  test("heartbeats reach the consumer so the bridge watchdog stays armed", async () => {
    const actual: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("继续检查"),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "我接下来会修改相关文件。" } as AdapterEvent;
        for (let i = 0; i < 50; i++) yield { type: "heartbeat" } as AdapterEvent;
        yield { type: "tool_call_start", id: "call_1", name: "exec_command" } as AdapterEvent;
        yield { type: "tool_call_end" } as AdapterEvent;
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } } as AdapterEvent;
      })(),
      continuation: () => (async function* () {
        yield { type: "done" } as AdapterEvent;
      })(),
      adapterName: "openai-chat",
    })) actual.push(event);

    expect(actual.filter(event => event.type === "heartbeat")).toHaveLength(50);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
  });

  test("does not retain passthrough-only liveness or tool argument fragments", () => {
    expect(isTerminalGuardPassthroughOnly({ type: "heartbeat" })).toBe(true);
    expect(isTerminalGuardPassthroughOnly({
      type: "tool_call_delta",
      arguments: "x".repeat(1024 * 1024),
    })).toBe(true);
    expect(isTerminalGuardPassthroughOnly({ type: "tool_call_start", id: "call_1", name: "exec_command" })).toBe(false);
    expect(isTerminalGuardPassthroughOnly({ type: "text_delta", text: "working" })).toBe(false);
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

  test("guards an openai-chat stream (opted-in provider) with one continuation", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("请检查这个问题并修复代码"),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "我接下来会修改相关文件。" } as AdapterEvent;
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } } as AdapterEvent;
      })(),
      continuation: () => {
        continuations += 1;
        return (async function* () {
          yield { type: "tool_call_start", id: "call_1", name: "exec_command" } as AdapterEvent;
          yield { type: "tool_call_end" } as AdapterEvent;
          yield { type: "done", usage: { inputTokens: 20, outputTokens: 3 } } as AdapterEvent;
        })();
      },
      adapterName: "openai-chat",
    })) actual.push(event);

    expect(continuations).toBe(1);
    expect(actual.some(event => event.type === "assistant_boundary")).toBe(true);
    expect(actual.filter(event => event.type === "done")).toHaveLength(1);
  });

  test("does not guard adapters other than anthropic/openai-chat", async () => {
    let continuations = 0;
    const actual: AdapterEvent[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("请检查这个问题并修复代码"),
      firstEvents: (async function* () {
        yield { type: "text_delta", text: "我接下来会修改相关文件。" } as AdapterEvent;
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } } as AdapterEvent;
      })(),
      continuation: () => {
        continuations += 1;
        return (async function* () {
          yield { type: "done" } as AdapterEvent;
        })();
      },
      adapterName: "openai-responses",
    })) actual.push(event);

    expect(continuations).toBe(0);
    expect(actual.some(event => event.type === "assistant_boundary")).toBe(false);
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

describe("terminal guard bounded retention", () => {
  const announcement: AdapterEvent = { type: "text_delta", text: "Let me check." };
  const done: AdapterEvent = { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
  const contentLimit = 64 * 1_024;

  /**
   * Collect one guarded fixture and the continuation requests it actually makes.
   * @param events Adapter events supplied in their original order.
   * @param adapterName Adapter whose existing guard policy is exercised.
   * @param maxAutoContinuations Allowed internal re-asks for this fixture.
   * @returns Forwarded events and captured requests, without mutating the input events.
   */
  async function run(events: AdapterEvent[], adapterName: string, maxAutoContinuations = 1) {
    const actual: AdapterEvent[] = [];
    const requests: OcxParsedRequest[] = [];
    for await (const event of guardTerminalEventStream({
      parsed: parsed("Check and fix this code"),
      adapterName,
      maxAutoContinuations,
      firstEvents: (async function* () { yield* events; })(),
      continuation: next => {
        requests.push(next);
        return (async function* (): AsyncGenerator<AdapterEvent> {
          yield { type: "done", usage: { inputTokens: 20, outputTokens: 3 } };
        })();
      },
    })) actual.push(event);
    return { actual, requests };
  }

  for (const adapterName of ["anthropic", "openai-chat"]) {
    describe(adapterName, () => {
      for (const count of [1_024, 1_025]) {
        test(`retained event count ${count} respects the inclusive limit`, async () => {
          const events: AdapterEvent[] = [announcement];
          for (let i = 1; i < count; i += 1) events.push({ type: "text_delta", text: "" });
          events.push(done);
          const { actual, requests } = await run(events, adapterName);
          expect(requests).toHaveLength(count === 1_024 ? 1 : 0);
          // Each input content event reaches the consumer unchanged, even beyond the cap.
          for (let i = 0; i < count; i += 1) expect(actual[i]).toBe(events[i]);
          expect(actual.filter(event => event.type === "done")).toHaveLength(1);
        });
      }

      const reasoningEvents: Array<[string, (content: string) => AdapterEvent]> = [
        ["thinking", thinking => ({ type: "thinking_delta", thinking })],
        ["signature", signature => ({ type: "thinking_signature", signature })],
        ["redacted", data => ({ type: "redacted_thinking", data })],
      ];
      for (const [name, makeEvent] of reasoningEvents) {
        for (const extra of [0, 1]) {
          test(`${name} content limit plus ${extra} never replays a truncated prefix`, async () => {
            const payload = makeEvent("x".repeat(contentLimit - "Let me check.".length + extra));
            const { actual, requests } = await run([announcement, payload, done], adapterName);
            expect(requests).toHaveLength(extra === 0 ? 1 : 0);
            expect(actual[0]).toBe(announcement);
            expect(actual[1]).toBe(payload);
            expect(actual.at(-1)).toMatchObject({
              type: "done", usage: extra === 0
                ? { inputTokens: 30, outputTokens: 5, totalTokens: 35 }
                : { inputTokens: 10, outputTokens: 2 },
            });
          });
        }
      }

      test("content accounting adds different reasoning kinds together", async () => {
        const { actual, requests } = await run([
          announcement,
          { type: "thinking_delta", thinking: "x".repeat(32 * 1_024) },
          { type: "thinking_signature", signature: "s".repeat(16 * 1_024) },
          { type: "redacted_thinking", data: "r".repeat(16 * 1_024) },
          done,
        ], adapterName);
        expect(requests).toHaveLength(0);
        expect(actual).toHaveLength(5);
      });

      test("text length follows trimmed announcement semantics across split whitespace", async () => {
        for (const length of [280, 281]) {
          const { requests } = await run([
            { type: "text_delta", text: " \n".repeat(200) },
            { type: "text_delta", text: "Let me check. " + "x".repeat(length - 14) },
            { type: "text_delta", text: "\t ".repeat(200) },
            done,
          ], adapterName);
          expect(requests).toHaveLength(length === 280 ? 1 : 0);
        }
      });

      test("passthrough-only events do not spend the retention allowance", async () => {
        const events: AdapterEvent[] = [announcement];
        for (let i = 0; i < 1_100; i += 1) {
          events.push({ type: "heartbeat" });
          events.push({ type: "tool_call_delta", arguments: "x".repeat(100) });
        }
        events.push(done);
        const { actual, requests } = await run(events, adapterName);
        expect(requests).toHaveLength(1);
        for (let i = 0; i < events.length - 1; i += 1) expect(actual[i]).toBe(events[i]);
      });

      const disablingEvents: Array<[string, AdapterEvent]> = [
        ["tool start", { type: "tool_call_start", id: "call_1", name: "exec_command" }],
        ["long text", { type: "text_delta", text: "x".repeat(281) }],
        ["oversized reasoning", { type: "thinking_delta", thinking: "x".repeat(contentLimit + 1) }],
      ];
      for (const [name, disablingEvent] of disablingEvents) {
        test(`${name} permanently stops payload analysis while forwarding later events`, async () => {
          let reads = 0;
          const probe: AdapterEvent = {
            type: "text_delta",
            get text() { reads += 1; return "Let me check again."; },
          };
          const events: AdapterEvent[] = [announcement, disablingEvent];
          for (let i = 0; i < 2_000; i += 1) events.push(probe);
          events.push(done);
          const { actual, requests } = await run(events, adapterName);
          expect(reads).toBe(0);
          expect(requests).toHaveLength(0);
          expect(actual).toHaveLength(events.length);
          for (let i = 0; i < events.length - 1; i += 1) expect(actual[i]).toBe(events[i]);
          // Terminal usage is preserved through the existing shallow-copy path.
          expect(actual.at(-1)).toEqual(done);
        });
      }

      const terminals: Array<[string, AdapterEvent | undefined]> = [
        ["EOF", undefined],
        ["max tokens", { type: "done", stopReason: "max_tokens" }],
        ["content filter", { type: "done", stopReason: "content_filter" }],
        ["incomplete", { type: "incomplete", reason: "content_filter", retryable: false }],
        ["error", { type: "error", message: "upstream failed", retryable: false }],
      ];
      for (const [name, terminal] of terminals) {
        test(`overflow preserves ${name} without manufacturing a successful terminal`, async () => {
          const events: AdapterEvent[] = [announcement, { type: "thinking_delta", thinking: "x".repeat(contentLimit) }];
          if (terminal) events.push(terminal);
          const { actual, requests } = await run(events, adapterName);
          expect(requests).toHaveLength(0);
          expect(actual).toHaveLength(events.length);
          for (let i = 0; i < events.length; i += 1) expect(actual[i]).toBe(events[i]);
        });
      }

      test("bounded continuation replays complete thinking, signature and redacted data", async () => {
        const { requests } = await run([
          { type: "thinking_delta", thinking: "reasoning" },
          { type: "thinking_signature", signature: "signature" },
          { type: "redacted_thinking", data: "redacted" },
          announcement, done,
        ], adapterName);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.context.messages.at(-2)).toMatchObject({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reasoning", signature: "signature", redacted: ["redacted"] },
            { type: "text", text: "Let me check." },
          ],
        });
      });

      test("each allowed continuation gets fresh retention counters and preserves usage", async () => {
        let continuations = 0;
        const actual: AdapterEvent[] = [];
        const turn = async function* (): AsyncGenerator<AdapterEvent> {
          yield announcement;
          yield { type: "thinking_delta", thinking: "x".repeat(40 * 1_024) };
          for (let i = 0; i < 600; i += 1) yield { type: "text_delta", text: "" };
          yield done;
        };
        for await (const event of guardTerminalEventStream({
          parsed: parsed("Check and fix this code"), adapterName, maxAutoContinuations: 2,
          firstEvents: turn(), continuation: () => { continuations += 1; return turn(); },
        })) actual.push(event);
        expect(continuations).toBe(2);
        expect(actual.filter(event => event.type === "assistant_boundary")).toHaveLength(2);
        expect(actual.filter(event => event.type === "done")).toHaveLength(1);
        expect(actual.at(-1)).toMatchObject({ usage: { inputTokens: 30, outputTokens: 6, totalTokens: 36 } });
      });

      test("an exhausted continuation allowance does not inspect content", async () => {
        let reads = 0;
        const probe: AdapterEvent = { type: "text_delta", get text() { reads += 1; return "Let me check."; } };
        const { actual, requests } = await run([probe, done], adapterName, 0);
        expect(reads).toBe(0);
        expect(requests).toHaveLength(0);
        expect(actual[0]).toBe(probe);
      });
    });
  }
});

describe("terminal guard lifecycle and accounting", () => {
  const announcement: AdapterEvent = { type: "text_delta", text: "Let me check." };

  for (const adapterName of ["anthropic", "openai-chat"]) {
    describe(adapterName, () => {
      for (const asynchronous of [false, true]) {
        test(`${asynchronous ? "async" : "sync"} continuation startup failure preserves reported usage`, async () => {
          const usage = {
            inputTokens: 10, outputTokens: 2, cachedInputTokens: 3,
            cacheReadInputTokens: 3, cacheCreationInputTokens: 1,
            reasoningOutputTokens: 1, estimated: true,
          };
          const failure = new Error("continuation setup failed");
          const actual: AdapterEvent[] = [];
          let calls = 0;
          for await (const event of guardTerminalEventStream({
            parsed: parsed("Check and fix this code"), adapterName,
            firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
              yield announcement;
              yield { type: "done", usage };
            })(),
            continuation: () => {
              calls += 1;
              if (asynchronous) return Promise.reject(failure);
              throw failure;
            },
          })) actual.push(event);
          expect(calls).toBe(1);
          expect(actual).toEqual([
            announcement, { type: "assistant_boundary" },
            { type: "error", message: failure.message, usage },
          ]);
        });
      }

      test("startup failure after two completed legs keeps their aggregate usage", async () => {
        let calls = 0;
        const actual: AdapterEvent[] = [];
        const turn = async function* (): AsyncGenerator<AdapterEvent> {
          yield announcement;
          yield { type: "done", usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 } };
        };
        for await (const event of guardTerminalEventStream({
          parsed: parsed("Check and fix this code"), adapterName, maxAutoContinuations: 2,
          firstEvents: turn(),
          continuation: () => {
            calls += 1;
            if (calls === 1) return turn();
            throw new Error("second continuation setup failed");
          },
        })) actual.push(event);
        expect(calls).toBe(2);
        expect(actual.filter(event => event.type === "assistant_boundary")).toHaveLength(2);
        expect(actual.filter(event => event.type === "done")).toHaveLength(0);
        expect(actual.at(-1)).toEqual({
          type: "error", message: "second continuation setup failed",
          usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24, cachedInputTokens: 6 },
        });
      });

      test("startup failure does not fabricate unknown usage", async () => {
        const actual: AdapterEvent[] = [];
        for await (const event of guardTerminalEventStream({
          parsed: parsed("Check and fix this code"), adapterName,
          firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
            yield announcement;
            yield { type: "done" };
          })(),
          continuation: () => { throw "continuation unavailable"; },
        })) actual.push(event);
        expect(actual.at(-1)).toEqual({ type: "error", message: "continuation unavailable" });
        expect(Object.hasOwn(actual.at(-1)!, "usage")).toBe(false);
        expect(actual.filter(event => event.type === "done")).toHaveLength(0);
      });

      for (const atBoundary of [false, true]) {
        test(`consumer cancellation ${atBoundary ? "at boundary" : "during content"} closes the source without a continuation`, async () => {
          let closed = false;
          let calls = 0;
          const stream = guardTerminalEventStream({
            parsed: parsed("Check and fix this code"), adapterName,
            firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
              try {
                yield announcement;
                yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
              } finally {
                closed = true;
              }
            })(),
            continuation: () => {
              calls += 1;
              return (async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; })();
            },
          });
          expect((await stream.next()).value).toBe(announcement);
          if (atBoundary) expect((await stream.next()).value).toEqual({ type: "assistant_boundary" });
          expect((await stream.return(undefined)).done).toBe(true);
          expect(closed).toBe(true);
          expect(calls).toBe(0);
        });
      }

      test("source iteration exceptions propagate without manufacturing success", async () => {
        const failure = new Error("source read failed");
        const actual: AdapterEvent[] = [];
        let caught: unknown;
        let calls = 0;
        let closed = false;
        try {
          for await (const event of guardTerminalEventStream({
            parsed: parsed("Check and fix this code"), adapterName,
            firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
              try {
                yield announcement;
                throw failure;
              } finally {
                closed = true;
              }
            })(),
            continuation: () => {
              calls += 1;
              return (async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; })();
            },
          })) actual.push(event);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(failure);
        expect(actual).toEqual([announcement]);
        expect(closed).toBe(true);
        expect(calls).toBe(0);
      });

      for (const extra of [0, 1]) {
        test(`Unicode content limit plus ${extra} counts code units rather than UTF-8 bytes`, async () => {
          const length = 64 * 1_024 - "Let me check.".length + extra;
          const thinking = "😀".repeat(Math.floor(length / 2)) + (length % 2 ? "x" : "");
          let calls = 0;
          for await (const _event of guardTerminalEventStream({
            parsed: parsed("Check and fix this code"), adapterName,
            firstEvents: (async function* (): AsyncGenerator<AdapterEvent> {
              yield announcement;
              yield { type: "thinking_delta", thinking };
              yield { type: "done" };
            })(),
            continuation: () => {
              calls += 1;
              return (async function* (): AsyncGenerator<AdapterEvent> { yield { type: "done" }; })();
            },
          })) {
            // Consume the stream without retaining its content in the test.
          }
          expect(thinking.length).toBe(length);
          expect(calls).toBe(extra === 0 ? 1 : 0);
        });
      }
    });
  }
});
