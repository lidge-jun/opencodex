import { describe, expect, test } from "bun:test";
import { enforceAnthropicImageLimits, sniffImageDimensions } from "../src/adapters/anthropic-image-guard";

function b64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

function u32be(n: number): number[] { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }
function u16be(n: number): number[] { return [(n >>> 8) & 0xff, n & 0xff]; }

/** Minimal PNG: signature + IHDR chunk header + width/height. Sniffer reads only the header. */
function pngBase64(width: number, height: number): string {
  return b64([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), 0x49, 0x48, 0x44, 0x52, // len + "IHDR"
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, // bit depth, color type, etc.
  ]);
}

/** Minimal JPEG: SOI + APP1 (EXIF-ish, skipped by length) + SOF0 with dimensions. */
function jpegBase64(width: number, height: number): string {
  const app1Payload = new Array(20).fill(0x00);
  return b64([
    0xff, 0xd8, // SOI
    0xff, 0xe1, ...u16be(app1Payload.length + 2), ...app1Payload, // APP1
    0xff, 0xc0, ...u16be(17), 8, ...u16be(height), ...u16be(width), 3, // SOF0
  ]);
}

function gifBase64(width: number, height: number): string {
  return b64([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    width & 0xff, (width >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff,
  ]);
}

function imageBlock(base64: string): Record<string, unknown> {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } };
}

function userMsg(blocks: unknown[]): Record<string, unknown> {
  return { role: "user", content: blocks };
}

const SMALL = pngBase64(800, 600);
const BIG = pngBase64(2400, 1600); // >2000px: legal alone, illegal in a many-image request
const HUGE = pngBase64(9000, 500); // >8000px: illegal in any request

function countImages(messages: unknown[]): number {
  let n = 0;
  const scan = (arr: unknown[]): void => {
    for (const block of arr) {
      const b = block as { type?: string; content?: unknown };
      if (b?.type === "image") n++;
      else if (b?.type === "tool_result" && Array.isArray(b.content)) scan(b.content);
    }
  };
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (Array.isArray(content)) scan(content);
  }
  return n;
}

describe("sniffImageDimensions", () => {
  test("reads PNG IHDR", () => {
    expect(sniffImageDimensions(pngBase64(2560, 1440))).toEqual({ width: 2560, height: 1440 });
  });
  test("reads JPEG SOF0 behind an APP1 segment", () => {
    expect(sniffImageDimensions(jpegBase64(3024, 1964))).toEqual({ width: 3024, height: 1964 });
  });
  test("reads GIF logical screen", () => {
    expect(sniffImageDimensions(gifBase64(320, 240))).toEqual({ width: 320, height: 240 });
  });
  test("returns null for unknown bytes", () => {
    expect(sniffImageDimensions(b64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
    expect(sniffImageDimensions("!!!not-base64!!!")).toBeNull();
  });
});

describe("enforceAnthropicImageLimits", () => {
  test("C2: <=20 images pass through untouched even when oversized for many-image", () => {
    const messages = [userMsg([imageBlock(BIG), imageBlock(SMALL)])];
    const before = JSON.stringify(messages);
    enforceAnthropicImageLimits(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("C2: >20 small images pass through untouched (2000px cap not triggered)", () => {
    const messages = [userMsg(Array.from({ length: 25 }, () => imageBlock(SMALL)))];
    const before = JSON.stringify(messages);
    enforceAnthropicImageLimits(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("C1: >20 images with one >2000px trims oldest down to 20, keeping the newest", () => {
    const blocks = [...Array.from({ length: 24 }, () => imageBlock(SMALL)), imageBlock(BIG)];
    const messages = [userMsg(blocks)];
    enforceAnthropicImageLimits(messages);
    expect(countImages(messages)).toBe(20);
    const content = (messages[0] as { content: Array<{ type: string }> }).content;
    // Oldest 5 textified, newest (the BIG one) survives.
    for (let i = 0; i < 5; i++) expect(content[i].type).toBe("text");
    expect(content[24].type).toBe("image");
  });

  test("C3: images nested in tool_result content are counted and trimmable", () => {
    const toolResult = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [imageBlock(SMALL), { type: "text", text: "screenshot" }],
    };
    const messages = [
      userMsg([toolResult]),
      userMsg(Array.from({ length: 20 }, () => imageBlock(SMALL))),
      userMsg([imageBlock(BIG)]),
    ];
    enforceAnthropicImageLimits(messages);
    expect(countImages(messages)).toBe(20);
    // The oldest image (inside tool_result) was textified in place; the block itself remains.
    const tr = (messages[0] as { content: Array<{ type: string; content?: Array<{ type: string }> }> }).content[0];
    expect(tr.type).toBe("tool_result");
    expect(tr.content?.[0].type).toBe("text");
  });

  test("C6: a single >8000px image is textified even in a small request", () => {
    const messages = [userMsg([imageBlock(HUGE), imageBlock(SMALL)])];
    enforceAnthropicImageLimits(messages);
    const content = (messages[0] as { content: Array<{ type: string }> }).content;
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image");
  });

  test("C4: >100 small images trimmed to 100", () => {
    const messages = [userMsg(Array.from({ length: 110 }, () => imageBlock(SMALL)))];
    enforceAnthropicImageLimits(messages);
    expect(countImages(messages)).toBe(100);
  });

  test("unknown-format images are never treated as oversized", () => {
    const unknown = { type: "image", source: { type: "base64", media_type: "image/bmp", data: b64([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) } };
    const messages = [userMsg([...Array.from({ length: 22 }, () => ({ ...unknown }))])];
    const before = JSON.stringify(messages);
    enforceAnthropicImageLimits(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("url-source images count toward totals but are not sniffed", () => {
    const urlImg = { type: "image", source: { type: "url", url: "https://example.com/a.png" } };
    const messages = [userMsg([...Array.from({ length: 21 }, () => ({ ...urlImg })), imageBlock(BIG)])];
    enforceAnthropicImageLimits(messages);
    expect(countImages(messages)).toBe(20);
  });
});
