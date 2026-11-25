/**
 * Video input reaches only a wire with a published video carrier, and is refused before send
 * everywhere else.
 *
 * Before this contract a video part was swapped for a text marker on the translated Chat,
 * Anthropic and Cursor wires, and an arbitrary remote URL became a "[video: url]" marker on
 * Gemini. Each of those still went upstream and came back as an ordinary answer about a
 * video the model never saw. Grok's chat models were the reported case: xAI documents text
 * and image input only for grok-4.6 and grok-4.7 (docs.x.ai release notes, 2026-08-12 and
 * 2026-09-21), so the honest answer for them is a refusal.
 *
 * Carriers, from the providers' own docs (accessed 2026-11-25):
 * - Gemini generateContent: inline_data, or file_data for YouTube and Files API URIs.
 * - Chat Completions `video_url`: OpenRouter, Qwen (DashScope OpenAI-compatible) and Kimi
 *   (kimi-k3, kimi-k3.1-pro). It is model-specific, so the translated Chat wire carries it only
 *   for a model whose input modalities declare "video".
 */
import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import { UnsupportedInputModalityError, withInputMediaGuard } from "../../src/adapters/input-media-guard";
import { createRegisteredAdapter } from "../../src/adapters/registry";
import { ChatCompletionsRequestError, chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { chatConversationToIr } from "../../src/protocols/codecs/chat-ir";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { untranslatedResponsesInputMedia } from "../../src/responses/input-media";
import { parseRequest } from "../../src/responses/parser";
import { inlineVideoDecodedBytes, MAX_INLINE_VIDEO_BYTES } from "../../src/responses/video-input";
import { estimateInputTokens } from "../../src/server/responses/input-admission";
import { adapterBuildRefusal } from "../../src/server/responses/passthrough-build-error";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const INLINE = "data:video/mp4;base64,AAAAIGZ0eXBpc29t";
const YOUTUBE = "https://www.youtube.com/watch?v=example";
const REMOTE = "https://cdn.example.test/clip.mp4";

const XAI: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "k" };
const KIMI: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.moonshot.ai/v1",
  authMode: "key",
  apiKey: "k",
  modelInputModalities: { "kimi-k3.1-pro": ["text", "image", "video"] },
};
const ANTHROPIC: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "k" };
const GOOGLE: OcxProviderConfig = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", authMode: "key", apiKey: "k" };

function videoRequest(model: string, url: string, extra: Record<string, unknown> = {}, role = "user"): OcxParsedRequest {
  return parseRequest({
    model,
    input: [{
      type: "message",
      role,
      content: [{ type: "input_text", text: "What happens in this clip?" }, { type: "input_video", video_url: url, ...extra }],
    }],
  });
}

/** The thrown message, or undefined when the build went through. Sync and async throws alike. */
async function refusal(provider: OcxProviderConfig, parsed: OcxParsedRequest): Promise<string | undefined> {
  try {
    await createRegisteredAdapter(provider).buildRequest(parsed, { headers: new Headers() } as never);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function body(provider: OcxProviderConfig, parsed: OcxParsedRequest): Promise<Record<string, any>> {
  const request = await createRegisteredAdapter(provider).buildRequest(parsed, { headers: new Headers() } as never);
  return JSON.parse(typeof request.body === "string" ? request.body : JSON.stringify(request.body));
}

describe("video input without a carrier is refused before send", () => {
  test("Grok on the translated Chat wire refuses instead of sending an omission marker", async () => {
    const message = await refusal(XAI, videoRequest("grok-4.7", INLINE));
    expect(message).toContain("video input");
    expect(message).not.toContain("AAAAIGZ0eXBpc29t");
  });

  test("a Chat Completions video_url part projected onto the Responses core is refused the same way", async () => {
    const parsed = parseRequest(chatCompletionsToResponsesBody({
      model: "grok-4.7",
      messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "video_url", video_url: { url: INLINE } }] }],
    }));
    parsed.modelId = "grok-4.7";
    expect(await refusal(XAI, parsed)).toContain("video input");
  });

  test("Anthropic has no video content block, so the old [video] marker never reaches it", async () => {
    expect(await refusal(ANTHROPIC, videoRequest("claude-sonnet-5", INLINE))).toContain("video input");
  });

  test("Gemini refuses a remote URL it cannot fetch rather than flattening it to a marker", async () => {
    expect(await refusal(GOOGLE, videoRequest("gemini-3.8-flash", REMOTE))).toContain("video");
  });

  test("an undeclared model on a video-capable vendor is refused, never sent as an image", async () => {
    expect(await refusal(KIMI, videoRequest("kimi-k2.6", INLINE))).toContain("video input");
  });

  test("video outside user content has no converter and is refused by the typed scan", () => {
    const video = { type: "input_video", video_url: INLINE };
    for (const role of ["system", "assistant"]) {
      expect(untranslatedResponsesInputMedia({ input: [{ type: "message", role, content: [video] }] })).toBe("video");
    }
    expect(untranslatedResponsesInputMedia({ input: [{ type: "function_call_output", call_id: "c", output: [video] }] }))
      .toBe("video");
    expect(untranslatedResponsesInputMedia({ input: [{ type: "message", role: "user", content: [video] }] }))
      .toBeUndefined();
  });

  test("an inline video over the cap is refused on every carrier, without echoing bytes", async () => {
    const payload = "A".repeat(Math.ceil((MAX_INLINE_VIDEO_BYTES + 3) / 3) * 4);
    const oversized = `data:video/mp4;base64,${payload}`;
    for (const [provider, model] of [[GOOGLE, "gemini-3.8-flash"], [KIMI, "kimi-k3.1-pro"]] as const) {
      const message = await refusal(provider, videoRequest(model, oversized));
      expect(message).toContain("MiB");
      expect(message!.length).toBeLessThan(400);
    }
  });

  test("a non-base64 data URL is measured by its length, so it cannot slip under the cap", async () => {
    // 0.75 x length would read 45 MiB here; the payload decodes to up to 60 MiB.
    const plain = `data:video/mp4,${"A".repeat(60 * 1024 * 1024)}`;
    expect(await refusal(KIMI, videoRequest("kimi-k3.1-pro", plain))).toContain("MiB");
  });

  test("a non-ASCII plain data URL is measured in UTF-8 bytes, not UTF-16 units", async () => {
    // 30 Mi characters of "é" are 30 Mi UTF-16 units but 60 MiB on the wire.
    const plain = `data:video/mp4,${"é".repeat(30 * 1024 * 1024)}`;
    expect(await refusal(KIMI, videoRequest("kimi-k3.1-pro", plain))).toContain("MiB");
  });

  test("only a terminal ;base64 marks a base64 payload; anything else is measured as UTF-8", async () => {
    // A decoder reads ";base64;foo" and "; base64" as plain bytes, so the 3/4 formula would
    // report 45 MiB for these 60 MiB payloads.
    const payload = "A".repeat(60 * 1024 * 1024);
    for (const header of ["data:video/mp4;base64;foo,", "data:video/mp4;base64 ,", "data:video/mp4;x=base64,"]) {
      expect(await refusal(KIMI, videoRequest("kimi-k3.1-pro", header + payload))).toContain("MiB");
    }
    expect(inlineVideoDecodedBytes("data:video/mp4;codecs=avc1;BASE64,AAAA")).toBe(3);
  });

  test("both Chat conversions refuse an oversized clip before they build anything", () => {
    const body = {
      model: "kimi-k3.1-pro",
      messages: [{ role: "user", content: [{ type: "video_url", video_url: { url: `data:video/mp4,${"A".repeat(MAX_INLINE_VIDEO_BYTES + 1)}` } }] }],
    };
    for (const convert of [() => chatCompletionsToResponsesBody(body), () => chatConversationToIr(body, "kimi-k3.1-pro")]) {
      let failure: unknown;
      try { convert(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(ChatCompletionsRequestError);
      expect((failure as Error).message).toContain("50 MiB");
    }
  });

  test("a Chat video_url outside user content is refused by both Chat conversions, not dropped", () => {
    const body = {
      model: "kimi-k3.1-pro",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "earlier" }, { type: "video_url", video_url: { url: INLINE } }] },
        { role: "user", content: "and now?" },
      ],
    };
    for (const convert of [() => chatCompletionsToResponsesBody(body), () => chatConversationToIr(body, "kimi-k3.1-pro")]) {
      let failure: unknown;
      try { convert(); } catch (error) { failure = error; }
      expect((failure as Error).message).toContain("cannot translate video input");
    }
  });

  test("a builder refusal reaches the client as 400 unsupported_input_modality", async () => {
    let failure: unknown;
    try { await createRegisteredAdapter(XAI).buildRequest(videoRequest("grok-4.7", INLINE), { headers: new Headers() } as never); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UnsupportedInputModalityError);
    const response = adapterBuildRefusal(failure, undefined)!;
    expect(response.status).toBe(400);
    const payload = await response.json() as { error: { type: string; code: string; message: string } };
    expect(payload.error).toMatchObject({ type: "invalid_request_error", code: "unsupported_input_modality" });
    expect(payload.error.message).not.toContain("AAAAIGZ0eXBpc29t");
  });

  test("run-turn adapters answer with the established unsupported_input_modality error", async () => {
    let runs = 0;
    const adapter: ProviderAdapter = {
      name: "stub",
      buildRequest() { return { url: "https://example.invalid", method: "POST", headers: {}, body: "{}" }; },
      async *parseStream() { yield { type: "done", endTurn: true }; },
      async runTurn(_parsed, _incoming, emit) { runs++; emit({ type: "done", endTurn: true }); },
    };
    const guarded = withInputMediaGuard(adapter, "cursor");
    const events: AdapterEvent[] = [];
    await guarded.runTurn!(videoRequest("auto", INLINE), { headers: new Headers() } as never, event => { events.push(event); });
    expect(runs).toBe(0);
    expect(events).toEqual([expect.objectContaining({ type: "error", status: 400, code: "unsupported_input_modality" })]);
  });
});

describe("video input on a published carrier", () => {
  test("a declared Chat model receives the Chat video_url part in user content", async () => {
    const sent = await body(KIMI, videoRequest("kimi-k3.1-pro", INLINE));
    const user = sent.messages.find((m: Record<string, unknown>) => m.role === "user");
    expect(user.content).toEqual([
      { type: "text", text: "What happens in this clip?" },
      { type: "video_url", video_url: { url: INLINE } },
    ]);
    expect(JSON.stringify(sent)).not.toContain("video omitted");
  });

  test("modelCapabilities declares video just as the per-model modality map does", async () => {
    const provider: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://openrouter.ai/api/v1",
      authMode: "key",
      apiKey: "k",
      modelCapabilities: { "google/gemini-3.8-flash": { inputModalities: ["text", "image", "video"] } },
    };
    const sent = await body(provider, videoRequest("google/gemini-3.8-flash", YOUTUBE, { processing: "agentic" }));
    const user = sent.messages.find((m: Record<string, unknown>) => m.role === "user");
    expect(user.content[1]).toEqual({ type: "video_url", video_url: { url: YOUTUBE, processing: "agentic" } });
  });

  test("a developer message has no Chat video carrier, even for a declared model", async () => {
    expect(await refusal(KIMI, videoRequest("kimi-k3.1-pro", INLINE, {}, "developer"))).toContain("video input");
  });

  test("Gemini keeps inline bytes and YouTube URLs", async () => {
    const inline = await body(GOOGLE, videoRequest("gemini-3.8-flash", INLINE));
    expect(JSON.stringify(inline.contents)).toContain("inline_data");
    const fetched = await body(GOOGLE, videoRequest("gemini-3.8-flash", YOUTUBE));
    expect(JSON.stringify(fetched.contents)).toContain(`"file_uri":"${YOUTUBE}"`);
  });

  test("Gemini sends a base64 data URL with header parameters and any-case marker; refuses a plain one", async () => {
    // The URL the sizing test measures as base64 must also be one the Gemini builder can send.
    const sent = await body(GOOGLE, videoRequest("gemini-3.8-flash", "data:video/mp4;codecs=avc1;BASE64,AAAA"));
    expect(JSON.stringify(sent.contents)).toContain(JSON.stringify({ inline_data: { mime_type: "video/mp4", data: "AAAA" } }));
    let failure: unknown;
    try { await createRegisteredAdapter(GOOGLE).buildRequest(videoRequest("gemini-3.8-flash", "data:video/mp4,AAAA"), { headers: new Headers() } as never); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(UnsupportedInputModalityError);
    expect((failure as Error).message).toContain("base64 data URL");
  });

  test("Gemini never receives a URL-escaped or non-standard base64 payload as inline_data", async () => {
    // A data URL may percent-escape its payload, but inline_data.data takes plain base64:
    // "QQ%3D%3D" would reach Gemini as a string that is not base64 at all.
    for (const url of ["data:video/mp4;base64,QQ%3D%3D", "data:video/mp4;base64,QQ%3", "data:video/mp4;base64,QQ== ", "data:video/mp4;base64,-_8="]) {
      let failure: unknown;
      try { await createRegisteredAdapter(GOOGLE).buildRequest(videoRequest("gemini-3.8-flash", url), { headers: new Headers() } as never); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(UnsupportedInputModalityError);
      expect((failure as Error).message).toContain("base64 data URL");
    }
    const sent = await body(GOOGLE, videoRequest("gemini-3.8-flash", "data:video/mp4;base64,QQ=="));
    expect(JSON.stringify(sent.contents)).toContain(JSON.stringify({ inline_data: { mime_type: "video/mp4", data: "QQ==" } }));
  });

  test("the Moonshot preset declares video for the Kimi K3 series its docs list", () => {
    const modalities = getProviderRegistryEntry("moonshot")?.modelInputModalities ?? {};
    for (const model of ["kimi-k3", "kimi-k3.1-pro"]) expect(modalities[model]).toContain("video");
  });
});

describe("input admission charges video by its own rate", () => {
  function videoOnly(url: string): OcxParsedRequest {
    return {
      modelId: "m",
      stream: false,
      options: {},
      context: { messages: [{ role: "user", content: [{ type: "video", videoUrl: url }], timestamp: 0 }] },
    } as unknown as OcxParsedRequest;
  }

  test("inline bytes are charged at the video rate, not the image tile proxy", () => {
    // 1,250,000 decoded bytes: about ten seconds of ~1 Mbit/s video, which Gemini bills at
    // roughly 100 tokens per second. The image proxy (750 bytes/token) charged 1,667.
    const payload = "A".repeat((1_250_000 / 3) * 4);
    expect(estimateInputTokens(videoOnly(`data:video/mp4;base64,${payload}`), "m")).toBe(1_000);
  });

  test("a fetched URL is charged a flat minute, not the 850-token image tile", () => {
    expect(estimateInputTokens(videoOnly(YOUTUBE), "m")).toBe(6_000);
  });
});
