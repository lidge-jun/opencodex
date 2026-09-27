import { describe, expect, spyOn, test } from "bun:test";
import { CodingAgentProtocolError, CodingAgentStreamLimitError, readJsonLines } from "../../src/adapters/coding-agent/protocol";

async function* chunks(bytes: Uint8Array, width = 1) {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.subarray(offset, offset + width);
}
async function collect(bytes: Uint8Array, limits = {}, width = 1) {
  const out = [];
  for await (const frame of readJsonLines(chunks(bytes, width), limits)) out.push(frame);
  return out;
}

async function framingWork(length: number) {
  const bytes = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(length) }) + "\n");
  let searched = 0;
  let measured = 0;
  let encoded = 0;
  const originalSearch = String.prototype.indexOf;
  const originalMeasure = Buffer.byteLength;
  const originalEncode = TextEncoder.prototype.encode;
  const search = spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, needle, start) {
    if (needle === "\n") searched += this.length - (start ?? 0);
    return originalSearch.call(this, needle, start);
  });
  const measure = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
    if (typeof value === "string") measured += value.length;
    return originalMeasure(value, encoding);
  });
  const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, value) {
    encoded += value?.length ?? 0;
    return originalEncode.call(this, value);
  });
  try {
    const result = await collect(bytes);
    expect(result).toEqual([{ text: "x".repeat(length) }]);
  } finally {
    search.mockRestore(); measure.mockRestore(); encode.mockRestore();
  }
  return { searched, measured, encoded, length: bytes.length };
}

describe("coding-agent incremental JSONL framing", () => {
  test("one-byte chunks search and measure linear input without encoding retained frames", async () => {
    const small = await framingWork(2048);
    const large = await framingWork(4096);
    for (const work of [small, large]) {
      expect(work.searched).toBeLessThanOrEqual(work.length);
      expect(work.measured).toBeLessThanOrEqual(work.length);
      expect(work.encoded).toBe(0);
      expect(work.searched + work.measured).toBeGreaterThan(0);
    }
    expect(large.searched + large.measured).toBeLessThanOrEqual(2 * (small.searched + small.measured));
  });

  test("decoded-byte limits preserve split UTF-8, BOM, CRLF, blank lines and final frames", async () => {
    const text = '{"text":"世界😀"}';
    const maxLineBytes = Buffer.byteLength(text + "\r");
    const bytes = new TextEncoder().encode("\ufeff\r\n" + text + "\r\n \t\n" + text);
    for (const width of [1, 2, 3, bytes.length]) {
      expect(await collect(bytes, { maxLineBytes, maxTotalBytes: bytes.length }, width))
        .toEqual([{ text: "世界😀" }, { text: "世界😀" }]);
      await expect(collect(bytes, { maxLineBytes: maxLineBytes - 1 }, width)).rejects.toBeInstanceOf(CodingAgentStreamLimitError);
      await expect(collect(bytes, { maxTotalBytes: bytes.length - 1 }, width)).rejects.toThrow("total byte ceiling");
    }
  });

  test("invalid UTF-8 is measured after replacement, including decoder EOF", async () => {
    const bytes = Uint8Array.from([...new TextEncoder().encode('{"x":"'), 0xff, ...new TextEncoder().encode('"}\n')]);
    expect(await collect(bytes, { maxLineBytes: 11 })).toEqual([{ x: "�" }]);
    await expect(collect(bytes, { maxLineBytes: 10 })).rejects.toBeInstanceOf(CodingAgentStreamLimitError);
    // A dangling leading byte expands to a three-byte replacement only at EOF.
    await expect(collect(Uint8Array.of(0xe4), { maxLineBytes: 2 })).rejects.toBeInstanceOf(CodingAgentStreamLimitError);
    await expect(collect(Uint8Array.of(0xe4), { maxLineBytes: 3 })).rejects.toBeInstanceOf(CodingAgentProtocolError);
  });

  test("limits and error types apply before parsing each line, including whitespace padding", async () => {
    for (const text of ["   ", "   \n", "   \r\n"]) {
      await expect(collect(new TextEncoder().encode(text), { maxLineBytes: 2 })).rejects.toBeInstanceOf(CodingAgentStreamLimitError);
    }
    for (const text of ['{"x":', "[]", "null", "false", "42", '"text"']) {
      await expect(collect(new TextEncoder().encode(text))).rejects.toBeInstanceOf(CodingAgentProtocolError);
    }
    const bytes = new TextEncoder().encode('{}\ninvalid\n');
    const iterator = readJsonLines(chunks(bytes, bytes.length));
    expect(await iterator.next()).toMatchObject({ value: {}, done: false });
    await expect(iterator.next()).rejects.toBeInstanceOf(CodingAgentProtocolError);
    const totalFirst = readJsonLines(chunks(bytes, bytes.length), { maxTotalBytes: bytes.length - 1 });
    await expect(totalFirst.next()).rejects.toThrow("total byte ceiling");
  });
});
