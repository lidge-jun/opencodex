import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CursorImageError,
  CURSOR_VISION_IMAGE_OMITTED,
  CURSOR_VISION_SOFT_MAX_BYTES,
  CURSOR_VISION_SOFT_MAX_BYTES_HIGH,
  MAX_CURSOR_IMAGE_BYTES,
  MAX_CURSOR_IMAGE_DECODE_BYTES,
  MAX_CURSOR_IMAGE_DECODE_EDGE,
  MAX_CURSOR_IMAGE_PIXELS,
  MAX_CURSOR_IMAGES,
  buildSelectedImages,
  cursorVisionPrepareStartIndex,
  decodeCursorImageDataUrl,
  prepareCursorImageForWire,
  prepareCursorRawMessages,
  resolveActiveCursorImages,
  resolveCursorImages,
  sniffCursorImageDimensions,
  sniffCursorImageFormat,
} from "../src/adapters/cursor/images";
import {
  handleCursorNativeKv,
  resetCursorBlobStateForTests,
} from "../src/adapters/cursor/native-exec";
import { cursorRequestMessagesFromRaw } from "../src/adapters/cursor/request-builder";
import { activePromptText, encodeCursorRunRequest } from "../src/adapters/cursor/protobuf-request";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";

/** Minimal valid 1×1 PNG (real IHDR; not a signature-only stub). */
const PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

async function oversizedDecodablePng(): Promise<Uint8Array> {
  const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
  const src = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
  return new Uint8Array(await new Bun.Image(src).resize(2400, 2400).png().bytes());
}

describe("Cursor image resolver", () => {
  test("rejects more than MAX_CURSOR_IMAGES in one request", async () => {
    const urls = Array.from({ length: MAX_CURSOR_IMAGES + 1 }, () => PNG_DATA_URL);
    await expect(resolveCursorImages(urls)).rejects.toMatchObject({
      name: "CursorImageError",
      message: `Too many images in one request (max ${MAX_CURSOR_IMAGES}).`,
    });
    await expect(prepareCursorRawMessages([{
      role: "user",
      content: urls.map(imageUrl => ({ type: "image" as const, imageUrl })),
      timestamp: 1,
    }])).rejects.toMatchObject({
      name: "CursorImageError",
      message: `Too many images in one request (max ${MAX_CURSOR_IMAGES}).`,
    });
  });

  test("omits data URLs above the inbound decode bomb ceiling", async () => {
    const oversizedLength = Math.ceil(Math.ceil((MAX_CURSOR_IMAGE_DECODE_BYTES + 1) * 4 / 3) / 4) * 4;
    const url = `data:image/png;base64,${"A".repeat(oversizedLength)}`;
    // Pin the guard itself: the resolver soft-omits every failure reason identically.
    expect(() => decodeCursorImageDataUrl(url)).toThrow("Image input is too large to process safely.");
    // Soft-omit: one bad URL must not abort a mixed turn.
    const resolved = await resolveCursorImages([url]);
    expect(resolved).toEqual([]);
  });

  test("prep-before-cap accepts PNG over 1 MiB that JPEG-encodes under the soft and wire caps", async () => {
    const png = await oversizedDecodablePng();
    expect(png.byteLength).toBeGreaterThan(MAX_CURSOR_IMAGE_BYTES);
    const url = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const resolved = await resolveCursorImages([url]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("image/jpeg");
    expect(resolved[0]!.data.byteLength).toBeLessThan(png.byteLength);
    expect(resolved[0]!.data.byteLength).toBeLessThanOrEqual(CURSOR_VISION_SOFT_MAX_BYTES);
    expect(resolved[0]!.data.byteLength).toBeLessThanOrEqual(MAX_CURSOR_IMAGE_BYTES);
  });

  test("omits undecodable payloads under the decode ceiling instead of sending them", async () => {
    // Length is a multiple of four, so alphabet/padding checks pass and Bun decode fails.
    const junkLength = Math.ceil(Math.ceil((MAX_CURSOR_IMAGE_BYTES + 1) * 4 / 3) / 4) * 4;
    const resolved = await resolveCursorImages([`data:image/png;base64,${"A".repeat(junkLength)}`]);
    expect(resolved).toEqual([]);
  });

  test("decodes valid base64 data URLs through JPEG prep", async () => {
    const resolved = await resolveCursorImages([PNG_DATA_URL]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("image/jpeg");
    expect(resolved[0]!.data.byteLength).toBeGreaterThan(0);
    expect(resolved[0]!.data[0]).toBe(0xff);
    expect(resolved[0]!.data[1]).toBe(0xd8);
    expect(resolved[0]?.uuid.length).toBeGreaterThan(0);
  });

  test("soft-omits malformed and non-image data URLs", async () => {
    expect(await resolveCursorImages(["data:image/png,not-base64"])).toEqual([]);
    expect(await resolveCursorImages(["data:text/plain;base64,YQ=="])).toEqual([]);
    expect(await resolveCursorImages(["data:image/png;base64"])).toEqual([]);
    expect(await resolveCursorImages(["data:image/png;base64,"])).toEqual([]);
  });

  test("omits remote URLs — this slice is data: only", async () => {
    expect(await resolveCursorImages(["http://example.com/image.png"])).toEqual([]);
    expect(await resolveCursorImages(["https://example.com/image.png"])).toEqual([]);
  });

  test("resolveActiveCursorImages selects the last user turn and ignores earlier images", async () => {
    const resolved = await resolveActiveCursorImages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        timestamp: 1,
      },
      {
        role: "assistant",
        model: "cursor/auto",
        content: [{ type: "text", text: "seen" }],
        timestamp: 2,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "active" },
          { type: "image", imageUrl: PNG_DATA_URL },
        ],
        timestamp: 3,
      },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("image/jpeg");
  });

  test("resolveActiveCursorImages supports developer turns", async () => {
    const resolved = await resolveActiveCursorImages([
      {
        role: "developer",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        timestamp: 1,
      },
    ]);
    expect(resolved).toHaveLength(1);
  });

  test("resolveActiveCursorImages returns empty for text-only trailing toolResult", async () => {
    const resolved = await resolveActiveCursorImages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
        content: "done",
        isError: false,
        timestamp: 2,
      },
    ]);
    expect(resolved).toEqual([]);
  });

  test("user message after toolResult does not promote stale tool images", async () => {
    const resolved = await resolveActiveCursorImages([
      { role: "user", content: "first", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_view",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        isError: false,
        timestamp: 2,
      },
      { role: "user", content: "new question without an image", timestamp: 3 },
    ]);
    expect(resolved).toEqual([]);
  });

  test("CursorImageError carries HTTP status for callers", () => {
    const error = new CursorImageError("blocked", 403);
    expect(error.status).toBe(403);
    expect(error.name).toBe("CursorImageError");
  });

  test("buildSelectedImages uses blobIdWithData + attachment path and keeps KV hydrated", () => {
    resetCursorBlobStateForTests();
    // Minimal PNG signature + IHDR claiming 2x3 (not Bun-decodable — stays PNG)
    const png = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10,
      0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 2, 0, 0, 0, 3,
      8, 2, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(sniffCursorImageDimensions(png)).toEqual({ width: 2, height: 3 });

    // Standalone RST0 before SOF0 must not be parsed as a length-bearing segment.
    const jpegWithRst = Uint8Array.from([
      0xff, 0xd8, // SOI
      0xff, 0xd0, // RST0 (no length)
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00, // SOF0 2x3
    ]);
    expect(sniffCursorImageDimensions(jpegWithRst)).toEqual({ width: 2, height: 3 });

    // Extended-sequential SOF1 (0xC1) shares the same dimension layout as SOF0.
    const jpegSof1 = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc1, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00,
    ]);
    expect(sniffCursorImageDimensions(jpegSof1)).toEqual({ width: 2, height: 3 });

    const [selected] = buildSelectedImages([{
      data: png,
      mimeType: "image/png",
      uuid: "u-dim",
    }]);
    expect(selected?.dataOrBlobId.case).toBe("blobIdWithData");
    expect(selected?.path).toBe("attachment-u-dim.png");
    expect(selected?.dimension?.width).toBe(2);
    expect(selected?.dimension?.height).toBe(3);
    const withData = selected!.dataOrBlobId.value as { blobId: Uint8Array; data: Uint8Array };
    expect(Array.from(withData.blobId)).toEqual(Array.from(createHash("sha256").update(png).digest()));
    expect(Array.from(withData.data)).toEqual(Array.from(png));

    const reply = fromBinary(AgentClientMessageSchema, handleCursorNativeKv(create(KvServerMessageSchema, {
      id: 1,
      message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: withData.blobId }) },
    })));
    const kv = reply.message.case === "kvClientMessage" ? reply.message.value : undefined;
    const data = kv?.message.case === "getBlobResult" ? kv.message.value.blobData : undefined;
    expect(Array.from(data ?? [])).toEqual(Array.from(png));
  });

  test("prepareCursorImageForWire re-encodes large PNG as JPEG under the soft cap", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    expect(png.byteLength).toBeGreaterThan(CURSOR_VISION_SOFT_MAX_BYTES);

    const prepared = await prepareCursorImageForWire({
      data: png,
      mimeType: "image/png",
      uuid: "big-png",
    });
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") throw new Error("expected ready");
    expect(prepared.image.mimeType).toBe("image/jpeg");
    expect(prepared.image.data.byteLength).toBeLessThan(png.byteLength);
    expect(prepared.image.data.byteLength).toBeLessThanOrEqual(CURSOR_VISION_SOFT_MAX_BYTES);
    expect(prepared.image.data[0]).toBe(0xff);
    expect(prepared.image.data[1]).toBe(0xd8);
  });

  test("detail original/high uses a higher soft tier than auto", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    const auto = await prepareCursorImageForWire({
      data: png,
      mimeType: "image/png",
      uuid: "auto",
      detail: "auto",
    });
    const original = await prepareCursorImageForWire({
      data: png,
      mimeType: "image/png",
      uuid: "original",
      detail: "original",
    });
    expect(auto.status).toBe("ready");
    expect(original.status).toBe("ready");
    if (auto.status !== "ready" || original.status !== "ready") throw new Error("expected ready");
    expect(original.image.data.byteLength).toBeGreaterThan(auto.image.data.byteLength);
    expect(auto.image.data.byteLength).toBeLessThanOrEqual(CURSOR_VISION_SOFT_MAX_BYTES);
    expect(original.image.data.byteLength).toBeLessThanOrEqual(CURSOR_VISION_SOFT_MAX_BYTES_HIGH);
    expect(original.image.data.byteLength).toBeLessThanOrEqual(MAX_CURSOR_IMAGE_BYTES);
  });

  test("exotic MIME and corrupt PNG fail closed", async () => {
    const bmp = await prepareCursorImageForWire({
      data: new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]),
      mimeType: "image/bmp",
      uuid: "bmp",
    });
    expect(bmp).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });

    const corrupt = await prepareCursorImageForWire({
      data: new Uint8Array(128).fill(0x41),
      mimeType: "image/png",
      uuid: "corrupt",
    });
    expect(corrupt).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });

    // Soft-cap-sized labeled JPEG must still decode; junk under the soft max is omitted.
    const fakeJpeg = await prepareCursorImageForWire({
      data: new Uint8Array(128).fill(0xff),
      mimeType: "image/jpeg",
      uuid: "fake-jpeg",
    });
    expect(fakeJpeg).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("prepareCursorRawMessages JPEG-preps active-turn user data URLs", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    const imageUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", imageUrl, detail: "auto" },
        ],
        timestamp: 1,
      },
    ]);
    const user = prepared.messages?.[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user" || typeof user.content === "string") throw new Error("expected image parts");
    const part = user.content.find(item => item.type === "image");
    expect(part?.type).toBe("image");
    if (part?.type !== "image") throw new Error("expected image");
    expect(part.imageUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    const payload = part.imageUrl.slice(part.imageUrl.indexOf(",") + 1);
    const bytes = Buffer.from(payload, "base64");
    expect(bytes.byteLength).toBeLessThanOrEqual(CURSOR_VISION_SOFT_MAX_BYTES);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test("prepareCursorRawMessages replaces exotic images with omission text", async () => {
    const bmpUrl = `data:image/bmp;base64,${Buffer.from([0x42, 0x4d, 0, 0]).toString("base64")}`;
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: bmpUrl }],
        timestamp: 1,
      },
    ]);
    const user = prepared.messages?.[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user" || typeof user.content === "string") throw new Error("expected parts");
    expect(user.content).toEqual([{ type: "text", text: CURSOR_VISION_IMAGE_OMITTED }]);
  });

  test("cursorRequestMessagesFromRaw surfaces omission text after prepare", async () => {
    const bmpUrl = `data:image/bmp;base64,${Buffer.from([0x42, 0x4d, 0, 0]).toString("base64")}`;
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: bmpUrl }],
        timestamp: 1,
      },
    ]);
    const raw = prepared.messages;
    const messages = cursorRequestMessagesFromRaw(raw);
    expect(messages).toEqual([{ role: "user", content: CURSOR_VISION_IMAGE_OMITTED }]);
    expect(activePromptText({
      modelId: "grok-4.5",
      conversationId: "cursor_test",
      system: [],
      messages,
      rawMessages: raw,
    })).toBe(CURSOR_VISION_IMAGE_OMITTED);
  });

  test("live-transport image phase: prepare rawMessages then resolve SelectedImage", async () => {
    // Mirrors live-transport.ts: prepareCursorRawMessages → resolveActiveCursorImages.
    const rawIn = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "What is in this image?" },
          { type: "image" as const, imageUrl: PNG_DATA_URL, detail: "high" },
        ],
        timestamp: 1,
      },
    ];
    const prepared = await prepareCursorRawMessages(rawIn);
    const rawMessages = prepared.messages;
    const messages = cursorRequestMessagesFromRaw(rawMessages);
    const selectedImages = await resolveActiveCursorImages(rawMessages, undefined, prepared.images);
    expect(selectedImages).toHaveLength(1);

    resetCursorBlobStateForTests();
    const bytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      conversationId: "c-wire",
      system: ["You are helpful."],
      messages,
      rawMessages,
      selectedImages,
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    expect(run?.action?.action.case).toBe("userMessageAction");
    if (run?.action?.action.case !== "userMessageAction") throw new Error("expected userMessageAction");
    expect(run.action.action.value.userMessage?.text).toContain("What is in this image?");
    expect(run.action.action.value.userMessage?.selectedContext?.selectedImages.length).toBe(1);
  });

  test("resolveActiveCursorImages reuses prepared bytes instead of re-encoding", async () => {
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", imageUrl: PNG_DATA_URL, detail: "high" },
        ],
        timestamp: 1,
      },
    ]);
    expect(prepared.images).toHaveLength(1);
    const selectedImages = await resolveActiveCursorImages(
      prepared.messages,
      undefined,
      prepared.images,
    );
    expect(selectedImages).toHaveLength(1);
    expect(selectedImages[0]).toBe(prepared.images[0]);
    expect(selectedImages[0]?.data).toBe(prepared.images[0]?.data);
  });

  test("image-only remote soft-omit yields userMessageAction with omission text", async () => {
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: "https://example.com/missing.png" }],
        timestamp: 1,
      },
    ]);
    const raw = prepared.messages;
    const messages = cursorRequestMessagesFromRaw(raw);
    expect(messages).toEqual([{ role: "user", content: CURSOR_VISION_IMAGE_OMITTED }]);
    const selectedImages = await resolveActiveCursorImages(raw, undefined, prepared.images);
    expect(selectedImages).toEqual([]);
    resetCursorBlobStateForTests();
    const bytes = encodeCursorRunRequest({
      modelId: "grok-4.5",
      conversationId: "c-https-omit",
      system: [],
      messages,
      rawMessages: raw,
      selectedImages,
    });
    const msg = fromBinary(AgentClientMessageSchema, bytes);
    const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
    expect(run?.action?.action.case).toBe("userMessageAction");
    expect(actionTextFrom(bytes)).toBe(CURSOR_VISION_IMAGE_OMITTED);
  });

  test("remote image with valid text continues text-only", async () => {
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what color is the sky?" },
          { type: "image", imageUrl: "https://example.com/missing.png" },
        ],
        timestamp: 1,
      },
    ]);
    const raw = prepared.messages;
    const messages = cursorRequestMessagesFromRaw(raw);
    expect(typeof messages[0]?.content).toBe("string");
    expect(messages[0]?.content).toContain("what color is the sky?");
    expect(messages[0]?.content).toContain(CURSOR_VISION_IMAGE_OMITTED);
    expect(await resolveActiveCursorImages(raw, undefined, prepared.images)).toEqual([]);
  });

  test("strict base64 rejects truncated and wrong-alphabet payloads", () => {
    expect(() => decodeCursorImageDataUrl("data:image/png;base64,iVBOR")).toThrow(CursorImageError);
    expect(() => decodeCursorImageDataUrl("data:image/png;base64,!!!!")).toThrow(CursorImageError);
    // Signature-only 8-byte stub is valid base64 but must not bypass prepare (no ≤64 passthrough).
    const stubUrl = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}`;
    const decoded = decodeCursorImageDataUrl(stubUrl);
    expect(decoded.data.byteLength).toBe(8);
  });

  test("signature-only PNG stub is omitted by prepare (no ≤64 bypass)", async () => {
    const outcome = await prepareCursorImageForWire({
      data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      mimeType: "image/png",
      uuid: "stub",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("oversize sniffed dimensions omit without Bun decode bomb", async () => {
    // PNG IHDR with absurd width/height; sniff rejects before Bun.Image.
    const ihdr = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x01, 0x00, 0x00, // width 65536
      0x00, 0x01, 0x00, 0x00, // height 65536
    ]);
    expect(sniffCursorImageDimensions(ihdr)).toEqual({ width: 65536, height: 65536 });
    expect(65536).toBeGreaterThan(MAX_CURSOR_IMAGE_DECODE_EDGE);
    expect(65536 * 65536).toBeGreaterThan(MAX_CURSOR_IMAGE_PIXELS);
    const outcome = await prepareCursorImageForWire({
      data: ihdr,
      mimeType: "image/png",
      uuid: "huge",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("truncated FF D8 JPEG under soft cap is omitted (no SOI-only fast path)", async () => {
    const truncated = new Uint8Array([0xff, 0xd8, 0x00, 0x00]);
    expect(sniffCursorImageFormat(truncated)).toBe("jpeg");
    expect(sniffCursorImageDimensions(truncated)).toBeUndefined();
    const outcome = await prepareCursorImageForWire({
      data: truncated,
      mimeType: "image/jpeg",
      uuid: "soi-only",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("truncated JPEG with a valid SOF is omitted (no header-only passthrough)", async () => {
    // SOI + SOF0 claiming 2x3, then EOF. Sniff succeeds; Bun.Image must still reject it.
    const sofOnly = Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x11, 0x00,
    ]);
    expect(sniffCursorImageFormat(sofOnly)).toBe("jpeg");
    expect(sniffCursorImageDimensions(sofOnly)).toEqual({ width: 2, height: 3 });
    const outcome = await prepareCursorImageForWire({
      data: sofOnly,
      mimeType: "image/jpeg",
      uuid: "sof-only",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("PNG bytes labeled image/jpeg are re-encoded as JPEG, not passthrough", async () => {
    const outcome = await prepareCursorImageForWire({
      data: PNG_BYTES,
      mimeType: "image/jpeg",
      uuid: "mislabeled",
    });
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") throw new Error("expected ready");
    expect(outcome.image.mimeType).toBe("image/jpeg");
    expect(outcome.image.data[0]).toBe(0xff);
    expect(outcome.image.data[1]).toBe(0xd8);
    expect(sniffCursorImageFormat(outcome.image.data)).toBe("jpeg");
  });

  test("oversized WebP VP8X header omits before Bun decode", async () => {
    // RIFF....WEBP + VP8X with canvas size 65536x65536 (stored as size-1).
    const webp = new Uint8Array(30);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    webp.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    // width-1 / height-1 as 24-bit LE at 24..29 → 65535 → displayed 65536
    webp[24] = 0xff;
    webp[25] = 0xff;
    webp[26] = 0x00;
    webp[27] = 0xff;
    webp[28] = 0xff;
    webp[29] = 0x00;
    expect(sniffCursorImageFormat(webp)).toBe("webp");
    expect(sniffCursorImageDimensions(webp)).toEqual({ width: 65536, height: 65536 });
    const outcome = await prepareCursorImageForWire({
      data: webp,
      mimeType: "image/webp",
      uuid: "huge-webp",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("truncated PNG IHDR omits before Bun decode (no trusted dimensions)", async () => {
    const truncated = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x02,
    ]);
    expect(sniffCursorImageFormat(truncated)).toBe("png");
    expect(sniffCursorImageDimensions(truncated)).toBeUndefined();
    const outcome = await prepareCursorImageForWire({
      data: truncated,
      mimeType: "image/png",
      uuid: "truncated-png",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("truncated GIF header omits before Bun decode (no trusted dimensions)", async () => {
    const truncated = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x02, 0x00]);
    expect(sniffCursorImageFormat(truncated)).toBe("gif");
    expect(sniffCursorImageDimensions(truncated)).toBeUndefined();
    const outcome = await prepareCursorImageForWire({
      data: truncated,
      mimeType: "image/gif",
      uuid: "truncated-gif",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("unsupported WebP chunk omits before Bun decode (no trusted dimensions)", async () => {
    const webp = new Uint8Array(16);
    webp.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    webp.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    webp.set([0x41, 0x4e, 0x49, 0x4d], 12); // ANIM — not a dimension-bearing chunk
    expect(sniffCursorImageFormat(webp)).toBe("webp");
    expect(sniffCursorImageDimensions(webp)).toBeUndefined();
    const outcome = await prepareCursorImageForWire({
      data: webp,
      mimeType: "image/webp",
      uuid: "unsupported-webp",
    });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("prepareCursorImageForWire never returns ready JPEG above the detail soft cap", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    const oversized = await oversizedDecodablePng();
    for (const [label, input, detail, softMax] of [
      ["auto grumpy", png, "auto", CURSOR_VISION_SOFT_MAX_BYTES],
      ["high grumpy", png, "high", CURSOR_VISION_SOFT_MAX_BYTES_HIGH],
      ["auto oversized", oversized, "auto", CURSOR_VISION_SOFT_MAX_BYTES],
    ] as const) {
      const outcome = await prepareCursorImageForWire({
        data: input,
        mimeType: "image/png",
        uuid: label,
        detail,
      });
      expect(outcome.status, label).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`expected ready for ${label}`);
      expect(outcome.image.data.byteLength, label).toBeLessThanOrEqual(softMax);
    }
  });

  test("omits when shrink ladder best JPEG still exceeds soft cap", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    const outcome = await prepareCursorImageForWire({
      data: png,
      mimeType: "image/png",
      uuid: "soft-cap-miss",
    }, undefined, { softMaxBytes: 5_000 });
    expect(outcome).toEqual({ status: "omitted", reason: CURSOR_VISION_IMAGE_OMITTED });
  });

  test("prepareCursorRawMessages leaves historical images untouched on a later user turn", async () => {
    const oldUrl = `data:image/png;base64,${Buffer.from([...PNG_BYTES, 1]).toString("base64")}`;
    const prepared = await prepareCursorRawMessages([
      {
        role: "user",
        content: [{ type: "image", imageUrl: oldUrl }],
        timestamp: 1,
      },
      {
        role: "assistant",
        model: "cursor/grok-4.5",
        content: [{ type: "text", text: "seen" }],
        timestamp: 2,
      },
      { role: "user", content: "thanks, no image", timestamp: 3 },
    ]);
    expect(prepared.messages?.[0]).toEqual({
      role: "user",
      content: [{ type: "image", imageUrl: oldUrl }],
      timestamp: 1,
    });
    expect(cursorVisionPrepareStartIndex(prepared.messages ?? [])).toBe(2);
  });

  test("aborted image-phase signal stops further local prepare work", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(prepareCursorImageForWire({
      data: PNG_BYTES,
      mimeType: "image/png",
      uuid: "aborted",
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    await expect(prepareCursorRawMessages([
      {
        role: "user",
        content: [
          { type: "image", imageUrl: PNG_DATA_URL },
          { type: "image", imageUrl: PNG_DATA_URL },
        ],
        timestamp: 1,
      },
    ], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

function actionTextFrom(bytes: Uint8Array): string | undefined {
  const msg = fromBinary(AgentClientMessageSchema, bytes);
  const run = msg.message.case === "runRequest" ? msg.message.value : undefined;
  const action = run?.action?.action;
  return action?.case === "userMessageAction" ? action.value.userMessage?.text : undefined;
}
