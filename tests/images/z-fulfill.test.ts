import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ImageBridgePlan } from "../../src/images/types";
import type { XaiImageRequest } from "../../src/images/xai-client";

const PREV_HOME = process.env.OPENCODEX_HOME;
let fulfillImageCall: typeof import("../../src/images/fulfill")["fulfillImageCall"];
let imageFulfillmentTailSnapshot: typeof import("../../src/images/fulfill")["imageFulfillmentTailSnapshot"];
let testHome = "";

beforeAll(async () => {
  testHome = join(tmpdir(), "ocx-test-" + randomUUID());
  process.env.OPENCODEX_HOME = testHome;
  mock.restore();
  mock.module("../../src/images/xai-client", () => ({
    callXaiImages: async (req: XaiImageRequest, _auth: unknown, _signal?: AbortSignal, timeoutMs?: number) => {
      xaiCalls.push(req);
      capturedTimeoutMs = timeoutMs;
      if (xaiError) throw xaiError;
      return xaiResult;
    },
    resolveXaiAspectRatioLiteral: (value: unknown) => {
      if (typeof value !== "string") return undefined;
      const literal = value.trim();
      if (!literal || literal === "auto") return undefined;
      return new Set(["1:1", "16:9", "9:16", "4:3", "3:4"]).has(literal) ? literal : undefined;
    },
  }));
  mock.module("../../src/images/artifacts", () => ({
    createImageBudget: () => ({ spent: 0 }),
    materializeInlineImage: async () => materializeFn(matIdx++),
    downloadImageToArtifact: async () => downloadFn(dlIdx++),
    pruneArtifacts: () => pruneImpl(),
  }));
  ({ fulfillImageCall, imageFulfillmentTailSnapshot } = await import(`../../src/images/fulfill?fulfill=${Date.now()}`));
});
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; mock.restore(); });

// --- Mutable mock state (reset() restores defaults before each test) ---
let xaiResult: { images: Array<{ b64_json?: string; url?: string }> } = { images: [{ b64_json: "dGVzdA==" }] };
let xaiError: Error | null = null;
const xaiCalls: XaiImageRequest[] = [];
let matIdx = 0;
let dlIdx = 0;
let pruneCalls = 0;
let pruneImpl: () => void = () => { pruneCalls++; };
let materializeFn: (i: number) => Promise<string> = async (i) => touchArtifact(`img-${i}.png`);
let downloadFn: (i: number) => Promise<string> = async (i) => touchArtifact(`dl-${i}.png`);

let capturedTimeoutMs: number | undefined;

function touchArtifact(name: string): string {
  const dir = join(testHome || process.env.OPENCODEX_HOME!, "artifacts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "x");
  return path;
}

const plan = {
  provider: {} as never,
  auth: { baseUrl: "https://api.x.ai", token: "test-token" },
  model: "grok-imagine-image-quality",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function reset(): void {
  xaiResult = { images: [{ b64_json: "dGVzdA==" }] };
  xaiError = null;
  xaiCalls.length = 0;
  capturedTimeoutMs = undefined;
  matIdx = 0;
  dlIdx = 0;
  pruneCalls = 0;
  pruneImpl = () => { pruneCalls++; };
  materializeFn = async (i) => touchArtifact(`img-${i}.png`);
  downloadFn = async (i) => touchArtifact(`dl-${i}.png`);
}

describe("fulfillImageCall", () => {
  test("valid args → ok:true with file", async () => {
    reset();
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", n: 2 }) },
      plan, { spent: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.files.length).toBe(1);
  });

  test("plan.timeoutMs is forwarded to callXaiImages", async () => {
    reset();
    const timedPlan = { ...plan, timeoutMs: 12_345 } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      timedPlan, { spent: 0 },
    );
    expect(capturedTimeoutMs).toBe(12_345);
  });

  test("missing prompt → ok:false 'missing prompt'", async () => {
    reset();
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: "{}" }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing prompt");
  });

  test("invalid JSON args → ok:false 'invalid arguments JSON'", async () => {
    reset();
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: "{bad" }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid arguments JSON");
  });

  test("xAI throws → ok:false with error message", async () => {
    reset();
    xaiError = new Error("xAI images API returned 500");
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x" }) }, plan, { spent: 0 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("500");
  });

  test("b64_json result → materialized via materializeInlineImage", async () => {
    reset();
    xaiResult = { images: [{ b64_json: "dGVzdA==" }] };
    await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(matIdx).toBe(1);
    expect(dlIdx).toBe(0);
  });

  test("URL result → materialized via downloadImageToArtifact", async () => {
    reset();
    xaiResult = { images: [{ url: "https://cdn.example.com/i.png" }] };
    await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(dlIdx).toBe(1);
    expect(matIdx).toBe(0);
  });

  test("all images fail → ok:false", async () => {
    reset();
    materializeFn = async () => { throw new Error("disk full"); };
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no usable images");
  });

  test("one of two images fails → ok:true with 1 file", async () => {
    reset();
    xaiResult = { images: [{ b64_json: "AAA=" }, { b64_json: "QkI=" }] };
    materializeFn = async (i) => { if (i === 1) throw new Error("partial fail"); return touchArtifact(`img-${i}.png`); };
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(r.ok).toBe(true);
    expect(r.files.length).toBe(1);
  });

  test("prunes once after the full batch and omits deleted paths", async () => {
    reset();
    const { unlinkSync } = await import("node:fs");
    xaiResult = { images: [{ b64_json: "AAA=" }, { b64_json: "QkI=" }] };
    const written: string[] = [];
    materializeFn = async (i) => {
      const path = touchArtifact(`batch-${i}.png`);
      written.push(path);
      return path;
    };
    pruneImpl = () => {
      pruneCalls++;
      unlinkSync(written[0]!);
    };
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` },
      { ...plan, artifactsKeepCount: 1 } as ImageBridgePlan,
      { spent: 0 },
    );
    expect(pruneCalls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([written[1]]);
    expect(r.path).toBe(written[1]);
  });

  test("forwards prompt, model, and n to callXaiImages", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", n: 2 }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls.length).toBe(1);
    expect(xaiCalls[0]!.prompt).toBe("a cat");
    expect(xaiCalls[0]!.model).toBe(plan.model);
    expect(xaiCalls[0]!.n).toBe(2);
  });

  test("clamps n > 4 down to 4", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", n: 100 }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls[0]!.n).toBe(4);
  });

  test("forwards an aspect_ratio literal to callXaiImages", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", aspect_ratio: "16:9", size: "1024x1024" }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls[0]!.aspectRatio).toBe("16:9");
  });

  test("forwards auto verbatim so the client can suppress the size-derived ratio", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", aspect_ratio: "auto", size: "1792x1024" }) },
      plan, { spent: 0 },
    );
    // Folding "auto" to undefined here would make the request indistinguishable from
    // one that never carried the field, and callXaiImages would derive 16:9 from size.
    expect(xaiCalls[0]!.aspectRatio).toBe("auto");
  });

  test("an illegal literal is still forwarded for the client to reject", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", aspect_ratio: "2:1" }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls[0]!.aspectRatio).toBe("2:1");
  });

  test("a non-string aspect_ratio is dropped before the client sees it", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", aspect_ratio: 169 }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls[0]!.aspectRatio).toBeUndefined();
  });

  test("forwards imageUrl from image_url arg", async () => {
    reset();
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "x", image_url: "https://example.com/i.png" }) },
      plan, { spent: 0 },
    );
    expect(xaiCalls[0]!.imageUrl).toBe("https://example.com/i.png");
  });

  test("plan.defaultSize and defaultQuality fill omitted args", async () => {
    reset();
    const sizedPlan = {
      ...plan,
      defaultSize: "1024x1024",
      defaultQuality: "hd",
    } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      sizedPlan, { spent: 0 },
    );
    expect(xaiCalls[0]!.size).toBe("1024x1024");
    expect(xaiCalls[0]!.quality).toBe("hd");
  });

  test("explicit size/quality override plan defaults", async () => {
    reset();
    const sizedPlan = {
      ...plan,
      defaultSize: "1024x1024",
      defaultQuality: "hd",
    } as ImageBridgePlan;
    await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat", size: "512x512", quality: "standard" }) },
      sizedPlan, { spent: 0 },
    );
    expect(xaiCalls[0]!.size).toBe("512x512");
    expect(xaiCalls[0]!.quality).toBe("standard");
  });

  test("markdown uses a file: URI for Windows-safe destinations", async () => {
    reset();
    const r = await fulfillImageCall(
      { id: "c1", name: "image_gen", arguments: JSON.stringify({ prompt: "a cat" }) },
      plan, { spent: 0 },
    );
    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    expect(r.markdown).toMatch(/^!\[image\]\(file:\/\//);
    expect(r.files[0]).toBe(r.path);
    expect(r.markdown).not.toContain("\\");
  });

  test("image fulfillment 65 returns busy before provider or artifact work and reports path bytes", async () => {
    reset();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    materializeFn = async (i) => {
      await gate;
      return touchArtifact(`bounded-${i}.png`);
    };
    const calls = Array.from({ length: 64 }, (_, index) => fulfillImageCall(
      { id: `call-${index}`, name: "image_gen", arguments: JSON.stringify({ prompt: `image-${index}` }) },
      plan,
      { spent: 0 },
    ));
    while (xaiCalls.length < 64) await Bun.sleep(1);
    const snapshot = imageFulfillmentTailSnapshot();
    expect(snapshot.active).toBe(64);
    expect(snapshot.currentBytes).toBeGreaterThan(0);
    const busy = await fulfillImageCall(
      { id: "call-65", name: "image_gen", arguments: JSON.stringify({ prompt: "must-not-run" }) },
      plan,
      { spent: 0 },
    );
    expect(busy.error).toBe("image_fulfillment_busy");
    expect(xaiCalls.length).toBe(64);
    release();
    await Promise.all(calls);
    expect(imageFulfillmentTailSnapshot().active).toBe(0);
  });
});
