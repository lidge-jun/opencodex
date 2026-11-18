import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../../src/server/responses/core";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "./owned-spend-home";
import { removeTreeWithRetry } from "./remove-tree";

export const providerName = "anthropic-image-fixture";
export const target = "https://anthropic-image.example.test/v1/messages";
export const credential = "synthetic-image-fixture-key";
const model = "claude-sonnet-4-5";
const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type Lane = "direct" | "search" | "media";
export interface WireSend {
  url: string;
  key: string | null;
  redirect: RequestRedirect | undefined;
  body: string;
}

export async function fixture(options: {
  enabled?: boolean;
  lane?: Lane;
  image?: "large" | "normal" | "none" | "newest-only";
  handle: (request: WireSend, index: number, config: OcxConfig) => Response | Promise<Response>;
  requestOptions?: Parameters<typeof handleResponses>[3];
}): Promise<{ sent: WireSend[]; response: Response; text: string }> {
  const home = mkdtempSync(join(tmpdir(), "ocx-image-recovery-"));
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;
  process.env.OPENCODEX_HOME = home;
  const release = acquireOwnedSpendHome();
  const sent: WireSend[] = [];
  try {
    const config: OcxConfig = {
      defaultProvider: providerName,
      emptyCompletionRetry: false,
      providers: {
        [providerName]: {
          adapter: "anthropic", baseUrl: target, authMode: "key", apiKey: credential, proxy: "direct",
          models: [model],
          ...(options.enabled === undefined ? {} : { anthropicImageContextRecovery: options.enabled }),
          requestPacing: { enabled: true, maxConcurrentRequests: 1 },
        },
      },
    } as OcxConfig;
    const tools = [];
    if (options.lane === "search") {
      config.webSearchSidecar = { backend: "exa", exaApiKey: "synthetic-unused-search-key" };
      tools.push({ type: "web_search" });
    }
    if (options.lane === "media") {
      config.images = { bridgeEnabled: true };
      config.providers.xai = { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1",
        authMode: "key", apiKey: "synthetic-unused-media-key", proxy: "direct" };
      tools.push({ type: "image_generation" });
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const send = { url, key: new Headers(init?.headers).get("x-api-key"), redirect: init?.redirect, body: String(init?.body) };
      sent.push(send);
      if (url !== target) throw new Error("Unexpected synthetic image fixture destination");
      return options.handle(send, sent.length, config);
    }) as typeof fetch;
    const imageData = options.image === "large"
      ? Buffer.from(await new Bun.Image(Buffer.from(onePixel, "base64")).resize(2400, 2400).png().toBuffer()).toString("base64")
      : onePixel;
    const image = { type: "input_image", image_url: `data:image/png;base64,${imageData}` };
    const raw = {
      model: `${providerName}/${model}`, stream: options.lane !== undefined && options.lane !== "direct",
      store: false, tools, input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: `Older screenshot. ${"Archived context. ".repeat(120)}` },
          ...(!["none", "newest-only"].includes(options.image ?? "") ? [image] : [])] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Read the older screenshot" }] },
        { type: "message", role: "user", content: [
          { type: "input_text", text: `Keep the newest screenshot. ${"Recent context. ".repeat(200)}` },
          ...(options.image !== "none" ? [image] : []),
        ] },
      ],
    };
    const upstream = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json", "thread-id": "fixture-image-turn" },
      body: JSON.stringify(raw), signal: options.requestOptions?.abortSignal,
    }), config, { model: "", provider: "" }, options.requestOptions);
    return { sent, response: upstream, text: await upstream.text() };
  } finally {
    try { release(); } finally {
      globalThis.fetch = previousFetch;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  }
}

export function image413(type = "request_too_large"): Response {
  return Response.json({ type: "error", error: { type } }, { status: 413 });
}

export function completion(text: string, streaming = false): Response {
  if (!streaming) return Response.json({ content: [{ type: "text", text }], stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 2 } });
  const frame = (type: string, data: Record<string, unknown> = {}) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return new Response([
    frame("message_start", { message: { usage: { input_tokens: 10 } } }),
    frame("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    frame("message_stop"),
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}
