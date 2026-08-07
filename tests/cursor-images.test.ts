import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
  CursorImageError,
  CURSOR_VISION_IMAGE_OMITTED,
  CURSOR_VISION_PROMOTE_NUDGE,
  CURSOR_VISION_SOFT_MAX_BYTES,
  CURSOR_VISION_SOFT_MAX_BYTES_HIGH,
  MAX_CURSOR_IMAGE_BYTES,
  MAX_CURSOR_IMAGE_DECODE_BYTES,
  MAX_CURSOR_IMAGES,
  buildSelectedImages,
  extractTrailingToolResultImageParts,
  extractTrailingToolResultImagePromotion,
  prepareCursorImageForWire,
  prepareCursorRawMessages,
  isTransparentCursorVisionSuffix,
  resolveActiveCursorImages,
  resolveCursorImages,
  sniffCursorImageDimensions,
  stripTrailingTransparentDeveloperMessages,
} from "../src/adapters/cursor/images";
import {
  handleCursorNativeKv,
  resetCursorBlobStateForTests,
} from "../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
} from "../src/adapters/cursor/gen/agent_pb";
import * as destinationPolicy from "../src/lib/destination-policy";
import * as imageArtifacts from "../src/images/artifacts";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DATA_URL = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`;

const spies: Array<ReturnType<typeof spyOn>> = [];

function mockSpy<T extends object, K extends keyof T>(
  object: T,
  method: K,
  implementation: T[K],
): ReturnType<typeof spyOn> {
  const spy = spyOn(object, method).mockImplementation(implementation as never);
  spies.push(spy);
  return spy;
}

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

function mockPublicHttpsFetch(body = PNG_BYTES, mimeType = "image/png") {
  mockSpy(destinationPolicy, "assessUrlDestination", () => ({ kind: "public" as const }));
  mockSpy(destinationPolicy, "resolvePublicAddresses", async () => ({
    addresses: [{ address: "93.184.216.34", family: 4 }],
    hostname: "example.com",
  }));
  mockSpy(imageArtifacts, "pinnedHttpsGet", async () => new Response(body, {
    status: 200,
    headers: { "content-type": mimeType },
  }));
}

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
  });

  test("rejects data URLs above the inbound decode bomb ceiling", async () => {
    const oversized = "A".repeat(Math.ceil((MAX_CURSOR_IMAGE_DECODE_BYTES + 1) * 4 / 3));
    await expect(resolveCursorImages([`data:image/png;base64,${oversized}`])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image input is too large to process safely.",
    });
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
    const junk = "A".repeat(Math.ceil((MAX_CURSOR_IMAGE_BYTES + 1) * 4 / 3));
    const resolved = await resolveCursorImages([`data:image/png;base64,${junk}`]);
    expect(resolved).toEqual([]);
  });

  test("decodes valid base64 data URLs", async () => {
    const resolved = await resolveCursorImages([PNG_DATA_URL]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("image/png");
    expect(Array.from(resolved[0]?.data ?? [])).toEqual(Array.from(PNG_BYTES));
    expect(resolved[0]?.uuid.length).toBeGreaterThan(0);
  });

  test("rejects malformed and non-image data URLs", async () => {
    await expect(resolveCursorImages(["data:image/png,not-base64"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image data URL must be base64-encoded.",
    });
    await expect(resolveCursorImages(["data:text/plain;base64,YQ=="])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image data URL must have an image/* media type.",
    });
    await expect(resolveCursorImages(["data:image/png;base64"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image data URL is malformed.",
    });
    await expect(resolveCursorImages(["data:image/png;base64,"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image input is empty.",
    });
  });

  test("rejects non-HTTPS remote URLs", async () => {
    await expect(resolveCursorImages(["http://example.com/image.png"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image URL must use HTTPS.",
    });
  });

  test("rejects blocked destinations before DNS resolution", async () => {
    mockSpy(destinationPolicy, "assessUrlDestination", () => ({ kind: "loopback" as const }));
    await expect(resolveCursorImages(["https://127.0.0.1/image.png"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image URL points to a blocked address.",
    });
  });

  test("rejects remote URLs when public DNS resolution fails", async () => {
    mockSpy(destinationPolicy, "assessUrlDestination", () => ({ kind: "public" as const }));
    mockSpy(destinationPolicy, "resolvePublicAddresses", async () => {
      throw new Error("blocked");
    });
    await expect(resolveCursorImages(["https://example.com/image.png"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image URL host could not be resolved.",
    });
  });

  test("fetches HTTPS images through pinned HTTPS with image content-type", async () => {
    mockPublicHttpsFetch();
    const resolved = await resolveCursorImages(["https://example.com/image.png"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("image/png");
    expect(Array.from(resolved[0]?.data ?? [])).toEqual(Array.from(PNG_BYTES));
  });

  test("rejects HTTPS responses without an image content-type", async () => {
    mockPublicHttpsFetch(PNG_BYTES, "text/plain");
    await expect(resolveCursorImages(["https://example.com/not-image"])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image URL did not return an image content type.",
    });
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
    expect(resolved[0]?.mimeType).toBe("image/png");
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

  test("resolveActiveCursorImages promotes trailing view_image toolResult images", async () => {
    const resolved = await resolveActiveCursorImages([
      { role: "user", content: "describe", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_view",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL, detail: "auto" }],
        isError: false,
        timestamp: 2,
      },
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.data.byteLength).toBeGreaterThan(0);
  });

  test("transparent developer suffix does not block view_image SelectedImage promotion", async () => {
    // Desktop injects <multi_agent_mode> after toolResult; that must stay transparent for vision.
    const collab = "<multi_agent_mode>Preferred sub-agent: model \"cursor/grok-4.5\", reasoning_effort \"high\"</multi_agent_mode>";
    const messages = [
      { role: "user" as const, content: "What is in this image? Do not guess.", timestamp: 1 },
      {
        role: "assistant" as const,
        model: "cursor/grok-4.5",
        timestamp: 2,
        content: [{ type: "toolCall" as const, id: "call_view", name: "view_image", arguments: { path: "/tmp/x.png" } }],
      },
      {
        role: "toolResult" as const,
        toolCallId: "call_view",
        toolName: "view_image",
        content: [{ type: "image" as const, imageUrl: PNG_DATA_URL, detail: "high" }],
        isError: false,
        timestamp: 3,
      },
      { role: "developer" as const, content: collab, timestamp: 4 },
    ];
    expect(isTransparentCursorVisionSuffix(messages[3]!)).toBe(true);
    expect(stripTrailingTransparentDeveloperMessages(messages).at(-1)?.role).toBe("toolResult");
    const resolved = await resolveActiveCursorImages(messages);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.data.byteLength).toBeGreaterThan(0);
  });

  test("user message after toolResult is not transparent (does not promote stale tool images)", async () => {
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

  test("resolveActiveCursorImages collects consecutive trailing image toolResults", async () => {
    const second = `data:image/png;base64,${Buffer.from([...PNG_BYTES, 1]).toString("base64")}`;
    const resolved = await resolveActiveCursorImages([
      { role: "user", content: "describe both", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "call_a",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: PNG_DATA_URL }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_b",
        toolName: "view_image",
        content: [{ type: "image", imageUrl: second }],
        isError: false,
        timestamp: 3,
      },
    ]);
    expect(resolved).toHaveLength(2);
  });

  test("extractTrailingToolResultImageParts keeps the newest MAX_CURSOR_IMAGES", () => {
    const urls = Array.from({ length: MAX_CURSOR_IMAGES + 2 }, (_, i) => (
      `data:image/png;base64,${Buffer.from([...PNG_BYTES, i]).toString("base64")}`
    ));
    const messages = urls.map((imageUrl, i) => ({
      role: "toolResult" as const,
      toolCallId: `call_${i}`,
      toolName: "view_image",
      content: [{ type: "image" as const, imageUrl }],
      isError: false,
      timestamp: i + 1,
    }));
    const { parts, omittedOlder } = extractTrailingToolResultImageParts(messages);
    expect(omittedOlder).toBe(2);
    expect(parts).toHaveLength(MAX_CURSOR_IMAGES);
    expect(parts[0]?.imageUrl).toBe(urls[2]);
    expect(parts.at(-1)?.imageUrl).toBe(urls.at(-1));
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

  test("extractTrailingToolResultImagePromotion scopes call ids to kept parts", () => {
    const urls = Array.from({ length: MAX_CURSOR_IMAGES + 2 }, (_, i) => (
      `data:image/png;base64,${Buffer.from([...PNG_BYTES, i]).toString("base64")}`
    ));
    const messages = urls.map((imageUrl, i) => ({
      role: "toolResult" as const,
      toolCallId: `call_${i}`,
      toolName: "view_image",
      content: [{ type: "image" as const, imageUrl }],
      isError: false,
      timestamp: i + 1,
    }));
    const { parts, omittedOlder, promotedCallIds } = extractTrailingToolResultImagePromotion(messages);
    expect(omittedOlder).toBe(2);
    expect(parts).toHaveLength(MAX_CURSOR_IMAGES);
    expect(promotedCallIds.has("call_0")).toBe(false);
    expect(promotedCallIds.has("call_1")).toBe(false);
    expect(promotedCallIds.has("call_2")).toBe(true);
    expect(promotedCallIds.has(`call_${MAX_CURSOR_IMAGES + 1}`)).toBe(true);
  });

  test("promote nudge warns against path/filename inference", () => {
    expect(CURSOR_VISION_PROMOTE_NUDGE).toContain("Describe the image from the tool result.");
    expect(CURSOR_VISION_PROMOTE_NUDGE).toContain("Do not infer content from file paths or names.");
  });

  test("prepareCursorRawMessages JPEG-preps view_image tool-result data URLs", async () => {
    const pngPath = new URL("./helpers/cursor-grumpy-fixture.png", import.meta.url);
    const png = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
    const imageUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const prepared = await prepareCursorRawMessages([
      { role: "user", content: "describe", timestamp: 1 },
      {
        role: "assistant",
        model: "cursor/grok-4.5",
        content: [{ type: "toolCall", id: "call_view", name: "view_image", arguments: { path: "/tmp/x.png" } }],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_view",
        toolName: "view_image",
        content: [{ type: "image", imageUrl, detail: "auto" }],
        isError: false,
        timestamp: 3,
      },
    ]);
    const tool = prepared?.[2];
    expect(tool?.role).toBe("toolResult");
    if (tool?.role !== "toolResult" || typeof tool.content === "string") throw new Error("expected image parts");
    const part = tool.content.find(item => item.type === "image");
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
    const user = prepared?.[0];
    expect(user?.role).toBe("user");
    if (user?.role !== "user" || typeof user.content === "string") throw new Error("expected parts");
    expect(user.content).toEqual([{ type: "text", text: CURSOR_VISION_IMAGE_OMITTED }]);
  });
});
