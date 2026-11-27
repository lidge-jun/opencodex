/**
 * `video_gen` on the OpenAI Videos wire (#9110): a provider row with `videoApi: "openai"` named by
 * `images.videoProvider` is submitted, polled and downloaded on that wire, through the real outbound
 * policy, against a local fake upstream. No paid API and no real credential is involved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { pollVideoWithHeartbeats } from "../../src/images/fulfill-video";
import { runWithImageBridge } from "../../src/images/loop";
import { planVideoBridge } from "../../src/images/plan";
import { videoWireFor } from "../../src/images/video-wire";
import type { AdapterEvent, OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const KEY = "synthetic-openai-wire-bridge-key";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 5, 6, 7, 8]);
const parsed = (): OcxParsedRequest => ({ modelId: "m", stream: true, options: {}, context: { messages: [], tools: [] } }) as unknown as OcxParsedRequest;
const routed = { baseUrl: "https://api.anthropic.com", authMode: "key", apiKey: "routed" } as OcxProviderConfig;

function config(row: Partial<OcxProviderConfig>, extra: Record<string, OcxProviderConfig> = {}): OcxConfig {
  return {
    providers: { aistudio: { adapter: "openai-chat", authMode: "key", apiKey: KEY, ...row } as OcxProviderConfig, ...extra },
    images: { videoBridgeEnabled: true, videoProvider: "aistudio", videoBridgeModel: "gemini-omni-1.1-flash" },
  } as unknown as OcxConfig;
}

describe("plan", () => {
  test("a row with videoApi openai carries that wire; a row without it keeps the xAI wire", async () => {
    const openai = await planVideoBridge(config({ baseUrl: "https://v.example/v1", videoApi: "openai" }), parsed(), routed);
    expect(openai?.auth?.videoApi).toBe("openai");
    expect(videoWireFor(openai!.auth!).requireUrl).toBe(false);
    const xaiWire = await planVideoBridge(config({ baseUrl: "https://v.example/v1" }), parsed(), routed);
    expect(xaiWire?.auth?.videoApi).toBeUndefined();
    expect(videoWireFor(xaiWire!.auth!).requireUrl).toBe(true);
  });

  test("the pinned xai destination stays on the xAI wire whatever its row says", async () => {
    const cfg = config({ baseUrl: "https://v.example/v1" }, {
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "key", apiKey: "xai-synthetic", videoApi: "openai" } as OcxProviderConfig,
    });
    (cfg.images as { videoProvider: string }).videoProvider = "xai";
    const plan = await planVideoBridge(cfg, parsed(), routed);
    expect(plan?.auth?.providerName).toBe("xai");
    expect(plan?.auth?.videoApi).toBeUndefined();
  });
});

describe("pollVideoWithHeartbeats", () => {
  const auth = { baseUrl: "https://v.example/v1", token: "t", providerName: "p" };
  const done = async () => ({ status: "done" as const });
  test("a content-delivered wire finishes without a URL; the xAI wire still requires one", async () => {
    const content = pollVideoWithHeartbeats("id", auth, new AbortController().signal, 1000, async () => {}, done, false);
    expect((await content.next()).value).toEqual({ ok: true });
    const url = pollVideoWithHeartbeats("id", auth, new AbortController().signal, 1000, async () => {}, done);
    expect((await url.next()).value).toEqual({ ok: false, error: "video generation completed but no video URL was returned" });
  });
});

describe("video_gen on the OpenAI wire", () => {
  type Seen = { method: string; path: string; authorization: string | null; body?: unknown };
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let home = "";
  const previousHome = process.env.OPENCODEX_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-openai-wire-bridge-"));
    process.env.OPENCODEX_HOME = home;
  });
  afterEach(async () => {
    await upstream?.stop(true);
    upstream = undefined;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (home) removeTreeWithRetry(home);
  });

  test("submits POST /videos, polls /videos/{id}, downloads /content with the row key, and returns the artifact", async () => {
    const seen: Seen[] = [];
    upstream = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const entry: Seen = { method: req.method, path, authorization: req.headers.get("authorization") };
        if (req.method === "POST") entry.body = await req.json();
        seen.push(entry);
        if (req.method === "POST" && path === "/v1/videos") return Response.json({ id: "video_abc", object: "video", status: "queued" });
        if (path === "/v1/videos/video_abc") return Response.json({ id: "video_abc", status: "completed", progress: 100 });
        if (path === "/v1/videos/video_abc/content") return new Response(MP4, { headers: { "content-type": "video/mp4" } });
        return new Response("not found", { status: 404 });
      },
    });
    const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
    const plan = await planVideoBridge(config({ baseUrl, videoApi: "openai", allowPrivateNetwork: true, noProxy: "127.0.0.1" }), parsed(), routed);
    expect(plan?.auth?.videoApi).toBe("openai");

    const requests: OcxParsedRequest[] = [];
    let iteration = 0;
    const adapter: ProviderAdapter = {
      name: "openai-wire-fixture",
      buildRequest: async () => ({ url: "https://example.invalid/model", method: "POST", headers: {}, body: "{}" }),
      fetchResponse: async () => new Response(""),
      parseStream: async function* (): AsyncGenerator<AdapterEvent> { /* runTurn only */ },
      runTurn: async (request, _incoming, emit) => {
        requests.push(request);
        if (iteration++ === 0) {
          emit({ type: "tool_call_start", id: "v1", name: "video_gen" });
          emit({ type: "tool_call_delta", arguments: '{"prompt":"a wave","duration":4,"resolution":"720p","aspect_ratio":"16:9"}' });
          emit({ type: "tool_call_end" });
        } else {
          emit({ type: "text_delta", text: "done" });
        }
        emit({ type: "done" });
      },
    };
    const response = await runWithImageBridge({
      parsed: parsed(), adapter, videoPlan: plan,
      incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    });
    expect(await response.text()).toContain("event: response.completed");

    expect(seen).toEqual([
      { method: "POST", path: "/v1/videos", authorization: "Bearer " + KEY, body: { prompt: "a wave", model: "gemini-omni-1.1-flash", seconds: "4", size: "1280x720" } },
      { method: "GET", path: "/v1/videos/video_abc", authorization: "Bearer " + KEY },
      { method: "GET", path: "/v1/videos/video_abc/content", authorization: "Bearer " + KEY },
    ]);
    const toolResult = requests[1]!.context.messages.find(message => message.role === "toolResult");
    const result = JSON.parse((toolResult as { content: string }).content) as { ok: boolean; path: string };
    expect(result.ok).toBe(true);
    expect(result.path.startsWith(join(home, "artifacts"))).toBe(true);
    expect(new Uint8Array(readFileSync(result.path))).toEqual(MP4);
  });
});
