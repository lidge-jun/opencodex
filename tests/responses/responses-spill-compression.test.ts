import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { decodeResponseSpill, encodeResponseSpill } from "../../src/responses/state/spill-codec";
import { setPlatformForTests } from "../../src/lib/windows-secret-acl";
import { prospectiveResponseSpillBytes, readResponseSpill, responseSpillDirectory,
  setResponseSpillPayloadCapForTests, writeResponseSpillDurably } from "../../src/responses/spill-store";
import { clearResponseStateForTests, clearResponseStateMemoryForTests, expandPreviousResponseInput,
  flushResponseState, rememberResponseState, setResponseStateByteCapForTests } from "../../src/responses/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-spill-codec-"));
  process.env.OPENCODEX_HOME = home;
  setPlatformForTests("linux");
  clearResponseStateMemoryForTests();
});
afterEach(() => {
  setResponseStateByteCapForTests(null);
  setResponseSpillPayloadCapForTests(null);
  clearResponseStateForTests();
  setPlatformForTests(null);
  removeTreeWithRetry(home);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
});

test("large repeated histories use fewer disk bytes and restore every item", () => {
  const text = "retained tool output 中文 \n".repeat(16_384);
  const state = { createdAt: 123, clientThreadId: "fixture-thread", items: [
    { type: "function_call_output", call_id: "call-preserved", output: text },
    { type: "reasoning", encrypted_content: "opaque-ciphertext", summary: [] },
  ], providerOutputStart: 1 };
  const ref = writeResponseSpillDurably("resp-compressed", state);
  expect(ref.payloadBytes).toBeLessThan(Buffer.byteLength(text) / 2);
  expect(prospectiveResponseSpillBytes("resp-compressed", state)).toBe(ref.payloadBytes);
  expect(statSync(join(responseSpillDirectory(), ref.fileName)).size).toBe(ref.payloadBytes);
  const result = readResponseSpill("resp-compressed", ref);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("compressed spill did not decode");
  expect(JSON.stringify(result.payload.items) === JSON.stringify(state.items)).toBe(true);
  expect(result.payload.clientThreadId).toBe("fixture-thread");
  expect(result.payload.providerOutputStart).toBe(1);
});

test("small legacy JSON remains readable", () => {
  const ref = writeResponseSpillDurably("resp-legacy", { createdAt: 123, items: ["unchanged"] });
  const disk = JSON.parse(readFileSync(join(responseSpillDirectory(), ref.fileName), "utf8"));
  expect(disk.version).toBe(1);
  const result = readResponseSpill("resp-legacy", ref);
  expect(result.ok && result.payload.items[0]).toBe("unchanged");
});

test("unprofitable and oversized encodings retain the original format", () => {
  const entropy = Buffer.from(JSON.stringify({ value: randomBytes(128 * 1024).toString("base64") }));
  expect(encodeResponseSpill(entropy, 256 * 1024 * 1024)).toBe(entropy);
  const oversized = Buffer.from(JSON.stringify({ value: "x".repeat(16 * 1024 * 1024) }));
  expect(encodeResponseSpill(oversized, 256 * 1024 * 1024)).toBe(oversized);
  const overLimit = Buffer.from(JSON.stringify({ value: "x".repeat(256 * 1024) }));
  expect(encodeResponseSpill(overLimit, 128 * 1024)).toBe(overLimit);
});

test("compressed reads enforce decoded bounds and reject malformed envelopes", () => {
  const raw = Buffer.from(JSON.stringify({ version: 1, value: "x".repeat(256 * 1024) }));
  const encoded = encodeResponseSpill(raw, 1024 * 1024);
  expect(decodeResponseSpill(encoded, 128 * 1024)).toEqual({ ok: false, reason: "too_large" });
  const envelope = JSON.parse(encoded.toString("utf8"));
  for (const change of [{ data: "not/base64!" }, { data: "AAAA" }, { decodedBytes: 42 },
    { decodedBytes: raw.byteLength + 1 }, { encoding: "unknown" }, { extra: true }]) {
    expect(decodeResponseSpill(Buffer.from(JSON.stringify({ ...envelope, ...change })), 1024 * 1024))
      .toEqual({ ok: false, reason: "corrupt" });
  }
});

test("compressed records preserve previous_response_id across a snapshot reload", async () => {
  setResponseStateByteCapForTests(4096);
  const text = "full prefix preserved ".repeat(16_384);
  rememberResponseState({ input: [{ role: "user", content: text }], store: false },
    { id: "resp-restart", status: "completed", output: [{ role: "assistant", content: "done" }] },
    undefined, { force: true, clientThreadId: "fixture-thread" });
  await flushResponseState();
  clearResponseStateMemoryForTests();
  const restored = expandPreviousResponseInput({ previous_response_id: "resp-restart",
    input: [{ role: "user", content: "next" }] }, "fixture-thread") as { input: { content: string }[] };
  expect(restored.input.length).toBe(3);
  expect(restored.input[0]!.content === text).toBe(true);
  const other = expandPreviousResponseInput({ previous_response_id: "resp-restart", input: ["next"] }, "other-thread") as { input: unknown[] };
  expect(other.input.length).toBe(1);
});
