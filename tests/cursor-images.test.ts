import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  CursorImageError,
  MAX_CURSOR_IMAGE_BYTES,
  MAX_CURSOR_IMAGES,
  resolveActiveCursorImages,
  resolveCursorImages,
} from "../src/adapters/cursor/images";
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

describe("Cursor image resolver", () => {
  test("rejects more than MAX_CURSOR_IMAGES in one request", async () => {
    const urls = Array.from({ length: MAX_CURSOR_IMAGES + 1 }, () => PNG_DATA_URL);
    await expect(resolveCursorImages(urls)).rejects.toMatchObject({
      name: "CursorImageError",
      message: `Too many images in one request (max ${MAX_CURSOR_IMAGES}).`,
    });
  });

  test("rejects data URLs above the 1 MiB cap", async () => {
  const oversized = "A".repeat(Math.ceil((MAX_CURSOR_IMAGE_BYTES + 1) * 4 / 3));
    await expect(resolveCursorImages([`data:image/png;base64,${oversized}`])).rejects.toMatchObject({
      name: "CursorImageError",
      message: "Image input is too large (max 1 MiB). Resize and retry.",
    });
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

  test("resolveActiveCursorImages returns empty for trailing toolResult continuations", async () => {
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

  test("CursorImageError carries HTTP status for callers", () => {
    const error = new CursorImageError("blocked", 403);
    expect(error.status).toBe(403);
    expect(error.name).toBe("CursorImageError");
  });
});
