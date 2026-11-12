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
});
