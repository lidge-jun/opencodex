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
});
