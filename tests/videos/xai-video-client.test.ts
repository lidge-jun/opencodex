import { describe, expect, test } from "bun:test";
import { submitVideoJob, pollVideoJob, type VideoOutboundDependencies, type VideoProviderAuth } from "../../src/images/xai-video-client";

const auth: VideoProviderAuth = { baseUrl: "https://api.x.ai/v1", token: "test-key", providerName: "xai", noProxy: "api.x.ai" };

type Captured = { method: "GET" | "POST"; url: string; body?: string; headers: Headers };

/** Public DNS answer for api.x.ai plus a pinned transport that answers with `body` and records the request. */
function xai(body: unknown, status = 200, captured: Captured[] = []): VideoOutboundDependencies {
  const answer = () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  return {
    resolveAddresses: async () => ({ hostname: "api.x.ai", addresses: [{ address: "104.18.1.1", family: 4 }], privateNetwork: false }),
    pinnedPost: async (url, _pinned, requestBody, _signal, options) => {
      captured.push({ method: "POST", url, body: requestBody, headers: new Headers(options?.headers) });
      return answer();
    },
    pinnedGet: async (url, _pinned, _signal, options) => {
      captured.push({ method: "GET", url, headers: new Headers(options?.headers) });
      return answer();
    },
  };
}

for (const phase of ["submit", "poll"] as const) test.each([307, 308])(`video ${phase} never follows %i`, async status => {
  let targetHits = 0;
  let originHits = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    targetHits++;
    return Response.json({ request_id: "redirected", status: "done" });
  } });
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    originHits++;
    return new Response("redirect", { status, headers: { location: `http://127.0.0.1:${target.port}/target` } });
  } });
  try {
    // A self-hosted http relay on a local address literal, admitted only through the row's opt-in.
    const scopedAuth: VideoProviderAuth = {
      baseUrl: `http://127.0.0.1:${origin.port}`, token: "synthetic-video-token",
      providerName: "local-video-relay", allowPrivateNetwork: true, noProxy: "127.0.0.1",
    };
    const result = phase === "submit" ? submitVideoJob({ prompt: "synthetic prompt" }, scopedAuth) : pollVideoJob("job", scopedAuth);
    const error = await result.catch(error => error as Error & { status: number });
    expect(targetHits).toBe(0);
    expect(originHits).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status });
  } finally {
    await origin.stop(true);
    await target.stop(true);
  }
});

describe("submitVideoJob", () => {
  test("returns request_id from response", async () => {
    const result = await submitVideoJob({ prompt: "a cat playing piano" }, auth, undefined, xai({ request_id: "vid-123" }));
    expect(result.requestId).toBe("vid-123");
  });

  test("accepts id field as fallback", async () => {
    const result = await submitVideoJob({ prompt: "sunset" }, auth, undefined, xai({ id: "vid-456" }));
    expect(result.requestId).toBe("vid-456");
  });

  test("sends correct POST body", async () => {
    const captured: Captured[] = [];
    await submitVideoJob(
      { prompt: "dance", model: "grok-imagine-video", duration: 5, resolution: "720p", aspectRatio: "16:9" },
      auth, undefined, xai({ request_id: "r1" }, 200, captured),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(captured[0]!.body!);
    expect(body.prompt).toBe("dance");
    expect(body.model).toBe("grok-imagine-video");
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBe("16:9");
  });

  test("throws on non-2xx response", async () => {
    await expect(submitVideoJob({ prompt: "test" }, auth, undefined, xai({ error: "rate limited" }, 429))).rejects.toThrow("429");
  });

  test("throws when request_id is missing", async () => {
    await expect(submitVideoJob({ prompt: "test" }, auth, undefined, xai({ foo: "bar" }))).rejects.toThrow("request_id");
  });
});

describe("pollVideoJob", () => {
  test("returns done status with video URL", async () => {
    const result = await pollVideoJob("vid-123", auth, undefined, xai({
      status: "done",
      video: { url: "https://cdn.x.ai/video.mp4" },
    }));
    expect(result.status).toBe("done");
    expect(result.videoUrl).toBe("https://cdn.x.ai/video.mp4");
  });

  test("normalizes completed → done", async () => {
    const result = await pollVideoJob("vid-123", auth, undefined, xai({ status: "completed" }));
    expect(result.status).toBe("done");
  });

  test("normalizes error → failed", async () => {
    const result = await pollVideoJob("vid-123", auth, undefined, xai({ state: "error" }));
    expect(result.status).toBe("failed");
  });

  test("returns processing for unknown status", async () => {
    const result = await pollVideoJob("vid-123", auth, undefined, xai({ status: "rendering" }));
    expect(result.status).toBe("processing");
  });

  test("throws on non-2xx response", async () => {
    await expect(pollVideoJob("vid-123", auth, undefined, xai({}, 401))).rejects.toThrow("401");
  });

  test("uses GET method on poll URL", async () => {
    const captured: Captured[] = [];
    await pollVideoJob("vid-789", auth, undefined, xai({ status: "processing" }, 200, captured));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.x.ai/v1/videos/vid-789");
    expect(captured[0]!.method).toBe("GET");
    expect(captured[0]!.headers.get("authorization")).toBe("Bearer test-key");
  });

  test("encodes requestId in poll URL", async () => {
    const captured: Captured[] = [];
    await pollVideoJob("req/with?special&chars", auth, undefined, xai({ status: "processing" }, 200, captured));
    const capturedUrl = captured[0]!.url;
    expect(capturedUrl).toContain(encodeURIComponent("req/with?special&chars"));
    // Must NOT contain the raw special chars in the path
    expect(capturedUrl).not.toMatch(/\/videos\/req\/with/);
  });
});
