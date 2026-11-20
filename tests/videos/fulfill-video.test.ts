import { describe, expect, test } from "bun:test";
import { parseVideoCallArgs, pollVideoWithHeartbeats, buildVideoResult } from "../../src/images/fulfill-video";
import type { PollVideoJobFn } from "../../src/images/fulfill-video";

const auth = { baseUrl: "https://api.x.ai/v1", token: "t" };
const noopSleep = async (): Promise<void> => {};

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
  async function drain(
    pollFn: PollVideoJobFn,
    timeoutMs = 60_000,
  ): Promise<{ heartbeats: string[]; result: { ok: true; videoUrl: string } | { ok: false; error: string } }> {
    const ac = new AbortController();
    const gen = pollVideoWithHeartbeats("r1", auth, ac.signal, timeoutMs, noopSleep, pollFn);
    const heartbeats: string[] = [];
    for (;;) {
      const { value, done } = await gen.next();
      if (done) return { heartbeats, result: value };
      heartbeats.push(value.message);
    }
  }

  test("returns done on first poll", async () => {
    const { result } = await drain(async () => ({
      status: "done",
      videoUrl: "https://cdn.x.ai/v.mp4",
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.videoUrl).toBe("https://cdn.x.ai/v.mp4");
  });

  test("yields at least one heartbeat before returning", async () => {
    let callCount = 0;
    const { heartbeats, result } = await drain(async () => {
      callCount++;
      return callCount >= 2
        ? { status: "done" as const, videoUrl: "https://x.ai/v.mp4" }
        : { status: "processing" as const };
    });
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(true);
  });

  test("returns failed status", async () => {
    const { result } = await drain(async () => ({ status: "failed" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("video generation failed");
  });

  test("returns timeout error when timeoutMs exceeded", async () => {
    const { result } = await drain(async () => ({ status: "processing" }), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("timed out");
  });

  test("returns error when done but no videoUrl", async () => {
    const { result } = await drain(async () => ({ status: "done" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no video URL");
  });

  test("stops retrying on permanent 4xx poll error", async () => {
    let pollCount = 0;
    const { result } = await drain(async () => {
      pollCount++;
      const err = new Error("xAI videos poll API returned 401") as Error & { status: number };
      err.status = 401;
      throw err;
    });
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


test("model-specific frames, resolutions and limits are validated", () => {
  const parse = (v: object, model = "grok-imagine-video-1.5") => parseVideoCallArgs(JSON.stringify(v), model);
  expect(parse({ image: "https://example.com/a", resolution: "1080p", aspect_ratio: "21:9" })).toMatchObject({ ok: true, resolution: "1080p", aspectRatio: "21:9" });
  expect(parse({ prompt: "p", resolution: "1080p" }, "grok-imagine-video-1.5-lite")).toMatchObject({ ok: true, resolution: "1080p" });
  expect(parse({ prompt: "p", resolution: "1080p" }, "grok-imagine-video")).not.toHaveProperty("resolution");
  expect(parse({ prompt: "p", last_frame: "https://example.com/a" }, "grok-imagine-video-1.5-lite")).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", keyframes: Array(5).fill({ image: "https://example.com/a", timestamp_s: 1 }) })).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", reference_images: ["https://example.com/a"], resolution: "1080p" })).toMatchObject({ ok: false, error: "reference_images are limited to 720p" });
});

test("failed polling reports safe code and detail", async () => {
  const generator = pollVideoWithHeartbeats("r", auth, new AbortController().signal, 1000, noopSleep, async () => ({ status: "failed", error: { code: "invalid_argument", message: "`last_frame` is not supported for this model." } }));
  expect((await generator.next()).value).toEqual({ ok: false, error: "video generation failed: invalid_argument: `last_frame` is not supported for this model." });
});
