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
import { countKiroUninlinableImages, extractKiroImages, kiroUninlinableImageMarker } from "../../../src/adapters/kiro-images";
import type { OcxContentPart } from "../../../src/types";

const DATA_IMAGE = "data:image/png;base64,TkVX";
const REMOTE = "https://example.test/private.png?sig=SECRETTOKEN";

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
    // It is not inlinable either, but the cause differs, so it must not be counted
    // by the remote-reference marker.
    expect(countKiroUninlinableImages([{ type: "image", imageUrl: "data:image/png;base64," }])).toBe(0);
  });
});
