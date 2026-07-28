import { describe, expect, test, mock, beforeEach } from "bun:test";
import { parseVideoCallArgs, pollVideoWithHeartbeats, buildVideoResult } from "../../src/images/fulfill-video";
import { pollVideoJob } from "../../src/images/xai-video-client";

describe("parseVideoCallArgs", () => {
  test("parses valid args", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "hello", duration: 5, resolution: "720p", aspect_ratio: "16:9" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prompt).toBe("hello");
      expect(result.duration).toBe(5);
      expect(result.resolution).toBe("720p");
      expect(result.aspectRatio).toBe("16:9");
    }
  });

  test("accepts input as alias for prompt", () => {
    const result = parseVideoCallArgs(JSON.stringify({ input: "world" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prompt).toBe("world");
  });

  test("fails on missing prompt", () => {
    const result = parseVideoCallArgs(JSON.stringify({ duration: 5 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("missing prompt");
  });

  test("fails on invalid JSON", () => {
    const result = parseVideoCallArgs("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid arguments JSON");
  });

  test("fails on null", () => {
    const result = parseVideoCallArgs("null");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid arguments JSON");
  });

  test("clamps duration to 1-15", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 100 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.duration).toBe(15);
  });

  test("clamps duration minimum to 1", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 0 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.duration).toBe(1);
  });

  test("rejects invalid resolution", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", resolution: "1080p" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution).toBeUndefined();
  });

  test("rejects invalid aspect_ratio", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", aspect_ratio: "5:4" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.aspectRatio).toBeUndefined();
  });
});

describe("pollVideoWithHeartbeats", () => {
  beforeEach(() => {
    mock.restore();
  });

  test("returns done on first poll", async () => {
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => Promise.resolve({
        status: "done" as const,
        videoUrl: "https://cdn.x.ai/v.mp4",
      })),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal);
    const heartbeats: string[] = [];
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
      heartbeats.push(value.message);
    }
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.videoUrl).toBe("https://cdn.x.ai/v.mp4");
  });

  test("yields at least one heartbeat before returning", async () => {
    let callCount = 0;
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => {
        callCount++;
        return Promise.resolve({
          status: callCount >= 2 ? "done" as const : "processing" as const,
          ...(callCount >= 2 ? { videoUrl: "https://x.ai/v.mp4" } : {}),
        });
      }),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal, 60_000);
    const heartbeats: string[] = [];
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
      heartbeats.push(value.message);
    }
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(true);
  }, 15_000); // 5s initial poll interval means ~10s for 2 polls

  test("returns failed status", async () => {
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => Promise.resolve({ status: "failed" as const })),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal);
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("video generation failed");
  });

  test("returns timeout error when timeoutMs exceeded", async () => {
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => Promise.resolve({ status: "processing" as const })),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal, 0);
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });

  test("returns error when done but no videoUrl", async () => {
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => Promise.resolve({ status: "done" as const })),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal);
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no video URL");
  });

  test("stops retrying on permanent 4xx poll error", async () => {
    let pollCount = 0;
    mock.module("../../src/images/xai-video-client", () => ({
      pollVideoJob: mock(() => {
        pollCount++;
        const err = new Error("xAI videos poll API returned 401") as Error & { status: number };
        err.status = 401;
        return Promise.reject(err);
      }),
    }));

    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", { baseUrl: "https://api.x.ai/v1", token: "t" }, ac.signal);
    let result;
    for (;;) {
      const { value, done } = await gen.next();
      if (done) { result = value; break; }
    }
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("permanently");
    expect(pollCount).toBe(1);
  });
});

describe("buildVideoResult", () => {
  test("builds success result", () => {
    const result = buildVideoResult("/tmp/vid-123.mp4", "dance", "grok-imagine-video");
    expect(result.ok).toBe(true);
    expect(result.path).toBe("/tmp/vid-123.mp4");
    expect(result.prompt).toBe("dance");
    expect(result.model).toBe("grok-imagine-video");
    expect(result.files).toEqual(["/tmp/vid-123.mp4"]);
    expect(result.count).toBe(1);
    expect(result.markdown).toContain("vid-123.mp4");
  });

  test("uses file:// URL in markdown", () => {
    const result = buildVideoResult("/tmp/vid-123.mp4", "dance", "grok-imagine-video");
    expect(result.markdown).toContain("file://");
  });
});
