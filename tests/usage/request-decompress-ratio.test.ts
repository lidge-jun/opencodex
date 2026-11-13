import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync, zstdCompressSync } from "node:zlib";
import {
  COMPRESSED_BODY_RATIO_FLOOR_BYTES, CompressionRatioExceededError, DecompressedBodyTooLargeError, decodeRequestBody,
  MIN_CONFIGURABLE_INBOUND_BODY_BYTES,
} from "../../src/server/request-decompress";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const bomb = zstdCompressSync(new Uint8Array(64 * 1024 * 1024));

function refusal(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  throw new Error("expected a refusal");
}

/** About 2.5x compressible, like the agent bodies measured for #3023: base64 noise between repeated text. */
function realisticBody(bytes: number): Uint8Array {
  const parts: string[] = [];
  let size = 0;
  while (size < bytes) {
    const part = randomBytes(3000).toString("base64") + "the agent re-sends its whole conversation ".repeat(60);
    parts.push(part); size += part.length;
  }
  return new TextEncoder().encode(JSON.stringify({ input: parts.join("") }));
}

describe("compressed request body ratio bound (#3023)", () => {
  test("a zstd or gzip bomb stops inflating at the ratio bound with its own refusal", () => {
    for (const [encoding, wire] of [["zstd", bomb], ["gzip", gzipSync(new Uint8Array(64 * 1024 * 1024))]] as const) {
      const error = refusal(() => decodeRequestBody(wire, encoding));
      expect(error).toBeInstanceOf(CompressionRatioExceededError);
      expect(error).toBeInstanceOf(DecompressedBodyTooLargeError);
      const ratio = error as CompressionRatioExceededError;
      expect(ratio.ratioLimitBytes).toBe(Math.max(COMPRESSED_BODY_RATIO_FLOOR_BYTES, wire.byteLength * 200));
      expect(ratio.ratioLimitBytes).toBeLessThan(64 * 1024 * 1024);
      expect(ratio.wireBytes).toBe(wire.byteLength);
      expect(ratio.message).toContain("more than 200 times");
      expect(ratio.message).not.toContain("maxInboundBodyBytes");
    }
  });

  test("a highly compressible body that decodes within the floor is accepted", () => {
    const plain = new Uint8Array(4 * 1024 * 1024);
    expect(decodeRequestBody(zstdCompressSync(plain), "zstd").byteLength).toBe(plain.byteLength);
  });

  test("an ordinary body above the floor decodes", () => {
    const plain = realisticBody(20 * 1024 * 1024);
    const wire = zstdCompressSync(plain);
    expect(plain.byteLength / wire.byteLength).toBeLessThan(200);
    expect(decodeRequestBody(wire, "zstd").byteLength).toBe(plain.byteLength);
  });

  test("the absolute inbound limit still refuses with its own message", () => {
    const plain = realisticBody(2 * 1024 * 1024);
    const error = refusal(() => decodeRequestBody(zstdCompressSync(plain), "zstd", MIN_CONFIGURABLE_INBOUND_BODY_BYTES));
    expect(error).toBeInstanceOf(DecompressedBodyTooLargeError);
    expect(error).not.toBeInstanceOf(CompressionRatioExceededError);
  });

  test("a truncated frame yields only its complete blocks, never past the bound", () => {
    const plain = new TextEncoder().encode(JSON.stringify({ input: "x".repeat(300_000) }));
    const frame = zstdCompressSync(plain);
    for (const cut of [frame.subarray(0, frame.byteLength - 5), frame.subarray(0, 8)]) {
      const decoded = decodeRequestBody(cut, "zstd");
      expect(decoded.byteLength).toBeLessThan(plain.byteLength);
      expect(() => JSON.parse(new TextDecoder().decode(decoded))).toThrow();
    }
  });

  test("concatenated frames decode in full, and the ratio bound counts their total", () => {
    const first = new TextEncoder().encode(JSON.stringify({ input: "first" }));
    const one = zstdCompressSync(first);
    const block = new Uint8Array(6 * 1024 * 1024).fill(0x62);
    const two = zstdCompressSync(block);
    expect(decodeRequestBody(new Uint8Array(Buffer.concat([one, two])), "zstd").byteLength).toBe(first.byteLength + block.byteLength);
    const ten = new Uint8Array(Buffer.concat(Array(10).fill(two)));
    expect(refusal(() => decodeRequestBody(ten, "zstd"))).toBeInstanceOf(CompressionRatioExceededError);
  });

  test("a frame header asking for a window above 128 MiB is refused before any output", () => {
    // Magic, a descriptor with no content size, the window descriptor, then one raw one-byte last block.
    const frame = (windowLog: number) => new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, (windowLog - 10) << 3, 0x09, 0x00, 0x00, 0x41]);
    expect(new TextDecoder().decode(decodeRequestBody(frame(27), "zstd"))).toBe("A");
    for (const windowLog of [28, 31]) expect(() => decodeRequestBody(frame(windowLog), "zstd")).toThrow("too much memory");
  });
});

describe("the data plane refuses a compression bomb (#3023)", () => {
  const TEST_DIR = join(import.meta.dir, ".tmp-request-decompress-ratio-test");
  let isolated: IsolatedCodexHome | null = null;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    isolated = installIsolatedCodexHome("ocx-ratio-codex-");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
    isolated?.restore(); isolated = null;
    if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  });

  test("POST /v1/responses answers 413 naming the ratio guard", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST", body: bomb, headers: { "content-type": "application/json", "content-encoding": "zstd" },
      });
      expect(response.status).toBe(413);
      expect(await response.text()).toContain("compression bombs");
    } finally { await server.stop(true); }
  });

  test("a truncated frame and an oversized window both answer 400 without reaching a provider", async () => {
    const server = startServer(0);
    try {
      const frame = zstdCompressSync(new TextEncoder().encode(JSON.stringify({ input: "x".repeat(300_000) })));
      const window = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 18 << 3, 0x09, 0x00, 0x00, 0x41]);
      for (const body of [frame.subarray(0, frame.byteLength - 5), window]) {
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
          method: "POST", body, headers: { "content-type": "application/json", "content-encoding": "zstd" },
        });
        expect(response.status).toBe(400);
        await response.arrayBuffer();
      }
    } finally { await server.stop(true); }
  });
});
