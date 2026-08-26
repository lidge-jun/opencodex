import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";

const PROVIDER = "opencodex-responses";

async function withH2Server<T>(
  handler: (stream: http2.ServerHttp2Stream) => void,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function toolCallStartedFrame(callId: string, toolName: string): Uint8Array {
  const toolCall = create(ToolCallSchema, {
    tool: {
      case: "mcpToolCall",
      value: create(McpToolCallSchema, {
        args: create(McpArgsSchema, { name: toolName, toolName, toolCallId: callId, providerIdentifier: PROVIDER }),
      }),
    },
  });
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: {
          case: "toolCallStarted",
          value: create(ToolCallStartedUpdateSchema, { callId, modelCallId: callId, toolCall }),
        },
      }),
    },
  });
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function clientToolArgsFrame(callId: string, toolName: string, argText: string): Uint8Array {
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 1,
        execId: `exec-${callId}`,
        message: {
          case: "mcpArgs",
          value: create(McpArgsSchema, {
            name: toolName,
            toolName,
            toolCallId: callId,
            providerIdentifier: PROVIDER,
            args: { text: new TextEncoder().encode(JSON.stringify(argText)) },
          }),
        },
      }),
    },
  });
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Uint8Array {
  const message = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  });
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, message));
}

function emptyFrame(): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {})));
}

function cleanConnectEndFrame(): Uint8Array {
  return encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true });
}

function runRequest(tools?: CursorRunRequest["tools"]): CursorRunRequest {
  return {
    modelId: "composer-2",
    conversationId: "cursor_eof_terminal_test",
    system: [],
    messages: [{ role: "user", content: "hello" }],
    ...(tools ? { tools } : {}),
  } as CursorRunRequest;
}

const APPLY_PATCH_TOOL = [{
  name: "apply_patch",
  description: "apply a patch",
  parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
  freeform: true,
}] as unknown as CursorRunRequest["tools"];

const ECHO_TOOL = [{
  name: "echo_a",
  description: "echo text",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}] as unknown as CursorRunRequest["tools"];

const ECHO_AND_APPLY_PATCH_TOOLS = [
  ...(ECHO_TOOL ?? []),
  ...(APPLY_PATCH_TOOL ?? []),
] as CursorRunRequest["tools"];

async function drain(baseUrl: string, request: CursorRunRequest): Promise<{
  messages: CursorServerMessage[];
  failure?: Error;
}> {
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    firstFrameTimeoutMs: 2_000,
  });
  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  try {
    for await (const message of transport.run(request)) messages.push(message);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    await transport.close?.();
  }
  return { messages, failure };
}

function respondWith(frames: Uint8Array[]): (stream: http2.ServerHttp2Stream) => void {
  return stream => {
    stream.on("error", () => {});
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    for (const frame of frames) stream.write(Buffer.from(frame));
    stream.end();
  };
}

describe("Cursor clean-EOF terminal gate", () => {
  test("EOF with an open tool call reports a truncation error, not a silent finish", async () => {
    await withH2Server(respondWith([toolCallStartedFrame("call_open_1", "apply_patch")]), async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest(APPLY_PATCH_TOOL));

      // dev's shape wins (integration 010): the truncation surfaces as a fail-closed adapter
      // EVENT from finalizeTurnEvents, not a thrown transport error. Throwing would hide the
      // domain-specific message behind a generic adapter_eof.
      expect(failure).toBeUndefined();
      const terminal = messages.at(-1);
      expect(terminal?.type).toBe("error");
      expect((terminal as { message?: string }).message).toContain("call_open_1");
      // The deferred call never became a committed tool call.
      expect(messages.some(m => m.type === "tool_call_end")).toBe(false);
      expect(messages.some(m => m.type === "done")).toBe(false);
    });
  });

  test("EOF after a real turnEnded still finishes gracefully", async () => {
    await withH2Server(respondWith([emptyFrame(), turnEndedFrame()]), async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest());

      expect(failure).toBeUndefined();
      expect(messages.some(m => m.type === "done")).toBe(true);
    });
  });

  test("clean Connect END_STREAM finishes before a held-open HTTP body (#2300)", async () => {
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(turnEndedFrame()));
      stream.write(Buffer.from(cleanConnectEndFrame()));
      // Model Cursor's observed shape: the protocol has ended, but the HTTP body has not. The
      // fallback keeps the pre-fix test bounded; correct code returns well before it fires.
      fallback = setTimeout(() => {
        try { stream.end(); } catch { /* transport already closed */ }
      }, 500);
    }, async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest());
      expect(failure).toBeUndefined();
      expect(messages.filter(message => message.type === "done")).toHaveLength(1);
    });
    if (fallback) clearTimeout(fallback);
    expect(Date.now() - startedAt).toBeLessThan(450);
  });

  test("clean Connect END_STREAM wins over an immediate abort-shaped body teardown (#2300)", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(turnEndedFrame()));
      stream.write(Buffer.from(cleanConnectEndFrame()));
      setImmediate(() => {
        const abort = new Error("The operation was aborted");
        abort.name = "AbortError";
        stream.destroy(abort);
      });
    }, async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest());
      expect(failure).toBeUndefined();
      expect(messages.filter(message => message.type === "done")).toHaveLength(1);
      expect(messages.some(message => message.type === "error")).toBe(false);
    });
  });

  test("clean Connect END_STREAM preserves a drained client-tool terminal before its grace timer", async () => {
    await withH2Server(respondWith([
      toolCallStartedFrame("call_client_1", "echo_a"),
      clientToolArgsFrame("call_client_1", "echo_a", "A"),
      cleanConnectEndFrame(),
    ]), async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest(ECHO_TOOL));

      expect(failure).toBeUndefined();
      expect(messages.filter(message => message.type === "tool_call_end")).toHaveLength(1);
      expect(messages.filter(message => message.type === "done")).toHaveLength(1);
      expect(messages.some(message => message.type === "error")).toBe(false);
    });
  });

  test("clean Connect END_STREAM keeps a later open sibling fail-closed after a client-tool drain", async () => {
    await withH2Server(respondWith([
      toolCallStartedFrame("call_client_2", "echo_a"),
      clientToolArgsFrame("call_client_2", "echo_a", "A"),
      toolCallStartedFrame("call_open_2", "apply_patch"),
      cleanConnectEndFrame(),
    ]), async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest(ECHO_AND_APPLY_PATCH_TOOLS));

      expect(failure).toBeUndefined();
      expect(messages.filter(message => message.type === "tool_call_end")).toHaveLength(1);
      const terminal = messages.at(-1);
      expect(terminal?.type).toBe("error");
      expect((terminal as { message?: string }).message).toContain("call_open_2");
      expect(messages.some(message => message.type === "done")).toBe(false);
    });
  });

  test("EOF with no open tool call keeps its existing graceful finish", async () => {
    await withH2Server(respondWith([emptyFrame()]), async baseUrl => {
      const { failure } = await drain(baseUrl, runRequest());

      // Deliberately unchanged: the bridge turns a terminal-less EOF into
      // response.incomplete / adapter_eof. Only the open-call case is a failure.
      expect(failure).toBeUndefined();
    });
  });

  test("a completed turn with no tool calls is unaffected by the gate", async () => {
    await withH2Server(respondWith([turnEndedFrame()]), async baseUrl => {
      const { messages, failure } = await drain(baseUrl, runRequest(APPLY_PATCH_TOOL));

      expect(failure).toBeUndefined();
      expect(messages.some(m => m.type === "done")).toBe(true);
    });
  });
});
