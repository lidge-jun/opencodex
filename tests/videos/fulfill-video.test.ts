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

  test("refuses a duration above 15 instead of clamping it", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 100 }));
    expect(result).toEqual({ ok: false, error: "duration must be a whole number of seconds from 1 to 15" });
  });

  test("refuses a duration below 1 instead of clamping it", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", duration: 0 }));
    expect(result).toEqual({ ok: false, error: "duration must be a whole number of seconds from 1 to 15" });
  });

  test("rejects invalid resolution", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", resolution: "1080p" }));
    expect(result).toEqual({ ok: false, error: "resolution 1080p is not supported by unknown" });
  });

  test("rejects invalid aspect_ratio", () => {
    const result = parseVideoCallArgs(JSON.stringify({ prompt: "test", aspect_ratio: "5:4" }));
    expect(result).toEqual({ ok: false, error: "aspect_ratio 5:4 is not supported by unknown" });
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
  expect(parse({ prompt: "p", resolution: "1080p", aspect_ratio: "21:9" })).toMatchObject({ ok: true, resolution: "1080p", aspectRatio: "21:9" });
  expect(parse({ image: "https://example.com/a", resolution: "1080p" })).toMatchObject({ ok: true, resolution: "1080p" });
  expect(parse({ prompt: "p", resolution: "1080p" }, "grok-imagine-video-1.5-lite")).toMatchObject({ ok: true, resolution: "1080p" });
  expect(parse({ prompt: "p", resolution: "1080p" }, "grok-imagine-video")).toEqual({ ok: false, error: "resolution 1080p is not supported by grok-imagine-video" });
  expect(parse({ prompt: "p", resolution: 1080 }, "grok-imagine-video")).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", aspect_ratio: "21:9" }, "custom-video")).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", last_frame: "https://example.com/a" }, "grok-imagine-video-1.5-lite")).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", keyframes: Array(5).fill({ image: "https://example.com/a", timestamp_s: 1 }) })).toMatchObject({ ok: false });
  expect(parse({ prompt: "p", reference_images: ["https://example.com/a"], resolution: "1080p" })).toMatchObject({ ok: false, error: "reference_images, last_frame and keyframes are limited to 720p" });
});

test("failed polling reports safe code and detail", async () => {
  const generator = pollVideoWithHeartbeats("r", auth, new AbortController().signal, 1000, noopSleep, async () => ({ status: "failed", error: { code: "invalid_argument", message: "`last_frame` is not supported for this model." } }));
  expect((await generator.next()).value).toEqual({ ok: false, error: "video generation failed: invalid_argument: `last_frame` is not supported for this model." });
});

test("an explicit duration outside 1-15 whole seconds is refused, never clamped or dropped", () => {
  for (const duration of [0, 16, 30, 2.5, "fifteen", null, true]) {
    expect(parseVideoCallArgs(JSON.stringify({ prompt: "p", duration }), "grok-imagine-video-1.5-lite")).toMatchObject({ ok: false });
  }
  expect(parseVideoCallArgs(JSON.stringify({ prompt: "p", duration: 15 }), "grok-imagine-video-1.5-lite")).toMatchObject({ ok: true, duration: 15 });
  expect(parseVideoCallArgs(JSON.stringify({ prompt: "p", duration: "8" }), "grok-imagine-video-1.5-lite")).toMatchObject({ ok: true, duration: 8 });
});

test("settings xAI cannot honour in the chosen mode are refused before a paid call", () => {
  const full = (v: object) => parseVideoCallArgs(JSON.stringify({ prompt: "p", ...v }), "grok-imagine-video-1.5");
  const img = "https://example.com/a.png";
  // Image-to-video keeps the image's aspect ratio, so an explicit one cannot be honoured.
  expect(full({ image: img, aspect_ratio: "16:9" })).toMatchObject({ ok: false });
  expect(full({ aspect_ratio: "16:9" })).toMatchObject({ ok: true, aspectRatio: "16:9" });
  expect(full({ image: img, reference_images: [img], aspect_ratio: "16:9" })).toMatchObject({ ok: true });
  // A keyframe must sit inside the effective clip: xAI's 8 s default when duration is omitted.
  expect(full({ keyframes: [{ image: img, timestamp_s: 7 }] })).toMatchObject({ ok: true });
  expect(full({ keyframes: [{ image: img, timestamp_s: 8 }] })).toMatchObject({ ok: false });
  expect(full({ keyframes: [{ image: img, timestamp_s: 9 }] })).toMatchObject({ ok: false });
  expect(full({ duration: 10, keyframes: [{ image: img, timestamp_s: 9 }] })).toMatchObject({ ok: true });
  // Pinned frames make it reference-to-video, which stops at 720p.
  expect(full({ last_frame: img, resolution: "1080p" })).toMatchObject({ ok: false });
  expect(full({ keyframes: [{ image: img, timestamp_s: 2 }], resolution: "1080p" })).toMatchObject({ ok: false });
  expect(full({ image: img, resolution: "1080p" })).toMatchObject({ ok: true, resolution: "1080p" });
  // The classic model takes a first frame or references, not both.
  const classic = (v: object) => parseVideoCallArgs(JSON.stringify({ prompt: "p", ...v }), "grok-imagine-video");
  expect(classic({ image: img })).toMatchObject({ ok: true });
  expect(classic({ reference_images: [img] })).toMatchObject({ ok: true });
  expect(classic({ image: img, reference_images: [img] })).toMatchObject({ ok: false });
  expect(full({ image: img, reference_images: [img] })).toMatchObject({ ok: true });
});

test("a permanent poll error keeps only the validated detail", async () => {
  const failWith = (detail?: string) => async () => { throw Object.assign(new Error("xAI videos poll API returned 400: secret prompt text"), { status: 400, ...(detail ? { detail } : {}) }); };
  const safe = pollVideoWithHeartbeats("r", auth, new AbortController().signal, 1000, noopSleep, failWith("1080p video resolution is not available for this model."));
  expect((await safe.next()).value).toEqual({ ok: false, error: "video poll failed permanently: HTTP 400: 1080p video resolution is not available for this model." });
  const bare = pollVideoWithHeartbeats("r", auth, new AbortController().signal, 1000, noopSleep, failWith());
  expect((await bare.next()).value).toEqual({ ok: false, error: "video poll failed permanently: HTTP 400" });
});
