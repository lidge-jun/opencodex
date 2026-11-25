/**
 * The shared media data-URL decoder: one accepted form, every other form refused, and the
 * one-pass validation agreeing exactly with a strict decode (decode, re-encode, compare).
 */
import { describe, expect, test } from "bun:test";
import { decodeMediaDataUrl, parseMediaDataUrl } from "../../src/lib/media-data-url";

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The strict-decode oracle: a payload is valid iff it decodes and re-encodes to itself. */
function reencodes(payload: string): boolean {
  return payload.length > 0 && Buffer.from(payload, "base64").toString("base64") === payload;
}

describe("accepted form", () => {
  test.each([
    ["data:video/mp4;base64,AAAA", "video/mp4", "AAAA", 3],
    ["data:video/mp4;base64,QQ==", "video/mp4", "QQ==", 1],
    ["data:video/mp4;base64,QUI=", "video/mp4", "QUI=", 2],
    ["data:Video/MP4;codecs=avc1;BASE64,QUJD", "video/mp4", "QUJD", 3],
    ["DATA:video/webm;base64,aGVsbG8=", "video/webm", "aGVsbG8=", 5],
  ])("%s", (url, mime, base64, decodedBytes) => {
    expect(parseMediaDataUrl(url)).toEqual({ ok: true, mime, base64, decodedBytes });
  });
});

describe("refused forms", () => {
  test.each([
    ["https://example.test/clip.mp4", "not_data_url"],
    ["data:video/mp4;base64", "malformed_header"],
    ["data:video/mp4,AAAA", "not_base64"],
    ["data:video/mp4;charset=x,AAAA", "not_base64"],
    ["data:;base64,AAAA", "malformed_header"],
    ["data:video;base64,AAAA", "malformed_header"],
    ["data:video/mp4;base64;foo,AAAA", "malformed_header"],
    ["data:video/mp4;base64 ,AAAA", "malformed_header"],
    ["data:video/mp4; base64,AAAA", "malformed_header"],
    ["data:video/mp4;codecs;base64,AAAA", "malformed_header"],
    ["data:video/mp4;base64,", "malformed_payload"],
    ["data:video/mp4;base64,QQ%3D%3D", "malformed_payload"],
    ["data:video/mp4;base64,QQ= =", "malformed_payload"],
    ["data:video/mp4;base64,QQ==\n", "malformed_payload"],
    ["data:video/mp4;base64,-_8=", "malformed_payload"],
    ["data:video/mp4;base64,QQ", "malformed_payload"],
    ["data:video/mp4;base64,QUI", "malformed_payload"],
    ["data:video/mp4;base64,A", "malformed_payload"],
    ["data:video/mp4;base64,AAA==", "malformed_payload"],
    ["data:video/mp4;base64,A===", "malformed_payload"],
    ["data:video/mp4;base64,Q=Q=", "malformed_payload"],
    ["data:video/mp4;base64,QR==", "malformed_payload"],
    ["data:video/mp4;base64,QUJ=", "malformed_payload"],
  ])("%s -> %s", (url, reason) => {
    const parsed = parseMediaDataUrl(url);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe(reason as never);
  });
});

describe("size cap, applied from the payload length before any scan", () => {
  // 9 decoded bytes = 12 characters; 8 = "...=" ; 10 = 16 characters with "==".
  const url = (bytes: number) => `data:video/mp4;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
  test.each([[8, true], [9, true], [10, false]])("%i bytes against a 9-byte cap", (bytes, ok) => {
    const parsed = parseMediaDataUrl(url(bytes), { maxBytes: 9 });
    expect(parsed.ok).toBe(ok);
    expect(parsed.decodedBytes).toBe(bytes);
    if (!parsed.ok) expect(parsed.reason).toBe("too_large");
  });

  test("an over-cap payload is refused as too_large even when its characters are invalid", () => {
    // The size verdict needs only the length, so a request-sized string is never scanned.
    expect(parseMediaDataUrl(`data:video/mp4;base64,${"%".repeat(16)}`, { maxBytes: 9 })).toEqual({ ok: false, reason: "too_large", decodedBytes: 12 });
  });
});

describe("property: the one-pass check is the strict decode", () => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const NOISE = [...ALPHABET, "=", "%", " ", "\n", "-", "_", "é", "."];

  test("random bytes round-trip: encode -> parse -> decode gives the same bytes", () => {
    const next = rng(9131);
    for (let i = 0; i < 400; i++) {
      const bytes = Uint8Array.from({ length: 1 + Math.floor(next() * 64) }, () => Math.floor(next() * 256));
      const base64 = Buffer.from(bytes).toString("base64");
      const parsed = parseMediaDataUrl(`data:video/mp4;base64,${base64}`);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.base64).toBe(base64);
      expect(parsed.decodedBytes).toBe(bytes.length);
      expect([...decodeMediaDataUrl(parsed)]).toEqual([...bytes]);
    }
  });

  test("mutated payloads are accepted exactly when they decode and re-encode to themselves", () => {
    const next = rng(20261125);
    let accepted = 0;
    let refused = 0;
    for (let i = 0; i < 2000; i++) {
      const bytes = Uint8Array.from({ length: 1 + Math.floor(next() * 16) }, () => Math.floor(next() * 256));
      let payload = Buffer.from(bytes).toString("base64");
      const at = Math.floor(next() * (payload.length + 1));
      const noise = NOISE[Math.floor(next() * NOISE.length)]!;
      const kind = Math.floor(next() * 3);
      payload = kind === 0 ? payload.slice(0, at) + noise + payload.slice(at + 1)
        : kind === 1 ? payload.slice(0, at) + noise + payload.slice(at)
        : payload.slice(0, at) + payload.slice(at + 1);
      const parsed = parseMediaDataUrl(`data:video/mp4;base64,${payload}`);
      expect(parsed.ok).toBe(reencodes(payload));
      if (parsed.ok) accepted++;
      else refused++;
    }
    // Both branches were exercised.
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(50);
  });
});
