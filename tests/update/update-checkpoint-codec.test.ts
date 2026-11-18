import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../helpers/repo-root";
import { checkpointPayloadDigest, decodeCheckpointPayload, encodeCheckpointPayload, type CheckpointPayload } from "../../src/update/update-checkpoint-codec.mjs";

describe("unverified checkpoint payload codec", () => {
  const golden = readFileSync(fixturePath("update-checkpoint", "initial.bin"));

  test("decodes and reproduces the independently generated golden bytes", () => {
    expect(golden.byteLength).toBe(1369);
    expect(createHash("sha256").update(golden).digest("hex")).toBe("9b2d3f7c39c2456cf3f28439de1f80be8af006c4705d5e621ea9abb723077546");
    const data = decodeCheckpointPayload(golden);
    expect(data.rootRevision).toBe(1);
    expect(data.generation).toBe(1);
    expect(data.channels).toEqual({ latest: null, preview: null, nightly: null });
    expect(Buffer.from(encodeCheckpointPayload(data))).toEqual(golden);
    expect(checkpointPayloadDigest(golden)).toBe("9b2d3f7c39c2456cf3f28439de1f80be8af006c4705d5e621ea9abb723077546");
  });

  test("accepts independent canonical vectors and rejects malformed corpus", () => {
    const corpus = JSON.parse(readFileSync(fixturePath("update-checkpoint", "corpus.json"), "utf8")) as { valid: Record<string, string>; invalid: Record<string, string> };
    for (const [name, base64] of Object.entries(corpus.valid)) {
      const source = Buffer.from(base64, "base64");
      const decoded = decodeCheckpointPayload(source);
      expect(Buffer.from(encodeCheckpointPayload(decoded)), name).toEqual(source);
      expect(checkpointPayloadDigest(source), name).toBe(createHash("sha256").update(source).digest("hex"));
    }
    for (const [name, base64] of Object.entries(corpus.invalid)) {
      const source = Buffer.from(base64, "base64");
      expect(() => decodeCheckpointPayload(source), name).toThrow();
      expect(() => checkpointPayloadDigest(source), name).toThrow();
    }
  });

  test("enforces history count at the actual boundary", () => {
    const fixtures = JSON.parse(readFileSync(fixturePath("update-checkpoint", "history-limits.json"), "utf8")) as Record<string, { base64: string; sha256: string }>;
    const valid = Buffer.from(fixtures.proposed_valid_history_128.base64, "base64");
    const invalid = Buffer.from(fixtures.proposed_invalid_history_129.base64, "base64");
    expect(checkpointPayloadDigest(valid)).toBe(fixtures.proposed_valid_history_128.sha256);
    const atLimit = decodeCheckpointPayload(valid);
    expect(atLimit.history).toHaveLength(128);
    const root = JSON.parse(Buffer.from(atLimit.rootBytes).toString("utf8")) as { revision: number };
    root.revision = atLimit.rootRevision + 1;
    const nextRoot = Buffer.from(JSON.stringify(root));
    const nextDigest = createHash("sha256").update(nextRoot).digest();
    atLimit.history.push({ previousRevision: atLimit.rootRevision, previousDigest: atLimit.rootDigest,
      nextRevision: root.revision, nextDigest, acceptedAtMs: atLimit.history[127].acceptedAtMs,
      rootBytes: nextRoot, envelopeBytes: atLimit.history[127].envelopeBytes });
    atLimit.rootRevision = root.revision;
    atLimit.rootDigest = nextDigest;
    atLimit.rootBytes = nextRoot;
    expect(() => encodeCheckpointPayload(atLimit)).toThrow();
    expect(() => decodeCheckpointPayload(invalid)).toThrow();
    expect(() => checkpointPayloadDigest(invalid)).toThrow();
  });

  test("supports the simultaneous observation limit in all three channels", () => {
    const corpus = JSON.parse(readFileSync(fixturePath("update-checkpoint", "corpus.json"), "utf8")) as { valid: Record<string, string> };
    const data = decodeCheckpointPayload(Buffer.from(corpus.valid["observations-limit"], "base64"));
    data.firstSeen.preview = data.firstSeen.latest.slice();
    data.firstSeen.nightly = data.firstSeen.latest.slice();
    const decoded = decodeCheckpointPayload(encodeCheckpointPayload(data));
    expect(decoded.firstSeen.latest).toHaveLength(4096);
    expect(decoded.firstSeen.preview).toHaveLength(4096);
    expect(decoded.firstSeen.nightly).toHaveLength(4096);
    const nextDigest = Buffer.alloc(32);
    nextDigest.writeUInt32BE(4096, 28);
    data.firstSeen.preview.push({ candidateDigest: nextDigest, firstSeenMs: 0 });
    expect(() => encodeCheckpointPayload(data)).toThrow();
  });

  test("captures bytes and fields without accepting accessors or caller mutation", () => {
    const source = Buffer.from(golden);
    const decoded = decodeCheckpointPayload(source);
    const encoded = encodeCheckpointPayload(decoded);
    source.fill(0);
    decoded.rootBytes.fill(0);
    expect(Buffer.from(encoded)).toEqual(golden);
    const original = decodeCheckpointPayload(golden);
    const other = decodeCheckpointPayload(golden);
    const fields = [original.namespaceDigest, original.principalDigest, original.identityBytes, original.rootDigest, original.rootBytes, other.rootDigest];
    expect(new Set(fields.map((field) => field.buffer)).size).toBe(fields.length);
    original.rootDigest.fill(0);
    expect(other.rootDigest).toEqual(decodeCheckpointPayload(golden).rootDigest);
    const valid = decodeCheckpointPayload(golden);
    const hostile = { ...valid, get generation() { throw new Error("getter invoked"); } };
    expect(() => encodeCheckpointPayload(hostile)).toThrow("Invalid checkpoint payload");
    const extra = { ...valid, extra: true };
    expect(() => encodeCheckpointPayload(extra)).toThrow();
    const sparse = { ...valid, history: new Array(1) };
    expect(() => encodeCheckpointPayload(sparse as CheckpointPayload)).toThrow();
    const shadowed = Buffer.from(golden);
    Object.defineProperty(shadowed, "byteLength", { value: 0 });
    expect(checkpointPayloadDigest(shadowed)).toBe("9b2d3f7c39c2456cf3f28439de1f80be8af006c4705d5e621ea9abb723077546");
  });

  test("rejects extra properties before fetching every descriptor", () => {
    const original = decodeCheckpointPayload(golden);
    const record = { ...original } as Record<string, unknown>;
    const array: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      Object.defineProperty(record, `extra${i}`, { value: i });
      Object.defineProperty(array, `extra${i}`, { value: i });
    }
    let recordLookups = 0, arrayLookups = 0;
    const recordProxy = new Proxy(record, { getOwnPropertyDescriptor(target, key) { recordLookups++; return Reflect.getOwnPropertyDescriptor(target, key); } });
    const arrayProxy = new Proxy(array, { getOwnPropertyDescriptor(target, key) { arrayLookups++; return Reflect.getOwnPropertyDescriptor(target, key); } });
    expect(() => encodeCheckpointPayload(recordProxy as unknown as CheckpointPayload)).toThrow();
    expect(() => encodeCheckpointPayload({ ...original, history: arrayProxy as CheckpointPayload["history"] })).toThrow();
    expect(recordLookups).toBe(0);
    expect(arrayLookups).toBe(1); // The bounded array length is captured before checking its keys.
  });

  test("checks raw-byte cap before structural decoding", () => {
    const atLimit = new Uint8Array(64 * 1024 * 1024);
    const tooLarge = new Uint8Array(atLimit.length + 1);
    for (const operation of [decodeCheckpointPayload, checkpointPayloadDigest]) {
      expect(() => operation(atLimit)).toThrow("Invalid checkpoint payload");
      expect(() => operation(tooLarge)).toThrow("Invalid update bytes");
    }
  });
});
