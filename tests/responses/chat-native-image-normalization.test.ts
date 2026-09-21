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
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { parseRequest } from "../../src/responses/parser";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { withTestTranslatorBudget } from "../helpers/translator-budget";
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

describe("F1 normalization does not allocate on the common path", () => {
  test("a text-only body is returned by reference with its arrays untouched", () => {
    const body = userBody([{ type: "text", text: "plain" }]);
    const messages = body.messages;
    const content = (messages as Record<string, unknown>[])[0]!.content;

    const out = normalizeChatImageParts(body);

    // Identity of the nested arrays too: an earlier revision preserved only the
    // top-level reference while still rebuilding every message and content array.
    expect(out).toBe(body);
    expect(out.messages).toBe(messages);
    expect((out.messages as Record<string, unknown>[])[0]!.content).toBe(content);
  });

  test("an unchanged message keeps its own reference when a sibling is rewritten", () => {
    const untouched = { role: "user", content: [{ type: "text", text: "first" }] };
    const body = {
      model: "m",
      messages: [untouched, { role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }] }],
    };

    const out = normalizeChatImageParts(body);
    const outMessages = out.messages as Record<string, unknown>[];

    expect(out).not.toBe(body);
    expect(outMessages[0]).toBe(untouched);
    expect(outMessages[1]).not.toBe(body.messages[1]);
  });
});

describe("F1 tool-role images use the standard Chat carrier", () => {
  // A standard Chat tool message accepts a string or text parts only. Rewriting a
  // foreign tool image into image_url leaves it inside a tool message, which a
  // standard-enforcing endpoint rejects — so shape normalization alone is not enough.
  const toolImageVariants: Array<[string, Record<string, unknown>]> = [
    ["Pi/MCP data part", { type: "image", data: PNG, mimeType: "image/png" }],
    ["Anthropic base64 source", { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }],
    ["already-OpenAI image_url", { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }],
  ];

  for (const [label, part] of toolImageVariants) {
    test(`diverts a tool image off the native path: ${label}`, () => {
      const body = { model: "vision-model", messages: [{ role: "tool", tool_call_id: "call1", content: [part] }] };

      // Both before and after normalization: the shape changes, the placement problem does not.
      expect(isNativeChatRouteEligible(route(), body)).toBe(false);
      expect(isNativeChatRouteEligible(route(), normalizeChatImageParts(body))).toBe(false);
    });
  }

  test("a text-only tool result stays on the native fast path", () => {
    const body = { model: "vision-model", messages: [{ role: "tool", tool_call_id: "call1", content: "done" }] };
    expect(isNativeChatRouteEligible(route(), body)).toBe(true);
  });

  test("a tool result with text parts only stays native", () => {
    const body = {
      model: "vision-model",
      messages: [{ role: "tool", tool_call_id: "call1", content: [{ type: "text", text: "done" }] }],
    };
    expect(isNativeChatRouteEligible(route(), body)).toBe(true);
  });

  test("a user image on a vision-capable route is unaffected by the tool-image rule", () => {
    expect(isNativeChatRouteEligible(route(), userBody([{ type: "image", data: PNG, mimeType: "image/png" }]))).toBe(true);
  });

  test("the translated wire puts the screenshot in a user carrier after a string tool result", async () => {
    const body = normalizeChatImageParts({
      model: "vision-model",
      messages: [
        { role: "user", content: "Describe the screenshot." },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call1", type: "function", function: { name: "screenshot", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call1", content: [{ type: "image", data: PNG, mimeType: "image/png" }] },
      ],
    });

    expect(isNativeChatRouteEligible(route(), body)).toBe(false);

    const parsed = parseRequest(chatCompletionsToResponsesBody(body));
    const adapter = withTestTranslatorBudget(createOpenAIChatAdapter(route().provider));
    const wire = JSON.parse((await adapter.buildRequest(parsed)).body as string) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    const toolIndex = wire.messages.findIndex(m => m.role === "tool");
    expect(toolIndex).toBeGreaterThanOrEqual(0);

    // Every tool message is a plain string: this is the standard-schema requirement
    // a permissive mock that merely counts image parts would not catch.
    expect(wire.messages.every(m => m.role !== "tool" || typeof m.content === "string")).toBe(true);

    const carrierIndex = wire.messages.findIndex(m => m.role === "user"
      && Array.isArray(m.content)
      && (m.content as Array<Record<string, unknown>>).some(p => p?.type === "image_url"));
    expect(carrierIndex).toBeGreaterThan(toolIndex);
  });
});
