import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ImageBridgePlan } from "../../src/images/types";

const PREV_HOME = process.env.OPENCODEX_HOME;
beforeAll(() => { process.env.OPENCODEX_HOME = join(tmpdir(), "ocx-test-" + randomUUID()); });
afterAll(() => { if (PREV_HOME === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = PREV_HOME; });

// --- Mutable mock state (reset() restores defaults before each test) ---
let xaiResult: { images: Array<{ b64_json?: string; url?: string }> } = { images: [{ b64_json: "dGVzdA==" }] };
let xaiError: Error | null = null;
let matIdx = 0;
let dlIdx = 0;
let materializeFn: (i: number) => Promise<string> = async (i) => `/test/img-${i}.png`;
let downloadFn: (i: number) => Promise<string> = async (i) => `/test/dl-${i}.png`;

mock.module("../../src/images/xai-client", () => ({
  callXaiImages: async () => { if (xaiError) throw xaiError; return xaiResult; },
}));
mock.module("../../src/images/artifacts", () => ({
  createImageBudget: () => ({ spent: 0 }),
  materializeInlineImage: async () => materializeFn(matIdx++),
  downloadImageToArtifact: async () => downloadFn(dlIdx++),
}));

const { fulfillImageCall } = await import("../../src/images/fulfill");

const plan = {
  provider: {} as never,
  auth: { baseUrl: "https://api.x.ai", token: "test-token" },
  model: "grok-imagine-image-quality",
  toolNames: new Set(["image_gen"]),
} as ImageBridgePlan;

function reset(): void {
  xaiResult = { images: [{ b64_json: "dGVzdA==" }] };
  xaiError = null;
  matIdx = 0;
  dlIdx = 0;
  materializeFn = async (i) => `/test/img-${i}.png`;
  downloadFn = async (i) => `/test/dl-${i}.png`;
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
    materializeFn = async (i) => { if (i === 1) throw new Error("partial fail"); return `/test/img-${i}.png`; };
    const r = await fulfillImageCall({ id: "c1", name: "image_gen", arguments: `{"prompt":"x"}` }, plan, { spent: 0 });
    expect(r.ok).toBe(true);
    expect(r.files.length).toBe(1);
  });
});
