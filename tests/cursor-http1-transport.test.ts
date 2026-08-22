import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  BidiRequestIdSchema,
  CreatePlanArgsSchema,
  CreatePlanRequestQuerySchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  McpArgsSchema,
  McpToolCallSchema,
  TextDeltaUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { decodeConnectFrame, encodeConnectFrame } from "../src/adapters/cursor/framing";
import {
  cursorBidiAppendRequestSize,
  encodeCursorBidiAppendRequest,
} from "../src/adapters/cursor/http1-bidi";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

interface DecodedAppend {
  data: string;
  requestId: string;
  appendSeqno: bigint;
}

function readVarint(bytes: Uint8Array, offset: number): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  while (offset < bytes.byteLength) {
    const byte = bytes[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
    if (shift > 63n) throw new Error("fixture varint is too large");
  }
  throw new Error("fixture varint is incomplete");
}

function decodeAppend(bytes: Uint8Array): DecodedAppend {
  let offset = 0;
  let data = "";
  let requestId = "";
  let appendSeqno = 0n;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const field = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      const value = bytes.subarray(offset, end);
      offset = end;
      if (field === 1) data = new TextDecoder().decode(value);
      if (field === 2) requestId = fromBinary(BidiRequestIdSchema, value).requestId;
      continue;
    }
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      if (field === 3) appendSeqno = value.value;
      continue;
    }
    throw new Error(`unsupported fixture wire type ${wireType}`);
  }
  return { data, requestId, appendSeqno };
}

function bodyBytes(body: BodyInit | null | undefined): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error(`unexpected request body ${Object.prototype.toString.call(body)}`);
}

function hexBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) throw new Error("fixture hex payload has an odd length");
  return Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function cursorProvider(
  fetchImpl: typeof fetch,
  baseUrl = "https://api2.cursor.sh",
): OcxProviderConfig & { fetch: typeof fetch } {
  return {
    adapter: "cursor",
    baseUrl,
    apiKey: "test-token",
    upstreamHttpVersion: "http1.1",
    fetch: fetchImpl,
  };
}

function heldRunSseResponse(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const abort = () => controller.error(signal?.reason ?? new DOMException("aborted", "AbortError"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/connect+proto" },
  });
}

function connectEndFrame(): Uint8Array {
  return encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true });
}

function scriptedHttp1Fetch(frames: Uint8Array[]): typeof fetch {
  let runController!: ReadableStreamDefaultController<Uint8Array>;
  let delivered = false;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/agent.v1.AgentService/RunSSE") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          runController = controller;
          const abort = () => {
            try { controller.error(init?.signal?.reason ?? new DOMException("aborted", "AbortError")); } catch { /* closed */ }
          };
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/connect+proto" },
      });
    }
    if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
      if (!delivered) {
        delivered = true;
        queueMicrotask(() => {
          for (const frame of frames) runController.enqueue(frame);
          runController.close();
        });
      }
      return new Response(new Uint8Array(), { status: 200 });
    }
    throw new Error(`unexpected Cursor compatibility endpoint ${url.pathname}`);
  }) as typeof fetch;
}

async function runHttp1Turn(
  fetchImpl: typeof fetch,
  conversationId: string,
  overrides: Partial<CursorRunRequest> = {},
): Promise<{ messages: CursorServerMessage[]; failure?: Error }> {
  const transport = createLiveCursorTransport({
    provider: cursorProvider(fetchImpl),
    translatorBudget: createTestTranslatorBudget(),
    firstFrameTimeoutMs: 2_000,
  });
  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  try {
    for await (const message of transport.run({
      modelId: "claude-opus-5",
      conversationId,
      system: [],
      messages: [{ role: "user", content: "hello" }],
      ...overrides,
    })) messages.push(message);
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await transport.close?.();
  }
  return { messages, ...(failure ? { failure } : {}) };
}

describe("Cursor HTTP/1.1 compatibility transport", () => {
  test("encodes the Cursor BidiAppend hex fallback wire shape", () => {
    const payload = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
    const encoded = encodeCursorBidiAppendRequest(payload, "request-123", 300n);

    expect(encoded.byteLength).toBe(cursorBidiAppendRequestSize(payload.byteLength, "request-123", 300n));
    expect(decodeAppend(encoded)).toEqual({
      data: "deadbeef",
      requestId: "request-123",
      appendSeqno: 300n,
    });
  });

  test("uses RunSSE for output and BidiAppend for the initial client message", async () => {
    let runController!: ReadableStreamDefaultController<Uint8Array>;
    let runRequestId = "";
    const appends: DecodedAppend[] = [];
    const paths: string[] = [];
    const protocols: Array<string | undefined> = [];

    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      protocols.push((init as RequestInit & { protocol?: string } | undefined)?.protocol);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");

      if (url.pathname === "/agent.v1.AgentService/RunSSE") {
        const frame = decodeConnectFrame(bodyBytes(init?.body)).frame;
        runRequestId = fromBinary(BidiRequestIdSchema, frame.payload).requestId;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { runController = controller; },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "application/connect+proto" },
        });
      }

      if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
        const append = decodeAppend(bodyBytes(init?.body));
        appends.push(append);
        queueMicrotask(() => {
          runController.enqueue(encodeConnectFrame(new TextEncoder().encode("{}"), { endStream: true }));
          runController.close();
        });
        return new Response(new Uint8Array(), { status: 200 });
      }

      throw new Error(`unexpected Cursor compatibility endpoint ${url.pathname}`);
    }) as typeof fetch;

    const transport = createLiveCursorTransport({
      provider: cursorProvider(fetchImpl),
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });

    const output = [];
    try {
      for await (const message of transport.run({
        modelId: "claude-opus-5",
        conversationId: "cursor_http1_test",
        system: [],
        messages: [{ role: "user", content: "hello" }],
      })) output.push(message);
    } finally {
      await transport.close?.();
    }

    expect(output).toEqual([]);
    expect(paths).toEqual([
      "/agent.v1.AgentService/RunSSE",
      "/aiserver.v1.BidiService/BidiAppend",
    ]);
    expect(protocols).toEqual(["http1.1", "http1.1"]);
    expect(runRequestId).not.toBe("");
    expect(appends).toHaveLength(1);
    expect(appends[0]?.requestId).toBe(runRequestId);
    expect(appends[0]?.appendSeqno).toBe(0n);
    expect(appends[0]?.data).not.toBe("");
    expect(fromBinary(AgentClientMessageSchema, hexBytes(appends[0]!.data)).message.case).toBe("runRequest");
    expect(transport.requestCommitted?.()).toBe(true);
  });

  test("waits for successful RunSSE registration before the first BidiAppend", async () => {
    let releaseRunSse!: (response: Response) => void;
    const runSseGate = new Promise<Response>(resolve => { releaseRunSse = resolve; });
    let runController!: ReadableStreamDefaultController<Uint8Array>;
    const paths: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/agent.v1.AgentService/RunSSE") return runSseGate;
      if (url.pathname === "/aiserver.v1.BidiService/BidiAppend") {
        queueMicrotask(() => {
          runController.enqueue(connectEndFrame());
          runController.close();
        });
        return new Response(new Uint8Array(), { status: 200 });
      }
      throw new Error(`unexpected endpoint ${url.pathname}`);
    }) as typeof fetch;

    const pending = runHttp1Turn(fetchImpl, "cursor_http1_ready_order");
    await Promise.resolve();
    await Promise.resolve();
    expect(paths).toEqual(["/agent.v1.AgentService/RunSSE"]);

    releaseRunSse(new Response(new ReadableStream<Uint8Array>({
      start(controller) { runController = controller; },
    }), {
      status: 200,
      headers: { "content-type": "application/connect+proto" },
    }));
    const result = await pending;

    expect(result.failure).toBeUndefined();
    expect(paths.slice(0, 2)).toEqual([
      "/agent.v1.AgentService/RunSSE",
      "/aiserver.v1.BidiService/BidiAppend",
    ]);
  });

  test("a pre-aborted turn performs no HTTP/1.1 I/O", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;
    const transport = createLiveCursorTransport({
      provider: cursorProvider(fetchImpl),
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });
    const controller = new AbortController();
    controller.abort(new Error("fixture pre-aborted"));

    try {
      await expect((async () => {
        for await (const _message of transport.run({
          modelId: "claude-opus-5",
          conversationId: "cursor_http1_preaborted",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        }, controller.signal)) { /* drain */ }
      })()).rejects.toThrow("fixture pre-aborted");
      expect(fetchCalls).toBe(0);
      expect(transport.requestCommitted?.()).toBe(false);
    } finally {
      await transport.close?.();
    }
  });

  test("synthesizes done after assistant text on clean HTTP/1.1 EOF", async () => {
    const textFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "hello" }) },
        }),
      },
    })));
    const result = await runHttp1Turn(
      scriptedHttp1Fetch([textFrame, connectEndFrame()]),
      "cursor_http1_text_eof",
    );

    expect(result.failure).toBeUndefined();
    expect(result.messages).toContainEqual({ type: "text", text: "hello" });
    expect(result.messages.at(-1)).toMatchObject({ type: "done" });
  });

  test("synthesizes done after createPlanRequestQuery text on clean HTTP/1.1 EOF", async () => {
    const planFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionQuery",
        value: create(InteractionQuerySchema, {
          id: 7,
          query: {
            case: "createPlanRequestQuery",
            value: create(CreatePlanRequestQuerySchema, {
              args: create(CreatePlanArgsSchema, {
                name: "Fix bridge",
                overview: "Two steps.",
                plan: "1. read\n2. patch",
              }),
            }),
          },
        }),
      },
    })));
    const result = await runHttp1Turn(
      scriptedHttp1Fetch([planFrame, connectEndFrame()]),
      "cursor_http1_plan_eof",
    );

    expect(result.failure).toBeUndefined();
    expect(result.messages.some(message => message.type === "text" && message.text?.includes("Fix bridge"))).toBe(true);
    expect(result.messages.at(-1)).toMatchObject({ type: "done" });
  });

  test("open tool call plus clean HTTP/1.1 EOF emits a truncation event", async () => {
    const startedFrame = encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, {
          message: {
            case: "toolCallStarted",
            value: create(ToolCallStartedUpdateSchema, {
              callId: "call_1",
              modelCallId: "model_1",
              toolCall: create(ToolCallSchema, {
                tool: {
                  case: "mcpToolCall",
                  value: create(McpToolCallSchema, {
                    args: create(McpArgsSchema, {
                      name: "get_time",
                      toolName: "get_time",
                      toolCallId: "call_1",
                      providerIdentifier: "opencodex-responses",
                    }),
                  }),
                },
              }),
            }),
          },
        }),
      },
    })));
    const result = await runHttp1Turn(
      scriptedHttp1Fetch([startedFrame, connectEndFrame()]),
      "cursor_http1_open_tool_eof",
      { tools: [{ name: "get_time", description: "t", parameters: { type: "object", properties: {} } }] },
    );

    expect(result.failure).toBeUndefined();
    expect(result.messages.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("incomplete tool call"),
    });
  });

  test("keeps a proven pre-connect BidiAppend failure uncommitted", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/agent.v1.AgentService/RunSSE") return heldRunSseResponse(init?.signal);
      throw Object.assign(new Error("fixture append connect failed"), { code: "ECONNREFUSED" });
    }) as typeof fetch;
    const translatorBudget = createTestTranslatorBudget();
    const transport = createLiveCursorTransport({
      provider: cursorProvider(fetchImpl),
      translatorBudget,
      firstFrameTimeoutMs: 2_000,
    });

    try {
      await expect((async () => {
        for await (const _message of transport.run({
          modelId: "claude-opus-5",
          conversationId: "cursor_http1_preconnect_failure",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) { /* drain */ }
      })()).rejects.toThrow("fixture append connect failed");
      expect(transport.requestCommitted?.()).toBe(false);
    } finally {
      await transport.close?.();
    }
    expect(translatorBudget.snapshot().currentBytes).toBe(0);
  });

  test("keeps ambiguous BidiAppend failures committed to prevent replay", async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/agent.v1.AgentService/RunSSE") return heldRunSseResponse(init?.signal);
      throw new Error("fixture ambiguous append failure");
    }) as typeof fetch;
    const transport = createLiveCursorTransport({
      provider: cursorProvider(fetchImpl),
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });

    try {
      await expect((async () => {
        for await (const _message of transport.run({
          modelId: "claude-opus-5",
          conversationId: "cursor_http1_ambiguous_failure",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) { /* drain */ }
      })()).rejects.toThrow("fixture ambiguous append failure");
      expect(transport.requestCommitted?.()).toBe(true);
    } finally {
      await transport.close?.();
    }
  });

  test("rejects a cleartext HTTP/1.1 transport before invoking fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    }) as typeof fetch;
    const transport = createLiveCursorTransport({
      provider: cursorProvider(fetchImpl, "http://api2.cursor.sh"),
      translatorBudget: createTestTranslatorBudget(),
      firstFrameTimeoutMs: 2_000,
    });

    try {
      await expect((async () => {
        for await (const _message of transport.run({
          modelId: "claude-opus-5",
          conversationId: "cursor_http1_cleartext",
          system: [],
          messages: [{ role: "user", content: "hello" }],
        })) { /* drain */ }
      })()).rejects.toThrow("requires an HTTPS base URL");
      expect(fetchCalls).toBe(0);
      expect(transport.requestCommitted?.()).toBe(false);
    } finally {
      await transport.close?.();
    }
  });

  test("preserves the proto3 zero and later append sequence values", () => {
    const payload = Uint8Array.of(1, 2, 3);
    expect(decodeAppend(encodeCursorBidiAppendRequest(payload, "req", 0n)).appendSeqno).toBe(0n);
    expect(decodeAppend(encodeCursorBidiAppendRequest(payload, "req", 1n)).appendSeqno).toBe(1n);
  });
});
