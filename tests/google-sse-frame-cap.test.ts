import { afterEach, describe, expect, test } from "bun:test";
import {
  createGoogleAdapter as createGoogleAdapterProduction,
  setGoogleSseFrameMaxBytesForTests,
} from "../src/adapters/google";
import type { AdapterEvent, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const CAP = 32;
const originalDecode = TextDecoder.prototype.decode;
let decodedOverflowByteLength = 0;

function installDecodeProbe(): void {
  decodedOverflowByteLength = 0;
  TextDecoder.prototype.decode = function (
    this: TextDecoder,
    input?: AllowSharedBufferSource,
    options?: TextDecodeOptions,
  ): string {
    const size = input && typeof (input as ArrayBufferView).byteLength === "number"
      ? (input as ArrayBufferView).byteLength
      : 0;
    if (size > CAP) decodedOverflowByteLength = size;
    return originalDecode.call(this, input as ArrayBuffer, options);
  };
}

afterEach(() => {
  setGoogleSseFrameMaxBytesForTests();
  TextDecoder.prototype.decode = originalDecode;
  decodedOverflowByteLength = 0;
});

function googleProvider(): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "google-test-key",
    authMode: "key",
  };
}

function ccaProvider(): OcxProviderConfig {
  return {
    adapter: "google",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    apiKey: "antigravity-test-token",
    authMode: "oauth",
    googleMode: "cloud-code-assist",
    project: "project-test",
  };
}

/** 20 × U+4E2D: 60 UTF-8 bytes, 20 UTF-16 units — over a 32-byte cap, under it as string length. */
function oversizedMultibyteChunk(): Uint8Array {
  const charUtf8 = new TextEncoder().encode("中");
  const repeats = 20;
  const chunk = new Uint8Array(charUtf8.byteLength * repeats);
  for (let i = 0; i < repeats; i++) chunk.set(charUtf8, i * charUtf8.byteLength);
  return chunk;
}

function byteStreamResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(events: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const collected: AdapterEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("google SSE frame byte cap", () => {
  test("rejects an oversize UTF-8 chunk before TextDecoder.decode", async () => {
    const chunk = oversizedMultibyteChunk();
    expect(chunk.byteLength).toBeGreaterThan(CAP);
    expect(new TextDecoder().decode(chunk).length).toBeLessThan(CAP);

    setGoogleSseFrameMaxBytesForTests(CAP);
    installDecodeProbe();

    const events = await collect(
      createGoogleAdapter(googleProvider()).parseStream(byteStreamResponse([chunk])),
    );

    expect(decodedOverflowByteLength).toBe(0);
    expect(events).toContainEqual({
      type: "error",
      message: `upstream SSE data frame exceeds ${CAP} bytes`,
    });
  });

  test("CCA unary parseResponse applies the same SSE byte cap", async () => {
    const chunk = oversizedMultibyteChunk();
    setGoogleSseFrameMaxBytesForTests(CAP);
    installDecodeProbe();

    const events = await createGoogleAdapter(ccaProvider()).parseResponse!(
      byteStreamResponse([chunk]),
    );

    expect(decodedOverflowByteLength).toBe(0);
    expect(events).toContainEqual({
      type: "error",
      message: `upstream SSE data frame exceeds ${CAP} bytes`,
    });
  });

  test("rejects a split oversized multibyte line before decoding the completing chunk", async () => {
    const zhong = new TextEncoder().encode("中");
    expect(zhong.byteLength).toBe(3);
    const prefix = new TextEncoder().encode("data: ");
    const fill = new Uint8Array(CAP + 1 - prefix.byteLength - zhong.byteLength).fill(0x61);
    const first = new Uint8Array(prefix.byteLength + fill.byteLength + 1);
    first.set(prefix, 0);
    first.set(fill, prefix.byteLength);
    first.set(zhong.subarray(0, 1), prefix.byteLength + fill.byteLength);
    const completing = zhong.subarray(1);
    expect(first.byteLength).toBe(CAP - 1);
    expect(first.byteLength + completing.byteLength).toBe(CAP + 1);

    setGoogleSseFrameMaxBytesForTests(CAP);
    let decodedCompletingChunk = false;
    TextDecoder.prototype.decode = function (
      this: TextDecoder,
      input?: AllowSharedBufferSource,
      options?: TextDecodeOptions,
    ): string {
      const view = input instanceof Uint8Array
        ? input
        : input && typeof (input as ArrayBufferView).byteLength === "number"
          ? new Uint8Array(input as ArrayBufferView)
          : null;
      if (
        view
        && view.byteLength === completing.byteLength
        && completing.every((byte, index) => view[index] === byte)
      ) {
        decodedCompletingChunk = true;
      }
      return originalDecode.call(this, input as ArrayBuffer, options);
    };

    const events = await collect(
      createGoogleAdapter(googleProvider()).parseStream(byteStreamResponse([first, completing])),
    );

    expect(decodedCompletingChunk).toBe(false);
    expect(events).toContainEqual({
      type: "error",
      message: `upstream SSE data frame exceeds ${CAP} bytes`,
    });
  });

  test("accepts a data line exactly at the cap before its LF delimiter", async () => {
    const cap = 128;
    const envelope = (text: string) => ({
      response: { candidates: [{ content: { parts: [{ text }] } }] },
    });
    const encoder = new TextEncoder();
    const emptyLine = `data: ${JSON.stringify(envelope(""))}`;
    const line = `data: ${JSON.stringify(envelope("a".repeat(cap - encoder.encode(emptyLine).byteLength)))}`;
    expect(encoder.encode(line).byteLength).toBe(cap);

    setGoogleSseFrameMaxBytesForTests(cap);
    const events = await collect(
      createGoogleAdapter(googleProvider()).parseStream(
        byteStreamResponse([encoder.encode(`${line}\n\n`)]),
      ),
    );

    expect(events.some(event => event.type === "error" && event.message.includes("exceeds"))).toBe(false);
  });

  test("accepts multiple sub-cap data frames delivered in one oversized chunk", async () => {
    const cap = 96;
    const body = [
      `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "a" }] } }] } })}\n`,
      `data: ${JSON.stringify({ response: { candidates: [{ finishReason: "STOP" }] } })}\n`,
    ].join("\n");
    const lines = body.split("\n").filter(Boolean);
    expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(cap);
    expect(Math.max(...lines.map(line => new TextEncoder().encode(line).byteLength))).toBeLessThanOrEqual(cap);

    setGoogleSseFrameMaxBytesForTests(cap);
    const events = await collect(
      createGoogleAdapter(ccaProvider()).parseStream(byteStreamResponse([
        new TextEncoder().encode(body),
      ])),
    );

    expect(events).toContainEqual({ type: "text_delta", text: "a" });
    expect(events).toContainEqual({ type: "done", usage: undefined });
    expect(events.some(event => event.type === "error")).toBe(false);
  });
});
