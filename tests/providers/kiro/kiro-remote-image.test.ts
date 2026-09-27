/**
 * Audit (2026-09-14): a remote image reference disappeared from a Kiro turn with
 * neither bytes nor any marker — both the payload and the evidence that an attachment
 * existed were gone.
 *
 * Kiro's wire carries base64 bytes only, so a remote reference genuinely cannot be
 * inlined, and this proxy does not fetch one on a request path. The fix is to stop
 * losing it silently: a bounded, URL-free marker is attached instead. The URL is never
 * echoed, because a remote image URL can carry a signed token.
 */
import { describe, expect, test } from "bun:test";
import { countKiroUninlinableImages, extractKiroImages, kiroImageOmissionMarker, kiroUninlinableImageMarker } from "../../../src/adapters/kiro-images";
import { buildKiroPayload } from "../../../src/adapters/kiro/payload";
import type { OcxContentPart, OcxParsedRequest } from "../../../src/types";

const DATA_IMAGE = "data:image/png;base64,TkVX";
const REMOTE = "https://example.test/private.png?sig=SECRETTOKEN";

/** Build a wire payload from the minimal parsed request used by image-marker tests. */
function payloadWith(messages: unknown[], tools?: unknown[]): Record<string, unknown> {
  const parsed = {
    modelId: "claude-sonnet-4.5", stream: true, options: {}, context: { messages, ...(tools ? { tools } : {}) },
  } as unknown as OcxParsedRequest;
  return buildKiroPayload(parsed, undefined, "disabled").payload;
}

describe("Kiro remote images are reported, not silently dropped", () => {
  test("a remote reference is counted as uninlinable", () => {
    expect(countKiroUninlinableImages([{ type: "image", imageUrl: REMOTE }])).toBe(1);
  });

  test("a data URL is inlinable and is not counted", () => {
    expect(countKiroUninlinableImages([{ type: "image", imageUrl: DATA_IMAGE }])).toBe(0);
    expect(extractKiroImages([{ type: "image", imageUrl: DATA_IMAGE }])).toHaveLength(1);
  });

  test("mixed content counts only the uninlinable ones", () => {
    // Annotated: a bare literal widens `type` to string and fails the
    // string | OcxContentPart[] parameter under strict mode.
    const content: OcxContentPart[] = [
      { type: "text", text: "look" },
      { type: "image", imageUrl: DATA_IMAGE },
      { type: "image", imageUrl: REMOTE },
    ];

    expect(countKiroUninlinableImages(content)).toBe(1);
    expect(extractKiroImages(content)).toHaveLength(1);
  });

  test("the marker never contains the URL or its token", () => {
    const marker = kiroUninlinableImageMarker(1);

    expect(marker).not.toContain("example.test");
    expect(marker).not.toContain("SECRETTOKEN");
    expect(marker).toContain("remote image references are not supported");
  });

  test("the marker is bounded and pluralizes by count", () => {
    expect(kiroUninlinableImageMarker(2)).toContain("2 images omitted");
    expect(kiroUninlinableImageMarker(2).length).toBeLessThan(200);
  });

  test("no uninlinable image produces no marker", () => {
    expect(kiroUninlinableImageMarker(0)).toBe("");
    expect(kiroUninlinableImageMarker(countKiroUninlinableImages("plain text"))).toBe("");
  });

  test("a malformed data URL is not mislabelled as a remote reference", () => {
    const content: OcxContentPart[] = [
      { type: "image", imageUrl: "data:image/png;base64," },
      { type: "image", imageUrl: "data:image/png;base64" },
    ];
    expect(countKiroUninlinableImages(content)).toBe(0);
    expect(extractKiroImages(content)).toHaveLength(0);
    expect(kiroImageOmissionMarker(content)).toContain("2 images omitted: malformed inline image data URLs");
    expect(kiroImageOmissionMarker(content)).not.toContain("remote image references");
  });

  test("mixed remote and malformed inline references have distinct bounded markers", () => {
    const content: OcxContentPart[] = [
      { type: "image", imageUrl: REMOTE },
      { type: "image", imageUrl: "data:image/png;base64," },
      { type: "image", imageUrl: DATA_IMAGE },
    ];
    const marker = kiroImageOmissionMarker(content);
    expect(marker).toContain("remote image references are not supported");
    expect(marker).toContain("malformed inline image data URL");
    expect(marker).not.toContain(REMOTE);
    expect(marker).not.toContain(DATA_IMAGE);
    expect(marker.length).toBeLessThan(200);
  });

  test("a malformed inline image in a user turn is visible on the Kiro wire", () => {
    const payload = payloadWith([{ role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64," }] }]);
    const state = payload.conversationState as { currentMessage: { userInputMessage: { content: string; images?: unknown[] } } };
    expect(state.currentMessage.userInputMessage.content).toContain("malformed inline image data URL");
    expect(state.currentMessage.userInputMessage.images).toBeUndefined();
  });

  test("a malformed inline image in a tool result survives payload grouping", () => {
    const payload = payloadWith([
      { role: "user", content: "take a screenshot" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "shot", arguments: {} }], model: "m" },
      { role: "toolResult", toolCallId: "t1", toolName: "shot", isError: false, content: "captured" },
      { role: "toolResult", toolCallId: "t1", toolName: "shot", isError: false,
        content: [{ type: "image", imageUrl: "data:image/png;base64," }] },
    ], [{ name: "shot", description: "screenshot", parameters: { type: "object" } }]);
    const wire = JSON.stringify(payload);
    expect(wire).toContain("malformed inline image data URL");
    expect(wire).not.toContain("data:image/png;base64,");
  });
});
