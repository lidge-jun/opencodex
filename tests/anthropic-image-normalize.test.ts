import { beforeEach, describe, expect, test } from "bun:test";
import {
  normalizeAnthropicImages,
  getNormalizeStatsForTests,
  resetNormalizeStateForTests,
  TIER_SPECS,
  IMAGE_NORMALIZE_CONCURRENCY,
  normalizeImageTargets,
  type NormalizeTarget,
  type EncodeFn,
} from "../src/adapters/anthropic-image-normalize";
import {
  enforceAnthropicImageLimits,
  sniffImageDimensions,
  TOTAL_IMAGE_BASE64_BUDGET,
} from "../src/adapters/anthropic-image-guard";

/** 1x1 red PNG — the smallest real, fully-decodable fixture. */
const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Upscale the 1px PNG into a real decodable PNG of the given dimensions. */
async function realPngBase64(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return Buffer.from(buf).toString("base64");
}

function u32be(n: number): number[] { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }

/** Header-only PNG: sniffable dimensions, NOT fully decodable (no image data). */
function fakePngBase64(width: number, height: number, filler = 0): string {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), 0x49, 0x48, 0x44, 0x52,
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0,
  ];
  const buf = Buffer.alloc(Math.max(header.length, filler));
  Buffer.from(Uint8Array.from(header)).copy(buf);
  return buf.toString("base64");
}

function imageBlock(base64: string, mediaType = "image/png"): Record<string, unknown> {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
}

function userMsg(blocks: unknown[]): Record<string, unknown> {
  return { role: "user", content: blocks };
}

function contentOf(messages: unknown[]): Array<{ type: string; text?: string; source?: { type?: string; media_type?: string; data?: string } }> {
  return (messages[0] as { content: Array<{ type: string }> }).content as never;
}

/**
 * Injected encoder returning a SNIFFABLE payload of exact base64 length per position
 * (PNG header claiming in-tier dimensions + zero filler), so the downstream guard's
 * dimension rules treat seam output like real encoder output. Callers pass sizes that
 * are multiples of 4 (and /4*3 of them multiples of 3) for exact-length encoding.
 */
function sizedEncoder(sizeFor: (maxEdge: number) => number): EncodeFn {
  return (_input, spec) => {
    const b64len = sizeFor(spec.maxEdge);
    const decodedBytes = (b64len / 4) * 3;
    const edge = Math.min(spec.maxEdge, 500);
    return Promise.resolve({ data: fakePngBase64(edge, edge, decodedBytes), mediaType: "image/jpeg" });
  };
}

beforeEach(() => resetNormalizeStateForTests());

describe("normalizeAnthropicImages — real Bun.Image path", () => {
  test("N1: oversized-dimension PNG is resized under the tier-0 edge and 2MiB cap, not dropped", async () => {
    const big = await realPngBase64(4000, 3000);
    const messages = [userMsg([imageBlock(big)])];
    await normalizeAnthropicImages(messages);
    const [block] = contentOf(messages);
    expect(block.type).toBe("image");
    expect(block.source?.media_type).toBe("image/jpeg");
    const dims = sniffImageDimensions(block.source?.data ?? "");
    expect(dims).not.toBeNull();
    expect(Math.max(dims!.width, dims!.height)).toBeLessThanOrEqual(2000);
    expect((block.source?.data ?? "").length).toBeLessThanOrEqual(TIER_SPECS[0].hardCap);
  });

  test("N2: 30 images land on age tiers — newest pass through, older shrink to their tier edges", async () => {
    const src = await realPngBase64(1500, 1000);
    const messages = [userMsg(Array.from({ length: 30 }, () => imageBlock(src)))];
    await normalizeAnthropicImages(messages);
    const content = contentOf(messages);
    expect(content.every(b => b.type === "image")).toBe(true);
    // Wire order is oldest first: indices 0-9 are tier 2 (<=700px), 10-23 tier 1 (<=1024px), 24-29 tier 0 (pass-through PNG).
    for (let i = 0; i < 10; i++) {
      const d = sniffImageDimensions(content[i].source?.data ?? "");
      expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(700);
      expect(content[i].source?.media_type).toBe("image/jpeg");
    }
    for (let i = 10; i < 24; i++) {
      const d = sniffImageDimensions(content[i].source?.data ?? "");
      expect(Math.max(d!.width, d!.height)).toBeLessThanOrEqual(1024);
    }
    for (let i = 24; i < 30; i++) {
      expect(content[i].source?.media_type).toBe("image/png");
      expect(content[i].source?.data).toBe(src);
    }
  });

  test("N3: cache hit — same input re-normalized with ZERO additional encoder invocations and identical bytes", async () => {
    const big = await realPngBase64(4000, 3000);
    const first = [userMsg([imageBlock(big)])];
    await normalizeAnthropicImages(first);
    const callsAfterFirst = getNormalizeStatsForTests().encodeCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = [userMsg([imageBlock(big)])];
    await normalizeAnthropicImages(second);
    expect(getNormalizeStatsForTests().encodeCalls).toBe(callsAfterFirst);
    expect(contentOf(second)[0].source?.data).toBe(contentOf(first)[0].source?.data);
  });

  test("N6: undecodable garbage is textified with the undecodable note", async () => {
    const messages = [userMsg([imageBlock(Buffer.from("this is not an image at all").toString("base64"))])];
    await normalizeAnthropicImages(messages);
    const [block] = contentOf(messages);
    expect(block.type).toBe("text");
    expect(block.text).toContain("undecodable");
  });

  test("N6b: sniffable-but-truncated PNG is caught by pass-through validation and textified", async () => {
    // Real PNG cut short: header (dimensions) survives sniffing, pixel data is gone.
    const whole = Buffer.from(await realPngBase64(400, 300), "base64");
    const truncated = whole.subarray(0, Math.floor(whole.length / 2)).toString("base64");
    expect(sniffImageDimensions(truncated)).toEqual({ width: 400, height: 300 });
    const messages = [userMsg([imageBlock(truncated)])];
    await normalizeAnthropicImages(messages);
    const [block] = contentOf(messages);
    expect(block.type).toBe("text");
    expect(block.text).toContain("undecodable");
  });

  test("cache does not reuse a pass-through verdict across media types", async () => {
    const src = await realPngBase64(400, 300);
    const asPng = [userMsg([imageBlock(src, "image/png")])];
    await normalizeAnthropicImages(asPng);
    expect(contentOf(asPng)[0].source?.data).toBe(src); // pass-through
    const asOctet = [userMsg([imageBlock(src, "application/octet-stream")])];
    await normalizeAnthropicImages(asOctet);
    // Non-Anthropic media type must be transcoded, not ride the png pass verdict.
    expect(contentOf(asOctet)[0].source?.media_type).toBe("image/jpeg");
  });
});

describe("normalizeAnthropicImages — guards and seams", () => {
  test("N4: decode-bomb dimensions are textified without a decode attempt", async () => {
    const bomb = fakePngBase64(20000, 20000);
    const messages = [userMsg([imageBlock(bomb)])];
    await normalizeAnthropicImages(messages);
    const [block] = contentOf(messages);
    expect(block.type).toBe("text");
    expect(block.text).toContain("too large to process");
    expect(getNormalizeStatsForTests().encodeCalls).toBe(0);
  });

  test("N5: URL-source images are untouched", async () => {
    const messages = [userMsg([{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }])];
    const before = JSON.stringify(messages);
    await normalizeAnthropicImages(messages);
    expect(JSON.stringify(messages)).toBe(before);
  });

  test("N7: incompressible output walks the ladder to terminal and terminates (no hang, no drop)", async () => {
    // Encoder that never fits any hard cap: 3MiB at every position (tier-0 cap is 2MiB).
    const stubborn = sizedEncoder(() => 3 * 1024 * 1024);
    const messages = [userMsg([imageBlock(fakePngBase64(3000, 2000))])];
    await normalizeAnthropicImages(messages, { encode: stubborn });
    const [block] = contentOf(messages);
    expect(block.type).toBe("image");
    expect(block.source?.data?.length).toBe(3 * 1024 * 1024);
    // Walked every position from 0 to terminal exactly once per quality attempt.
    const expectedCalls = TIER_SPECS.reduce((n, s) => n + s.qualities.length, 0);
    expect(getNormalizeStatsForTests().encodeCalls).toBe(expectedCalls);
  });

  test("N7b: all-terminal overflow falls to the guard, which textifies — either-fits-or-textifies", async () => {
    // 30 identical stubborn images at 3MiB terminal → sum 90MiB, nothing demotable below
    // 3MiB → normalization exits all-terminal and the guard Rule 4 backstop textifies.
    const stubborn = sizedEncoder(() => 3 * 1024 * 1024);
    const messages = [userMsg(Array.from({ length: 30 }, () => imageBlock(fakePngBase64(3000, 2000))))];
    await normalizeAnthropicImages(messages, { encode: stubborn });
    enforceAnthropicImageLimits(messages);
    const content = contentOf(messages);
    expect(content.some(b => b.type === "text")).toBe(true); // oldest textified by backstop
    let sum = 0;
    for (const b of content) if (b.type === "image") sum += b.source?.data?.length ?? 0;
    expect(sum).toBeLessThanOrEqual(TOTAL_IMAGE_BASE64_BUDGET);
  });

  test("representative 100-image session: demotion keeps every image, zero textify, sum within budget", async () => {
    const capFitting = sizedEncoder(edge => {
      const spec = TIER_SPECS.find(s => s.maxEdge === edge)!;
      return Number.isFinite(spec.hardCap) ? spec.hardCap : 100 * 1024;
    });
    const messages = [userMsg(Array.from({ length: 100 }, () => imageBlock(fakePngBase64(3000, 2000))))];
    await normalizeAnthropicImages(messages, { encode: capFitting });
    enforceAnthropicImageLimits(messages);
    const content = contentOf(messages);
    expect(content.every(b => b.type === "image")).toBe(true);
    let sum = 0;
    for (const b of content) sum += b.source?.data?.length ?? 0;
    expect(sum).toBeLessThanOrEqual(TOTAL_IMAGE_BASE64_BUDGET);
  });

  test("aggregate demotion: over-budget totals demote OLDEST images further down the ladder until the sum fits", async () => {
    // Encoder returns exactly the hard cap at each position (terminal: 100KiB).
    const capFitting = sizedEncoder(edge => {
      const spec = TIER_SPECS.find(s => s.maxEdge === edge)!;
      return Number.isFinite(spec.hardCap) ? spec.hardCap : 100 * 1024;
    });
    // 30 images, all larger than every tier edge so every one is encoded.
    const messages = [userMsg(Array.from({ length: 30 }, () => imageBlock(fakePngBase64(3000, 2000))))];
    await normalizeAnthropicImages(messages, { encode: capFitting });
    const content = contentOf(messages);
    expect(content.every(b => b.type === "image")).toBe(true);
    let sum = 0;
    for (const b of content) sum += b.source?.data?.length ?? 0;
    expect(sum).toBeLessThanOrEqual(TOTAL_IMAGE_BASE64_BUDGET);
    // Oldest images were demoted below tier 2 (192KiB) to the 100KiB floor.
    expect(content[0].source?.data?.length).toBe(100 * 1024);
  });

  test("activation both directions: with normalization the guard keeps every image; without it Rule 4 drops", async () => {
    const shrink = sizedEncoder(() => 50 * 1024);
    const bigB64 = fakePngBase64(3000, 2000, 3 * 1024 * 1024); // 4MiB base64 each
    const normalized = [userMsg(Array.from({ length: 8 }, () => imageBlock(bigB64)))];
    await normalizeAnthropicImages(normalized, { encode: shrink });
    enforceAnthropicImageLimits(normalized);
    expect(contentOf(normalized).every(b => b.type === "image")).toBe(true);

    const raw = [userMsg(Array.from({ length: 8 }, () => imageBlock(bigB64)))];
    enforceAnthropicImageLimits(raw);
    expect(contentOf(raw).some(b => b.type === "text")).toBe(true);
  });
});

describe("bounded parallel first pass (WP170)", () => {
  beforeEach(() => resetNormalizeStateForTests());

  /** Deterministic counting barrier: encode calls park until released. */
  function gatedEncoder() {
    let active = 0;
    let peak = 0;
    let arrivals = 0;
    let releaseAll: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseAll = resolve; });
    let onArrival: (() => void) | undefined;
    const encode: EncodeFn = async (_input, spec) => {
      active++;
      arrivals++;
      peak = Math.max(peak, active);
      onArrival?.();
      await gate;
      active--;
      // Under the hard cap immediately so each image encodes exactly once.
      const b64len = 4 * 1024;
      const px = fakePngBase64(Math.min(64, spec.maxEdge), Math.min(64, spec.maxEdge), Math.ceil((b64len / 4) * 3));
      return { data: px.slice(0, b64len), mediaType: "image/webp" };
    };
    return {
      encode,
      release: () => releaseAll!(),
      stats: () => ({ active, peak, arrivals }),
      waitForArrivals: (count: number) => new Promise<void>(resolve => {
        const check = () => { if (arrivals >= count) resolve(); else onArrival = check; };
        check();
      }),
    };
  }

  /** Unique fake PNGs (distinct hashes) so the tier cache cannot collapse encode calls. */
  function distinctImages(count: number): string[] {
    // Width > tier-0 maxEdge (2000) so no image rides the pass-through+validate lane —
    // every fixture provably reaches the injected encoder.
    return Array.from({ length: count }, (_, i) => fakePngBase64(2100 + i, 1500 + i, 8192));
  }

  test("parallelism is real but never exceeds the fixed concurrency limit", async () => {
    const g = gatedEncoder();
    const messages = [userMsg(distinctImages(10).map(b64 => imageBlock(b64)))];
    const run = normalizeAnthropicImages(messages, { encode: g.encode });

    // All pool workers must arrive at the gate together: parallel, and bounded.
    await g.waitForArrivals(IMAGE_NORMALIZE_CONCURRENCY);
    expect(g.stats().active).toBe(IMAGE_NORMALIZE_CONCURRENCY);
    expect(g.stats().peak).toBeGreaterThan(1);

    g.release();
    await run;
    expect(g.stats().peak).toBe(IMAGE_NORMALIZE_CONCURRENCY);
    expect(g.stats().active).toBe(0);
    // Every image reached the encoder (10 distinct hashes, one encode each).
    expect(g.stats().arrivals).toBe(10);
  });

  test("a thrown target callback rejects the call, settles in-flight work, and stops new pulls", async () => {
    // processAt swallows encode/validate throws into {kind:"failed"} (its own catch),
    // so the production escape hatch is a throwing target callback (drop/replace).
    const unhandled: unknown[] = [];
    const trap = (err: unknown) => { unhandled.push(err); };
    process.on("unhandledRejection", trap);
    try {
      let encodeCalls = 0;
      const smallEncode: EncodeFn = async () => {
        encodeCalls++;
        const px = fakePngBase64(64, 64, 3 * 1024);
        return { data: px.slice(0, 4 * 1024), mediaType: "image/webp" };
      };
      const images = distinctImages(9);
      let replaceCalls = 0;
      const targets: NormalizeTarget[] = images.map((b64, i) => ({
        base64: b64,
        mediaType: "image/png",
        replace: () => {
          replaceCalls++;
          if (i === 2) throw new Error("wire mutation failed");
        },
        drop: () => {},
      }));

      await expect(normalizeImageTargets(targets, { encode: smallEncode })).rejects.toThrow("wire mutation failed");
      // The failure stopped workers from pulling every remaining index: fewer encode
      // calls than images proves no full-queue drain after the fatal error.
      expect(encodeCalls).toBeLessThan(images.length);
      expect(replaceCalls).toBeGreaterThan(0);
      // Give any leaked rejection a macrotask to surface before asserting none did.
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", trap);
    }
  });

  test("zero encoder starts after a fatal replace error (synchronous failure flag)", async () => {
    // All four workers park at the encoder gate. Index 0's replace throws when the
    // first batch settles; once the throw has happened, NO new encode may start even
    // though three other continuations are queued to resume.
    const events: string[] = [];
    let fatalThrown = false;
    const parked: Array<() => void> = [];
    const encode: EncodeFn = async (input, spec) => {
      if (fatalThrown) events.push("encode-after-fatal");
      events.push("encode");
      await new Promise<void>(resolve => { parked.push(resolve); });
      const px = fakePngBase64(Math.min(64, spec.maxEdge), Math.min(64, spec.maxEdge), 3 * 1024);
      return { data: px.slice(0, 4 * 1024), mediaType: "image/webp" };
    };
    const images = distinctImages(8);
    const targets: NormalizeTarget[] = images.map((b64, i) => ({
      base64: b64,
      mediaType: "image/png",
      replace: () => {
        if (i === 0) {
          fatalThrown = true;
          throw new Error("fatal-0");
        }
      },
      drop: () => {},
    }));
    const run = normalizeImageTargets(targets, { encode });
    while (parked.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
    // Release the first batch: index 0 throws inside its replace.
    for (const release of parked.splice(0, 4)) release();
    await expect(run).rejects.toThrow("fatal-0");
    // Settle any stragglers so the assertion below is final.
    for (const release of parked.splice(0)) release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(events).not.toContain("encode-after-fatal");
  });

  test("output order is deterministic regardless of completion order", async () => {
    // Later images complete FIRST (reverse-release), yet entries stay index-addressed.
    const parked: Array<{ key: string; resolve: () => void }> = [];
    const encode: EncodeFn = async (input, spec) => {
      const key = Bun.hash(input).toString(36);
      await new Promise<void>(resolve => { parked.push({ key, resolve }); });
      const b64len = 4 * 1024;
      const px = fakePngBase64(Math.min(64, spec.maxEdge), Math.min(64, spec.maxEdge), 3 * 1024);
      // Tag the payload with the SOURCE hash so replace() can prove payload-to-index identity.
      return { data: px.slice(0, b64len - key.length - 1) + ":" + key, mediaType: "image/webp" };
    };

    const images = distinctImages(4); // == pool width: all park concurrently
    const order: number[] = [];
    const received: Record<number, string> = {};
    const targets: NormalizeTarget[] = images.map((b64, i) => ({
      base64: b64,
      mediaType: "image/png",
      replace: data => { order.push(i); received[i] = data; },
      drop: () => {},
    }));
    const run = normalizeImageTargets(targets, { encode });

    // Wait until all four workers are parked, then release newest-first.
    while (parked.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
    for (const p of [...parked].reverse()) p.resolve();
    await run;

    // Completion order was reversed, and replace() ran in that scrambled order —
    // but every target got its own index's payload (no cross-index mixups).
    expect(order.length).toBe(4);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < 4; i++) {
      const expectedKey = Bun.hash(Uint8Array.from(Buffer.from(images[i], "base64"))).toString(36);
      expect(received[i]?.endsWith(":" + expectedKey)).toBe(true);
    }
  });

  test("entries stay index-addressed under reversed completion: overflow drop hits index 0, not first-completed", async () => {
    // Same reverse-release scramble, but with a budget small enough that the
    // terminal-overflow path must drop the OLDEST target (index 0). A mutant storing
    // entries[] in completion order would drop the first-COMPLETED target (index 3).
    const parked: Array<() => void> = [];
    let firstPassCalls = 0;
    const encode: EncodeFn = async (input, spec) => {
      // Only the first-pass calls park (to scramble completion order); the sequential
      // demotion loop's re-encodes must run through immediately.
      if (firstPassCalls < 4) {
        firstPassCalls++;
        await new Promise<void>(resolve => { parked.push(resolve); });
      }
      const px = fakePngBase64(Math.min(64, spec.maxEdge), Math.min(64, spec.maxEdge), 3 * 1024);
      return { data: px.slice(0, 4 * 1024), mediaType: "image/webp" };
    };
    const images = distinctImages(4);
    const droppedForOverflow: number[] = [];
    const targets: NormalizeTarget[] = images.map((b64, i) => ({
      base64: b64,
      mediaType: "image/png",
      replace: () => {},
      drop: note => { if (note.includes("provider request budget")) droppedForOverflow.push(i); },
    }));
    // Budget fits 3 of the 4 terminal outputs (4KiB each): exactly one must be dropped.
    const run = normalizeImageTargets(targets, { encode, budget: 3 * 4 * 1024, overflowAction: "drop" });
    while (parked.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
    for (const release of [...parked].reverse()) release();
    await run;
    expect(droppedForOverflow).toEqual([0]);
  });

  test("skip paths free the worker slot: URL sources and over-limit images never reach the encoder", async () => {
    const g = gatedEncoder();
    const real = distinctImages(3);
    const targets: NormalizeTarget[] = [
      { base64: null, mediaType: "image/png", replace: () => {}, drop: () => {} },
      // Over-length base64 (> MAX_INPUT_BASE64_LENGTH): dropped before decode, no slot used.
      { base64: "A".repeat(64 * 1024 * 1024 + 4), mediaType: "image/png", replace: () => {}, drop: () => {} },
      // Decode-bomb dimensions (> MAX_INPUT_PIXELS via sniffed header): dropped, no slot used.
      { base64: fakePngBase64(20_000, 20_000, 4096), mediaType: "image/png", replace: () => {}, drop: () => {} },
      ...real.map(b64 => ({ base64: b64, mediaType: "image/png", replace: () => {}, drop: () => {} })),
    ];
    const dropped: number[] = [];
    targets[1]!.drop = () => { dropped.push(1); };
    targets[2]!.drop = () => { dropped.push(2); };
    const run = normalizeImageTargets(targets, { encode: g.encode });
    await g.waitForArrivals(3);
    g.release();
    await run;
    // Only the three real images encoded; URL + over-limit sources consumed no slot.
    expect(g.stats().arrivals).toBe(3);
    expect(dropped.sort()).toEqual([1, 2]);
  });
});
