/**
 * Audit F1 (2026-09-14): the native Chat fast path recognized only `image_url`,
 * while the translated path also understood Pi/MCP `{type:"image", data, mimeType}`
 * and Anthropic-shaped `{type:"image", source}` parts.
 *
 * Two failures followed from that one gap. A text-only routed model kept an
 * image-bearing body, because `isNativeChatRouteEligible` could not see the image.
 * And the native path is a whitelist passthrough, so the foreign part was forwarded
 * verbatim to an OpenAI-compatible upstream that does not accept it.
 *
 * These assert the desired behavior: one shared recognizer, and normalization before
 * route selection. No network is involved — a remote `source.type:"url"` is
 * recognized and rewritten, never fetched.
 */
import { describe, expect, test } from "bun:test";
import {
  chatBodyCarriesImage,
  chatImageUrlFromPart,
  normalizeChatImageParts,
} from "../../src/chat/image-parts";
import { isNativeChatRouteEligible } from "../../src/server/chat-native";
import type { OcxProviderConfig } from "../../src/types";
import type { RouteResult } from "../../src/router";

const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function route(overrides: Partial<OcxProviderConfig> = {}, modelId = "vision-model"): RouteResult {
  return {
    provider: {
      adapter: "openai-chat",
      baseUrl: "https://gateway.example/v1",
      authMode: "key",
      apiKey: "test-key",
      ...overrides,
    },
    providerName: "gateway",
    modelId,
  } as unknown as RouteResult;
}

/**
 * An operator-declared text-only model: the case that must be diverted.
 * isModelVisionSidecarConsumer (src/vision/eligibility.ts:79-89) reads an explicit
 * modelCapabilities.inputModalities declaration first, so ["text"] without "image"
 * is the operator saying this model is blind.
 */
function textOnlyRoute(): RouteResult {
  return route({ modelCapabilities: { "text-only-model": { inputModalities: ["text"] } } }, "text-only-model");
}

function userBody(parts: unknown[]): Record<string, unknown> {
  return { model: "m", messages: [{ role: "user", content: parts }] };
}

describe("F1 shared inbound image recognition", () => {
  test("recognizes the OpenAI shape in both spellings", () => {
    expect(chatImageUrlFromPart({ type: "image_url", image_url: { url: "https://x/i.png" } })).toBe("https://x/i.png");
    expect(chatImageUrlFromPart({ type: "image_url", image_url: "https://x/j.png" })).toBe("https://x/j.png");
  });

  test("recognizes a Pi/MCP part and builds a data URI from mimeType", () => {
    expect(chatImageUrlFromPart({ type: "image", data: PNG, mimeType: "image/png" }))
      .toBe(`data:image/png;base64,${PNG}`);
  });

  test("recognizes both Anthropic source forms", () => {
    expect(chatImageUrlFromPart({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG } }))
      .toBe(`data:image/jpeg;base64,${PNG}`);
    expect(chatImageUrlFromPart({ type: "image", source: { type: "url", url: "https://x/k.png" } }))
      .toBe("https://x/k.png");
  });

  test("returns null for a part carrying no usable reference", () => {
    expect(chatImageUrlFromPart({ type: "image" })).toBeNull();
    expect(chatImageUrlFromPart({ type: "text", text: "hi" })).toBeNull();
  });
});

describe("F1 normalization before route selection", () => {
  test("rewrites a Pi part into image_url form", () => {
    const body = userBody([{ type: "text", text: "look" }, { type: "image", data: PNG, mimeType: "image/png" }]);
    const out = normalizeChatImageParts(body);
    const content = (out.messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[];

    expect(content[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
    // The sibling text part and its order are untouched.
    expect(content[0]).toEqual({ type: "text", text: "look" });
  });

  test("preserves a detail hint through the rewrite", () => {
    const out = normalizeChatImageParts(userBody([{ type: "image", data: PNG, mimeType: "image/png", detail: "high" }]));
    const content = (out.messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}`, detail: "high" } });
  });

  test("normalizes an image-only message with no text part", () => {
    const out = normalizeChatImageParts(userBody([{ type: "image", source: { type: "url", url: "https://x/o.png" } }]));
    const content = (out.messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: "image_url", image_url: { url: "https://x/o.png" } });
  });

  test("normalizes a tool message's image part", () => {
    const body = {
      model: "m",
      messages: [{ role: "tool", tool_call_id: "call1", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }],
    };
    const content = (normalizeChatImageParts(body).messages as Record<string, unknown>[])[0]!.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "image_url" });
  });

  test("returns the identical reference when there is no image", () => {
    const body = userBody([{ type: "text", text: "plain" }]);
    expect(normalizeChatImageParts(body)).toBe(body);
  });

  test("returns the identical reference when images are already image_url", () => {
    const body = userBody([{ type: "image_url", image_url: { url: "https://x/p.png" } }]);
    expect(normalizeChatImageParts(body)).toBe(body);
  });

  test("leaves every other body field untouched", () => {
    const body = { ...userBody([{ type: "image", data: PNG, mimeType: "image/png" }]), temperature: 0.5, stream: true };
    const out = normalizeChatImageParts(body);
    expect(out.temperature).toBe(0.5);
    expect(out.stream).toBe(true);
    expect(out.model).toBe("m");
  });
});

describe("F1 text-only diversion sees every image shape", () => {
  test("diverts a Pi-shaped image away from the native fast path", () => {
    expect(chatBodyCarriesImage(userBody([{ type: "image", data: PNG, mimeType: "image/png" }]))).toBe(true);
    expect(isNativeChatRouteEligible(textOnlyRoute(), userBody([{ type: "image", data: PNG, mimeType: "image/png" }]))).toBe(false);
  });

  test("diverts an Anthropic base64 image", () => {
    const body = userBody([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]);
    expect(isNativeChatRouteEligible(textOnlyRoute(), body)).toBe(false);
  });

  test("diverts an Anthropic remote-url image without fetching it", () => {
    const body = userBody([{ type: "image", source: { type: "url", url: "https://x/q.png" } }]);
    expect(isNativeChatRouteEligible(textOnlyRoute(), body)).toBe(false);
  });

  test("diverts an image carried by a tool message", () => {
    const body = {
      model: "m",
      messages: [{ role: "tool", tool_call_id: "call1", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }],
    };
    expect(chatBodyCarriesImage(body)).toBe(true);
  });

  test("a text-only body still takes the native fast path", () => {
    expect(chatBodyCarriesImage(userBody([{ type: "text", text: "plain" }]))).toBe(false);
    expect(isNativeChatRouteEligible(textOnlyRoute(), userBody([{ type: "text", text: "plain" }]))).toBe(true);
  });

  test("a vision-capable route keeps an image-bearing body on the native path", () => {
    const body = userBody([{ type: "image", data: PNG, mimeType: "image/png" }]);
    expect(isNativeChatRouteEligible(route(), body)).toBe(true);
  });
});
