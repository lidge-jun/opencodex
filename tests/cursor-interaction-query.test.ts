import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  AskQuestionInteractionQuerySchema,
  CreatePlanArgsSchema,
  CreatePlanRequestQuerySchema,
  ExaFetchRequestQuerySchema,
  ExaSearchRequestQuerySchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ReadToolCallSchema,
  SetupVmEnvironmentArgsSchema,
  SwitchModeRequestQuerySchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  WebSearchRequestQuerySchema,
  type InteractionQuery,
} from "../src/adapters/cursor/gen/agent_pb";
import { isClientToolFrame, planInteractionQueryReply } from "../src/adapters/cursor/live-transport";

function query(id: number, q: InteractionQuery["query"]): InteractionQuery {
  return create(InteractionQuerySchema, { id, query: q });
}

describe("planInteractionQueryReply", () => {
  test("createPlan is acknowledged with success and surfaces the plan text", () => {
    const plan = planInteractionQueryReply(query(7, {
      case: "createPlanRequestQuery",
      value: create(CreatePlanRequestQuerySchema, {
        args: create(CreatePlanArgsSchema, { name: "Fix bridge", overview: "Two steps.", plan: "1. read\n2. patch" }),
        toolCallId: "call_9",
      }),
    }));
    expect(plan.response.id).toBe(7);
    expect(plan.response.result.case).toBe("createPlanRequestResponse");
    const result = plan.response.result.case === "createPlanRequestResponse" ? plan.response.result.value.result : undefined;
    expect(result?.result.case).toBe("success");
    expect(plan.planText).toContain("Fix bridge");
    expect(plan.planText).toContain("1. read");
  });

  test("askQuestion is rejected so the agent proceeds autonomously", () => {
    const plan = planInteractionQueryReply(query(3, {
      case: "askQuestionInteractionQuery",
      value: create(AskQuestionInteractionQuerySchema, {}),
    }));
    expect(plan.response.id).toBe(3);
    expect(plan.response.result.case).toBe("askQuestionInteractionResponse");
    const result = plan.response.result.case === "askQuestionInteractionResponse" ? plan.response.result.value.result : undefined;
    expect(result?.result.case).toBe("rejected");
    expect(plan.planText).toBeUndefined();
  });

  test.each([
    ["switchModeRequestQuery", SwitchModeRequestQuerySchema, "switchModeRequestResponse"],
  ] as const)("%s is rejected with the matching id", (queryCase, schema, responseCase) => {
    const plan = planInteractionQueryReply(query(11, { case: queryCase, value: create(schema, {}) } as InteractionQuery["query"]));
    expect(plan.response.id).toBe(11);
    expect(plan.response.result.case).toBe(responseCase);
    const value = plan.response.result.value as { result: { case: string } };
    expect(value.result.case).toBe("rejected");
  });

  // web/exa are approve/reject permission gates: approving delegates the search to Cursor's server
  // (which injects results into the model), so opencodex APPROVES instead of rejecting — rejecting
  // killed the model's web capability on the Cursor path.
  test.each([
    ["webSearchRequestQuery", WebSearchRequestQuerySchema, "webSearchRequestResponse"],
    ["exaSearchRequestQuery", ExaSearchRequestQuerySchema, "exaSearchRequestResponse"],
    ["exaFetchRequestQuery", ExaFetchRequestQuerySchema, "exaFetchRequestResponse"],
  ] as const)("%s is approved with the matching id", (queryCase, schema, responseCase) => {
    const plan = planInteractionQueryReply(query(11, { case: queryCase, value: create(schema, {}) } as InteractionQuery["query"]));
    expect(plan.response.id).toBe(11);
    expect(plan.response.result.case).toBe(responseCase);
    const value = plan.response.result.value as { result: { case: string } };
    expect(value.result.case).toBe("approved");
    expect(plan.replyCase).toBe(`${responseCase}:approved`);
  });

  test("setupVmEnvironment fails the turn instead of fabricating success", () => {
    const plan = planInteractionQueryReply(query(5, {
      case: "setupVmEnvironmentArgs",
      value: create(SetupVmEnvironmentArgsSchema, { installCommand: "true", startCommand: "true" }),
    }));
    expect(plan.response.id).toBe(5);
    expect(plan.response.result.case).toBeUndefined();
    expect(plan.replyCase).toBe("unsupported:setupVmEnvironment");
  });

  test("unknown interaction query cases are handled gracefully instead of throwing (#116)", () => {
    const plan = planInteractionQueryReply(
      query(42, { case: undefined, value: undefined } as InteractionQuery["query"]),
    );
    expect(plan.response.id).toBe(42);
    expect(plan.response.result.case).toBeUndefined();
    expect(plan.replyCase).toBe("unsupported:unknown");
    expect(plan.planText).toBeUndefined();
  });
});

describe("isClientToolFrame", () => {
  function startedFrame(toolCall: ReturnType<typeof create<typeof ToolCallSchema>>) {
    return create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: { case: "toolCallStarted", value: create(ToolCallStartedUpdateSchema, { callId: "call_1", toolCall }) },
        }),
      },
    });
  }

  test("ocx-bridged mcpToolCall counts as client tool activity", () => {
    const toolCall = create(ToolCallSchema, {
      tool: {
        case: "mcpToolCall",
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, { name: "exec_command", toolName: "exec_command", toolCallId: "call_1", providerIdentifier: "opencodex-responses" }),
        }),
      },
    });
    expect(isClientToolFrame(startedFrame(toolCall))).toBe(true);
  });

  test("a foreign MCP provider does NOT count as client tool activity", () => {
    const toolCall = create(ToolCallSchema, {
      tool: {
        case: "mcpToolCall",
        value: create(McpToolCallSchema, {
          args: create(McpArgsSchema, { name: "search", toolName: "search", toolCallId: "call_2", providerIdentifier: "some-real-mcp" }),
        }),
      },
    });
    expect(isClientToolFrame(startedFrame(toolCall))).toBe(false);
  });

  test("a Cursor-native readToolCall does NOT revoke client-tool finalize", () => {
    const toolCall = create(ToolCallSchema, {
      tool: { case: "readToolCall", value: create(ReadToolCallSchema, {}) },
    });
    expect(isClientToolFrame(startedFrame(toolCall))).toBe(false);
  });
});

describe("partialUsageFromEventState", () => {
  test("reports checkpoint-derived cumulative usage on failure", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    const state = createCursorProtobufEventState();
    state.usage.outputTokens = 42;
    state.contextTokens = 10_300;
    expect(partialUsageFromEventState(state)).toEqual({
      inputTokens: 10_258,
      outputTokens: 42,
      totalTokens: 10_300,
      estimated: true,
    });
  });

  test("reports output-only usage without a checkpoint", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    const state = createCursorProtobufEventState();
    state.usage.outputTokens = 7;
    expect(partialUsageFromEventState(state)).toEqual({ inputTokens: 0, outputTokens: 7, estimated: true });
  });

  test("uses the request-local estimate after output when no checkpoint or carry exists", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    const state = createCursorProtobufEventState({ estimatedInputTokens: 1_200 });
    state.usage.outputTokens = 7;
    expect(partialUsageFromEventState(state)).toEqual({
      inputTokens: 1_200,
      outputTokens: 7,
      totalTokens: 1_207,
      estimated: true,
    });
  });

  test("carries prior context usage on failure when the current turn had no checkpoint", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorContextUsageTracker, createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_conv_1", 18_000);
    const state = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });
    state.usage.outputTokens = 8;
    expect(partialUsageFromEventState(state)).toEqual({
      inputTokens: 17_992,
      outputTokens: 8,
      totalTokens: 18_000,
      estimated: true,
    });
  });

  test("returns undefined when the stream died before any token signal", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    expect(partialUsageFromEventState(createCursorProtobufEventState())).toBeUndefined();
  });

  test("does not report seeded carry when a fresh turn failed before any token signal", async () => {
    const { partialUsageFromEventState } = await import("../src/adapters/cursor/live-transport");
    const { createCursorContextUsageTracker, createCursorProtobufEventState } = await import("../src/adapters/cursor/protobuf-events");
    const tracker = createCursorContextUsageTracker();
    tracker.record("cursor_conv_1", 18_000);

    const state = createCursorProtobufEventState({
      contextUsage: tracker.controlsForConversation("cursor_conv_1"),
    });

    expect(partialUsageFromEventState(state)).toBeUndefined();
  });
});
