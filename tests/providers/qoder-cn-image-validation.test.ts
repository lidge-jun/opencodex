import { beforeEach, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { createQoderAdapter } from "../../src/adapters/qoder/adapter";
import { qoderCnImageInputSupported } from "../../src/adapters/qoder/image-input";
import { clearQoderBinaryCache } from "../../src/adapters/qoder/profiles";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// A complete 1x1 PNG, including IDAT and IEND, rather than a MIME-only fixture.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const ceiling = 1024 * 1024; // OpenCodex policy, not a verified vendor maximum.
const dataUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
const request = (imageUrl: string): OcxParsedRequest => ({
  modelId: "DeepSeek-Flash", stream: true, options: {},
  context: { messages: [{ role: "user", content: [{ type: "image", imageUrl }], timestamp: 0 }] },
});

function changedHeader(offset: number, value: number): Buffer {
  const bytes = Buffer.from(png);
  bytes[offset] = value;
  return bytes;
}

function changedDimensions(width: number, height: number): Buffer {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

// Insert a valid ancillary tEXt chunk before IEND to exercise exact decoded sizes.
function sizedPng(size: number): Buffer {
  const text = Buffer.alloc(size - png.length - 12, 0x20);
  text.write("Note\0", 0, "ascii");
  return Buffer.concat([png.subarray(0, -12), pngChunk("tEXt", text), png.subarray(-12)]);
}

function rasterPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit grayscale; no interlace.
  // Every scanline includes filter 0 followed by width black pixels.
  const raster = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    png.subarray(0, 8), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raster)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeEach(() => clearQoderBinaryCache());

describe("Qoder CN decoded PNG admission", () => {
  test.each([
    ["incomplete quartet", "data:image/png;base64,A"],
    ["excess padding", "data:image/png;base64,AAAA=="],
    ["missing padding", dataUrl(png).replace(/=+$/, "")],
    ["nonzero padding bits", dataUrl(png).replace(/I=$/, "J=")],
    ["interior padding", "data:image/png;base64,AA==AAAA"],
    ["invalid alphabet", "data:image/png;base64,AA-_"],
    ["whitespace", `${dataUrl(png)}\n`],
    ["encoded text", dataUrl(Buffer.from("not a PNG"))],
    ["JPEG labelled PNG", dataUrl(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]))],
    ["truncated signature", dataUrl(png.subarray(0, 7))],
    ["truncated IHDR", dataUrl(png.subarray(0, 32))],
    ["wrong first chunk", dataUrl(changedHeader(12, 0x4a))],
    ["non-ASCII IHDR alias", dataUrl(changedHeader(12, 0xc9))],
    ["wrong IHDR length", dataUrl(changedHeader(11, 12))],
    ["zero width", dataUrl(changedHeader(19, 0))],
    ["zero height", dataUrl(changedHeader(23, 0))],
    ["width beyond PNG range", dataUrl(changedHeader(16, 0x80))],
    ["height beyond PNG range", dataUrl(changedHeader(20, 0x80))],
    ["width above edge ceiling", dataUrl(changedDimensions(8193, 1))],
    ["height above edge ceiling", dataUrl(changedDimensions(1, 8193))],
    ["pixel count above ceiling", dataUrl(changedDimensions(4001, 4000))],
    ["invalid bit depth", dataUrl(changedHeader(24, 3))],
    ["invalid colour type", dataUrl(changedHeader(25, 1))],
    ["invalid compression", dataUrl(changedHeader(26, 1))],
    ["invalid filter", dataUrl(changedHeader(27, 1))],
    ["invalid interlace", dataUrl(changedHeader(28, 2))],
    ["one byte above ceiling", dataUrl(sizedPng(ceiling + 1))],
    ["review's 21 MiB payload", dataUrl(sizedPng(21 * 1024 * 1024))],
  ])("rejects %s with the fixed event before discovery and stdin", async (_name, imageUrl) => {
    let discoveries = 0;
    let spawns = 0;
    const adapter = createQoderAdapter({ adapter: "qoder", baseUrl: "https://qoder.cn", apiKey: "test-pat" } as OcxProviderConfig, {
      which: () => { discoveries++; return "/bin/qoderclicn"; },
      spawn: () => { spawns++; throw new Error("invalid image reached spawn"); },
    });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request(imageUrl), { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, event => events.push(event));
    expect(discoveries).toBe(0);
    expect(spawns).toBe(0);
    expect(events).toEqual([{
      type: "error", status: 400, errorType: "invalid_request_error", code: "unsupported_input_modality", retryable: false,
      message: "Qoder CN raw-image routing is verified only with qoderclicn 1.1.70, DeepSeek-Flash or Qwen3.8-Flash, and one base64 PNG in a single user turn on stream-json stdin. The PNG must be at most 1 MiB decoded, with each edge at most 8192 pixels and at most 16,000,000 total pixels. URL, multiple-image, tool-result and history replay surfaces remain unverified; use the vision sidecar for those inputs.",
    }]);
  });

  test("admits a real tiny PNG and the exact local decoded-size ceiling", () => {
    expect(qoderCnImageInputSupported(request(dataUrl(png)))).toBe(true);
    expect(qoderCnImageInputSupported(request(dataUrl(sizedPng(ceiling))))).toBe(true);
    expect(qoderCnImageInputSupported(request(dataUrl(sizedPng(ceiling - 1))))).toBe(true);
  });

  test.each([
    ["pixel ceiling", 8000, 2000],
    ["width ceiling", 8192, 1],
    ["height ceiling", 1, 8192],
  ] as const)("admits a complete PNG at the %s raster boundary", (_name, width, height) => {
    const bytes = rasterPng(width, height);
    expect(bytes.byteLength).toBeLessThanOrEqual(ceiling);
    expect(qoderCnImageInputSupported(request(dataUrl(bytes)))).toBe(true);
  });
});
