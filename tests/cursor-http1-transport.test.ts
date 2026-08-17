import { fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AgentClientMessageSchema,
  BidiRequestIdSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import { decodeConnectFrame, encodeConnectFrame } from "../src/adapters/cursor/framing";
import {
  cursorBidiAppendRequestSize,
  encodeCursorBidiAppendRequest,
} from "../src/adapters/cursor/http1-bidi";
import { createLiveCursorTransport } from "../src/adapters/cursor/live-transport";
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

    const provider = {
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
      apiKey: "test-token",
      upstreamHttpVersion: "http1.1",
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof fetch };
    const transport = createLiveCursorTransport({
      provider,
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

  test("preserves the proto3 zero and later append sequence values", () => {
    const payload = Uint8Array.of(1, 2, 3);
    expect(decodeAppend(encodeCursorBidiAppendRequest(payload, "req", 0n)).appendSeqno).toBe(0n);
    expect(decodeAppend(encodeCursorBidiAppendRequest(payload, "req", 1n)).appendSeqno).toBe(1n);
  });
});
