import { describe, expect, test, mock, afterEach } from "bun:test";
import { submitVideoJob, pollVideoJob } from "../../src/images/xai-video-client";

const auth = { baseUrl: "https://api.x.ai/v1", token: "test-key" };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockFetchResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("submitVideoJob", () => {
  test("returns request_id from response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ request_id: "vid-123" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await submitVideoJob({ prompt: "a cat playing piano" }, auth);
    expect(result.requestId).toBe("vid-123");
  });

  test("accepts id field as fallback", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ id: "vid-456" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await submitVideoJob({ prompt: "sunset" }, auth);
    expect(result.requestId).toBe("vid-456");
  });

  test("sends correct POST body", async () => {
    let capturedBody: string | undefined;
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve(mockFetchResponse({ request_id: "r1" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await submitVideoJob(
      { prompt: "dance", model: "grok-imagine-video", duration: 5, resolution: "720p", aspectRatio: "16:9" },
      auth,
    );

    const body = JSON.parse(capturedBody!);
    expect(body.prompt).toBe("dance");
    expect(body.model).toBe("grok-imagine-video");
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe("720p");
    expect(body.aspect_ratio).toBe("16:9");
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ error: "rate limited" }, 429)));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(submitVideoJob({ prompt: "test" }, auth)).rejects.toThrow("429");
  });

  test("throws when request_id is missing", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ foo: "bar" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(submitVideoJob({ prompt: "test" }, auth)).rejects.toThrow("request_id");
  });
});

describe("pollVideoJob", () => {
  test("returns done status with video URL", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({
      status: "done",
      video: { url: "https://cdn.x.ai/video.mp4" },
    })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("done");
    expect(result.videoUrl).toBe("https://cdn.x.ai/video.mp4");
  });

  test("normalizes completed → done", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ status: "completed" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("done");
  });

  test("normalizes error → failed", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ state: "error" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("failed");
  });

  test("returns processing for unknown status", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({ status: "rendering" })));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pollVideoJob("vid-123", auth);
    expect(result.status).toBe("processing");
  });

  test("throws on non-2xx response", async () => {
    const fetchMock = mock(() => Promise.resolve(mockFetchResponse({}, 401)));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await expect(pollVideoJob("vid-123", auth)).rejects.toThrow("401");
  });

  test("uses GET method on poll URL", async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    const fetchMock = mock((url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init.method;
      return Promise.resolve(mockFetchResponse({ status: "processing" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await pollVideoJob("vid-789", auth);
    expect(capturedUrl).toContain("/videos/vid-789");
    expect(capturedMethod).toBe("GET");
  });

  test("encodes requestId in poll URL", async () => {
    let capturedUrl: string | undefined;
    const fetchMock = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(mockFetchResponse({ status: "processing" }));
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await pollVideoJob("req/with?special&chars", auth);
    expect(capturedUrl).toContain(encodeURIComponent("req/with?special&chars"));
    // Must NOT contain the raw special chars in the path
    expect(capturedUrl).not.toMatch(/\/videos\/req\/with/);
  });
});
