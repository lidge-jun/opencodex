import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenAiVideo,
  downloadOpenAiVideoToArtifact,
  fetchOpenAiVideoContent,
  openAiVideoSize,
  pollOpenAiVideoJob,
  submitOpenAiVideoJob,
  VideoUpstreamError,
} from "../../src/images/openai-video-client";
import type { VideoOutboundDependencies, VideoProviderAuth } from "../../src/images/xai-video-client";
import { resolvePublicAddresses } from "../../src/lib/destination-policy";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// OpenAI Videos wire (#9110). Every case runs on a fake resolver and a fake pinned transport; a raw
// fetch is trapped so a request that skipped the outbound policy fails the test.
const HOST = "videos.relay.example";
const KEY = "synthetic-openai-video-key";
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3, 4]);

type Sent = { method: "GET" | "POST"; url: string; address: string; authorization: string | null; body?: unknown };

function dns(address: string): NonNullable<VideoOutboundDependencies["resolveAddresses"]> {
  return async (url, options) => {
    const target = new URL(url);
    if (target.hostname !== HOST) throw new Error("unexpected DNS lookup for " + target.hostname);
    target.hostname = address;
    return { ...(await resolvePublicAddresses(target.toString(), options)), hostname: HOST };
  };
}

function transport(sent: Sent[], answer: (sent: Sent) => Response): Pick<VideoOutboundDependencies, "pinnedGet" | "pinnedPost"> {
  return {
    pinnedPost: async (url, pinned, body, _signal, options) => {
      const entry: Sent = { method: "POST", url, address: pinned.address, authorization: new Headers(options?.headers).get("authorization"), body: JSON.parse(body) };
      sent.push(entry);
      return answer(entry);
    },
    pinnedGet: async (url, pinned, _signal, options) => {
      const entry: Sent = { method: "GET", url, address: pinned.address, authorization: new Headers(options?.headers).get("authorization") };
      sent.push(entry);
      return answer(entry);
    },
  };
}

const realFetch = globalThis.fetch;
let rawFetches: string[] = [];
let home = "";
const previousHome = process.env.OPENCODEX_HOME;
beforeEach(() => {
  rawFetches = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    rawFetches.push(String(input instanceof Request ? input.url : input));
    return Response.json({ id: "leaked", status: "completed" });
  }) as typeof fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-openai-video-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

const auth = (overrides: Partial<VideoProviderAuth> = {}): VideoProviderAuth => ({
  baseUrl: "https://" + HOST + "/v1", token: KEY, providerName: "aistudio", noProxy: HOST, videoApi: "openai", ...overrides,
});
const publicDeps = (sent: Sent[], answer: (sent: Sent) => Response) => ({ resolveAddresses: dns("93.184.216.34"), ...transport(sent, answer) });

describe("OpenAI Videos submit", () => {
  test("posts {baseUrl}/videos with the row key and maps bridge arguments onto the OpenAI fields", async () => {
    const sent: Sent[] = [];
    const result = await submitOpenAiVideoJob(
      { prompt: "a fox", model: "gemini-omni-1.1-flash", duration: 8, resolution: "720p", aspectRatio: "9:16", image: "https://img.example/a.png" },
      auth(), undefined, publicDeps(sent, () => Response.json({ id: "video_123", object: "video", status: "queued" })),
    );
    expect(result).toEqual({ requestId: "video_123" });
    expect(sent).toEqual([{
      method: "POST", url: "https://" + HOST + "/v1/videos", address: "93.184.216.34", authorization: "Bearer " + KEY,
      body: { prompt: "a fox", model: "gemini-omni-1.1-flash", seconds: "8", size: "720x1280", input_reference: { image_url: "https://img.example/a.png" } },
    }]);
    expect(rawFetches).toEqual([]);
  });

  test("refuses frame pins and references before anything is sent", async () => {
    const sent: Sent[] = [];
    for (const extra of [{ lastFrame: "https://a.example/1.png" }, { keyframes: [{ image: "https://a.example/2.png", timestampS: 1 }] }, { referenceImages: ["https://a.example/3.png"] }]) {
      await expect(submitOpenAiVideoJob({ prompt: "p", ...extra }, auth(), undefined, publicDeps(sent, () => Response.json({ id: "x" }))))
        .rejects.toThrow("not supported by the OpenAI Videos API");
    }
    expect(sent).toEqual([]);
  });

  test("a non-2xx create keeps its status and an unusable id is refused", async () => {
    const sent: Sent[] = [];
    const error = await createOpenAiVideo({ prompt: "p" }, auth(), undefined, publicDeps(sent, () => Response.json({ error: { message: "nope" } }, { status: 429 })))
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(VideoUpstreamError);
    expect((error as VideoUpstreamError).status).toBe(429);
    await expect(createOpenAiVideo({ prompt: "p" }, auth(), undefined, publicDeps(sent, () => Response.json({ id: ".." }))))
      .rejects.toThrow("usable video id");
  });

  test("size covers the bridge resolutions and keeps the upstream default when nothing was asked", () => {
    expect(openAiVideoSize(undefined, undefined)).toBeUndefined();
    expect(openAiVideoSize("720p", "16:9")).toBe("1280x720");
    expect(openAiVideoSize("1080p", "9:16")).toBe("1080x1920");
    expect(openAiVideoSize("480p", undefined)).toBe("854x480");
    expect(openAiVideoSize(undefined, "1:1")).toBe("720x720");
  });
});

describe("OpenAI Videos poll", () => {
  test("maps queued, in_progress, completed and failed; a finished job carries no URL", async () => {
    const statuses: Record<string, string> = { queued: "processing", in_progress: "processing", completed: "done", failed: "failed" };
    for (const [upstream, expected] of Object.entries(statuses)) {
      const sent: Sent[] = [];
      const poll = await pollOpenAiVideoJob("video_123", auth(), undefined, publicDeps(sent, () => Response.json({
        id: "video_123", status: upstream, progress: 40,
        ...(upstream === "failed" ? { error: { code: "internal_error", message: "arbitrary upstream text" } } : {}),
      })));
      expect(poll.status).toBe(expected as typeof poll.status);
      expect(poll.videoUrl).toBeUndefined();
      expect(sent[0]).toMatchObject({ method: "GET", url: "https://" + HOST + "/v1/videos/video_123", authorization: "Bearer " + KEY });
      if (upstream === "failed") expect(poll.error).toEqual({ code: "internal_error", message: undefined });
    }
  });

  test("a job id that would collapse onto another path is refused before any send", async () => {
    const sent: Sent[] = [];
    await expect(pollOpenAiVideoJob("..", auth(), undefined, publicDeps(sent, () => Response.json({})))).rejects.toThrow("not usable");
    expect(sent).toEqual([]);
  });
});

describe("OpenAI Videos content", () => {
  test("downloads /content from the same destination with the same key into a 0600 artifact", async () => {
    const sent: Sent[] = [];
    const path = await downloadOpenAiVideoToArtifact("video_123", auth(), undefined, undefined,
      publicDeps(sent, () => new Response(MP4, { headers: { "content-type": "video/mp4" } })));
    expect(sent).toEqual([{ method: "GET", url: "https://" + HOST + "/v1/videos/video_123/content", address: "93.184.216.34", authorization: "Bearer " + KEY }]);
    expect(path.startsWith(join(home, "artifacts"))).toBe(true);
    expect(path.endsWith(".mp4")).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(MP4);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a redirect is not followed and fails closed", async () => {
    const sent: Sent[] = [];
    const error = await fetchOpenAiVideoContent("video_123", auth(), {}, publicDeps(sent, () => new Response(null, { status: 302, headers: { location: "https://cdn.other.example/v.mp4" } })))
      .then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(VideoUpstreamError);
    expect((error as VideoUpstreamError).status).toBe(302);
    expect(sent).toHaveLength(1);
    expect(rawFetches).toEqual([]);
  });

  test("an unknown variant is refused before any send", async () => {
    const sent: Sent[] = [];
    await expect(fetchOpenAiVideoContent("video_123", auth(), { variant: "../../x" }, publicDeps(sent, () => new Response(MP4)))).rejects.toThrow("variant");
    expect(sent).toEqual([]);
  });

  for (const phase of ["submit", "poll", "content"] as const) {
    const call = (a: VideoProviderAuth, deps: VideoOutboundDependencies) => phase === "submit"
      ? submitOpenAiVideoJob({ prompt: "p" }, a, undefined, deps)
      : phase === "poll" ? pollOpenAiVideoJob("video_1", a, undefined, deps) : fetchOpenAiVideoContent("video_1", a, {}, deps);

    test(phase + ": the issue's loopback http row reaches 127.0.0.1 with its own allowPrivateNetwork", async () => {
      const sent: Sent[] = [];
      const loopback = auth({ baseUrl: "http://127.0.0.1:2048/v1", allowPrivateNetwork: true, noProxy: "127.0.0.1" });
      await call(loopback, {
        resolveAddresses: (url, options) => resolvePublicAddresses(url, options),
        ...transport(sent, () => phase === "content" ? new Response(MP4) : Response.json({ id: "video_1", status: "queued" })),
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ address: "127.0.0.1", authorization: "Bearer " + KEY });
      expect(sent[0]!.url.startsWith("http://127.0.0.1:2048/v1/videos")).toBe(true);
      expect(rawFetches).toEqual([]);
    });

    test(phase + ": a hostname resolving to loopback never receives the key without allowPrivateNetwork", async () => {
      const sent: Sent[] = [];
      const error = await call(auth(), { resolveAddresses: dns("127.0.0.1"), ...transport(sent, () => Response.json({ id: "video_1", status: "queued" })) })
        .then(() => undefined, (caught: unknown) => caught);
      expect((error as Error).message).toContain("loopback");
      expect(sent).toEqual([]);
      expect(rawFetches).toEqual([]);
    });

    test(phase + ": cleartext to a public address is refused even with allowPrivateNetwork", async () => {
      const sent: Sent[] = [];
      const error = await call(auth({ baseUrl: "http://" + HOST + "/v1", allowPrivateNetwork: true }), publicDeps(sent, () => Response.json({ id: "video_1" })))
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(sent).toEqual([]);
      expect(rawFetches).toEqual([]);
    });
  }
});
