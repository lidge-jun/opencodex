import http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { encodeConnectFrame } from "../src/adapters/cursor/framing";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { CursorRunRequest, CursorServerMessage } from "../src/adapters/cursor/types";

/**
 * T04 (devlog 260822_senpi_cursor_transfer/110): inbound stream-health watchdog.
 * A turn that received its first frame but then goes silent (or heartbeat-only)
 * must fail at the transport with a typed stall error instead of waiting for the
 * 300s bridge stall watchdog (issue #2210 class).
 */

function agentFrame(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Uint8Array {
  return encodeConnectFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message)));
}

function textDeltaFrame(textValue: string): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: textValue }) },
      }),
    },
  });
}

function heartbeatFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) },
      }),
    },
  });
}

function checkpointFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "conversationCheckpointUpdate",
      value: create(ConversationStateStructureSchema, {}),
    },
  });
}

function turnEndedFrame(): Uint8Array {
  return agentFrame({
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
      }),
    },
  });
}

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

function runRequest(): CursorRunRequest {
  return {
    modelId: "composer-2",
    conversationId: "cursor_stream_health_test",
    system: [],
    messages: [{ role: "user", content: "hello" }],
  } as CursorRunRequest;
}

async function drain(baseUrl: string, knobs: { streamSilenceFailMs?: number; streamHeartbeatOnlyFailMs?: number }): Promise<{
  messages: CursorServerMessage[];
  failure?: Error;
}> {
  const transport = createLiveCursorTransport({
    provider: { adapter: "cursor", baseUrl, apiKey: "test-token" },
    translatorBudget: createTestTranslatorBudget(),
    firstFrameTimeoutMs: 2_000,
    ...knobs,
  });
  const messages: CursorServerMessage[] = [];
  let failure: Error | undefined;
  try {
    for await (const message of transport.run(runRequest())) messages.push(message);
  } catch (err) {
    failure = err instanceof Error ? err : new Error(String(err));
  } finally {
    await transport.close?.();
  }
  return { messages, failure };
}

describe("Cursor inbound stream-health watchdog (T04)", () => {
  test("silence after the first frame fails the turn with the stall error", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      // then: silence — never end the stream
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 300, streamHeartbeatOnlyFailMs: 10_000 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("no inbound frames");
    });
  }, 15_000);

  test("heartbeat-only traffic survives the silence threshold but fails at the heartbeat-only threshold", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      const ping = setInterval(() => {
        try {
          stream.write(Buffer.from(heartbeatFrame()));
          stream.write(Buffer.from(checkpointFrame()));
        } catch { clearInterval(ping); }
      }, 100);
      stream.on("close", () => clearInterval(ping));
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 400, streamHeartbeatOnlyFailMs: 900 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("heartbeat-only");
    });
  }, 15_000);

  test("meaningful frames keep resetting both clocks; turnEnded finishes cleanly", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      let count = 0;
      const tick = setInterval(() => {
        count += 1;
        try {
          if (count < 6) {
            stream.write(Buffer.from(textDeltaFrame(`part-${count}`)));
          } else {
            stream.write(Buffer.from(turnEndedFrame()));
            stream.end();
            clearInterval(tick);
          }
        } catch { clearInterval(tick); }
      }, 150);
      stream.on("close", () => clearInterval(tick));
    }, async baseUrl => {
      // Each 150ms text delta must reset the 400ms silence clock: six ticks ≈ 900ms total,
      // far past a NON-resetting 400ms deadline.
      const { messages, failure } = await drain(baseUrl, { streamSilenceFailMs: 400, streamHeartbeatOnlyFailMs: 10_000 });
      expect(failure).toBeUndefined();
      expect(messages.some(message => message.type === "text")).toBe(true);
      expect(messages.some(message => message.type === "done")).toBe(true);
    });
  }, 15_000);

  test("turnEnded disarms the watchdog even when the server holds the stream open", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.write(Buffer.from(textDeltaFrame("hi")));
      stream.write(Buffer.from(turnEndedFrame()));
      // hold open: the T03 turnEnded close owns this case; the watchdog must not fire first
    }, async baseUrl => {
      const { messages, failure } = await drain(baseUrl, { streamSilenceFailMs: 300, streamHeartbeatOnlyFailMs: 10_000 });
      expect(failure).toBeUndefined();
      expect(messages.some(message => message.type === "done")).toBe(true);
    });
  }, 15_000);

  test("no watchdog before the first frame: the first-frame timeout still owns dial silence", async () => {
    await withH2Server(stream => {
      stream.on("error", () => {});
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      // no frames at all
    }, async baseUrl => {
      const { failure } = await drain(baseUrl, { streamSilenceFailMs: 60_000, streamHeartbeatOnlyFailMs: 60_000 });
      expect(failure).toBeDefined();
      expect(failure!.message).toContain("before first response");
    });
  }, 15_000);
});
