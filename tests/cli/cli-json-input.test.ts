import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, constants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { readJsonInput, serializeManagementJson } from "../../src/cli/json-input";
import { CliUsageError } from "../../src/cli/runtime-api";

const CAP = 4 * 1024 * 1024;
const SENTINEL = "synthetic-private-value-should-never-echo";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(contents: string | Uint8Array): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-json-input-"));
  roots.push(root);
  const path = join(root, "input.json");
  writeFileSync(path, contents);
  return path;
}

function assertDetached(input: Readable): void {
  for (const event of ["data", "end", "error"]) expect(input.listenerCount(event)).toBe(0);
  // Bun leaves this flag true for a destroyed stream after EOF. No bytes can
  // flow then; a stream that has not ended must actually be paused.
  expect(input.readableEnded || input.readableFlowing === false).toBe(true);
}

async function failure(action: () => unknown | Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try { await action(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CliUsageError);
  expect((error as Error).message).toBe(message);
  expect((error as Error).message).not.toContain(SENTINEL);
  expect((error as Error).cause).toBeUndefined();
}

async function pipeDocument(content: string | Uint8Array): Promise<{ value: unknown; input: PassThrough; chunk: Buffer }> {
  const input = new PassThrough();
  const chunk = Buffer.from(content);
  const pending = readJsonInput("-", { stdinImpl: input });
  input.end(chunk);
  const value = await pending;
  return { value, input, chunk };
}

describe("bounded CLI JSON stdin", () => {
  test("refuses an implicit source without touching stdin", async () => {
    const input = new PassThrough();
    await failure(() => readJsonInput("", { stdinImpl: input }), "JSON input requires an explicit file or '-'");
    expect(input.eventNames()).not.toContain("data");
    input.destroy();
  });

  test("refuses a TTY before reading", async () => {
    const input: PassThrough & { isTTY?: boolean } = new PassThrough();
    input.isTTY = true;
    await failure(() => readJsonInput("-", { stdinImpl: input }), "JSON input requires a file or piped stdin");
    expect(input.listenerCount("data")).toBe(0);
    expect(input.readableFlowing).toBeNull();
    input.destroy();
  });

  test.each(["", " \n\t"])('rejects empty input %j and clears buffers', async content => {
    const input = new PassThrough();
    const chunk = Buffer.from(content);
    const pending = readJsonInput("-", { stdinImpl: input });
    input.end(chunk);
    await failure(() => pending, "JSON input was empty");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
  });

  test("an already-ended stream does not wait for the deadline", async () => {
    const input = new Readable({ read() {} });
    Object.defineProperty(input, "readableEnded", { value: true });
    await failure(() => readJsonInput("-", { stdinImpl: input }), "JSON input was empty");
    assertDetached(input);
    input.destroy();
  });

  test("does not accept a stream that already performs lossy text decoding", async () => {
    const input = new PassThrough();
    input.setEncoding("utf8");
    await failure(() => readJsonInput("-", { stdinImpl: input }), "JSON input requires byte-oriented stdin");
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  test("parse errors and caller labels cannot echo supplied values", async () => {
    const input = new PassThrough();
    const chunk = Buffer.from(`{"${SENTINEL}":`);
    const pending = readJsonInput("-", { stdinImpl: input }, SENTINEL);
    input.end(chunk);
    await failure(() => pending, "JSON input must contain valid JSON");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
  });

  test.each([{ bytes: [0xc3, 0x28] }, { bytes: [0xff] }, { bytes: [0xe2, 0x82] }])("refuses malformed UTF-8 %j", async ({ bytes }) => {
    const input = new PassThrough();
    const chunk = Buffer.from([0x22, ...bytes, 0x22]);
    const pending = readJsonInput("-", { stdinImpl: input });
    input.end(chunk);
    await failure(() => pending, "JSON input must be valid UTF-8");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
  });

  test("accepts exactly 4 MiB and clears source bytes", async () => {
    const { value, input, chunk } = await pipeDocument(`"${"x".repeat(CAP - 2)}"`);
    expect((value as string).length).toBe(CAP - 2);
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
  });

  test("refuses cap plus one before EOF and pauses the producer", async () => {
    const input = new PassThrough();
    const chunk = Buffer.alloc(CAP + 1, 0x20);
    const pending = readJsonInput("-", { stdinImpl: input });
    input.write(chunk);
    await failure(() => pending, "JSON input exceeds the 4 MiB management body limit");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
    expect(input.destroyed).toBe(false);
    input.destroy();
  });

  test("counts bytes across chunks including split Unicode", async () => {
    const input = new PassThrough();
    const chunks = [Buffer.from([0x22, 0xe2]), Buffer.from([0x82]), Buffer.from([0xac, 0x22])];
    const pending = readJsonInput("-", { stdinImpl: input });
    for (const chunk of chunks) input.write(chunk);
    input.end();
    expect(await pending).toBe("€");
    expect(chunks.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
    assertDetached(input);
  });

  test("a cumulative overflow clears every previous chunk", async () => {
    const input = new PassThrough();
    const chunks = [Buffer.alloc(CAP - 2, 0x20), Buffer.from("€")];
    const pending = readJsonInput("-", { stdinImpl: input });
    chunks.forEach(chunk => input.write(chunk));
    await failure(() => pending, "JSON input exceeds the 4 MiB management body limit");
    expect(chunks.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
    assertDetached(input);
    input.destroy();
  });

  test("stream errors are fixed diagnostics even for a forged usage error", async () => {
    const input = new PassThrough();
    const chunk = Buffer.from(SENTINEL);
    const pending = readJsonInput("-", { stdinImpl: input });
    input.write(chunk);
    input.emit("error", new CliUsageError(SENTINEL));
    await failure(() => pending, "Unable to read JSON input");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
    input.destroy();
  });

  test("deadline clears retained chunks/listeners and pauses without closing stdin", async () => {
    const input = new PassThrough();
    const chunk = Buffer.from(SENTINEL);
    const pending = readJsonInput("-", { stdinImpl: input, stdinTimeoutMs: 5 });
    input.write(chunk);
    await failure(() => pending, "Timed out reading JSON input");
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
    expect(input.destroyed).toBe(false);
    input.destroy();
  });

  test("clears its timer after success and after deadline refusal", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    const set = spyOn(globalThis, "setTimeout").mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const timer = realSetTimeout(...args);
      pendingTimers.add(timer);
      return timer;
    });
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(timer => {
      pendingTimers.delete(timer as ReturnType<typeof setTimeout>);
      realClearTimeout(timer);
    });
    const silent = new PassThrough();
    try {
      expect((await pipeDocument("{}")).value).toEqual({});
      expect(pendingTimers.size).toBe(0);
      await failure(() => readJsonInput("-", { stdinImpl: silent, stdinTimeoutMs: 5 }), "Timed out reading JSON input");
      expect(pendingTimers.size).toBe(0);
      assertDetached(silent);
    } finally { set.mockRestore(); clear.mockRestore(); silent.destroy(); }
  });

  test.each([0, -1, Infinity, NaN, 30_001])("refuses an invalid deadline %s", async stdinTimeoutMs => {
    await failure(() => readJsonInput("-", { stdinTimeoutMs }), "JSON input deadline must be within 30 seconds");
  });

  test.each(["[1,true,null]", "{\n\"nested\": [1, 2]\n}", "null", "false", "0", "\uFEFF{\"ok\":true}"])("accepts generic JSON/BOM %j", async document => {
    const { value, input, chunk } = await pipeDocument(document);
    expect(value).toEqual(JSON.parse(document.replace(/^\uFEFF/, "")));
    expect(chunk.every(byte => byte === 0)).toBe(true);
    assertDetached(input);
  });

  test("accepts only a single leading BOM", async () => {
    const input = new PassThrough();
    const pending = readJsonInput("-", { stdinImpl: input });
    input.end("\uFEFF\uFEFF{}");
    await failure(() => pending, "JSON input must contain valid JSON");
    assertDetached(input);
  });
});

describe("bounded CLI JSON files", () => {
  test("reads a regular multiline BOM file without reading stdin", async () => {
    const input = new PassThrough();
    const path = fixture("\uFEFF{\n\"value\":\"한글\"\n}");
    expect(await readJsonInput(path, { stdinImpl: input })).toEqual({ value: "한글" });
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
  });

  test("reads a file at the exact cap", async () => {
    expect((await readJsonInput(fixture(`"${"x".repeat(CAP - 2)}"`)) as string).length).toBe(CAP - 2);
  });

  test("refuses an oversized regular file", async () => {
    await failure(() => readJsonInput(fixture(Buffer.alloc(CAP + 1, 0x20))), "JSON input exceeds the 4 MiB management body limit");
  });

  test("does not expose missing paths or I/O errors", async () => {
    const path = fixture("{}");
    await failure(() => readJsonInput(join(path, SENTINEL)), "Unable to read JSON input");
  });

  test("refuses directories before open", async () => {
    const path = fixture("{}");
    await failure(() => readJsonInput(join(path, "..")), "JSON input must be a regular file");
  });

  test("invalid file UTF-8 is refused", async () => {
    await failure(() => readJsonInput(fixture(new Uint8Array([0xff]))), "JSON input must be valid UTF-8");
  });

  test("refuses FIFO input without waiting for a writer", async () => {
    if (process.platform === "win32") return;
    const path = fixture("{}");
    const fifo = `${path}.fifo`;
    const result = Bun.spawnSync(["mkfifo", fifo]);
    expect(result.exitCode).toBe(0);
    await failure(() => readJsonInput(fifo, { stdinTimeoutMs: 100 }), "JSON input must be a regular file");
  });

  test("rechecks opened descriptors and rejects growth after the metadata check", async () => {
    const path = fixture("{}");
    const realOpen = fsPromises.open;
    const opened: fsPromises.FileHandle[] = [];
    const openSpy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof fsPromises.open>) => {
      expect(args[1]).toBe(constants.O_RDONLY | constants.O_NONBLOCK);
      const handle = await realOpen(...args);
      opened.push(handle);
      const realStat = handle.stat.bind(handle);
      // Change the real file after fstat, so only the running byte cap protects us.
      spyOn(handle, "stat").mockImplementation(async () => {
        const result = await realStat();
        appendFileSync(path, Buffer.alloc(CAP, 0x20));
        return result;
      });
      return handle;
    });
    try {
      await failure(() => readJsonInput(path), "JSON input exceeds the 4 MiB management body limit");
      expect(opened).toHaveLength(1);
      expect(opened[0]!.fd).toBe(-1);
    } finally { openSpy.mockRestore(); }
  });

  test("refuses a nonregular descriptor substituted after path stat", async () => {
    const path = fixture("{}");
    const handle = await fsPromises.open(path, "r");
    const metadata = await handle.stat();
    spyOn(metadata, "isFile").mockReturnValue(false);
    spyOn(handle, "stat").mockResolvedValue(metadata);
    const openSpy = spyOn(fsPromises, "open").mockResolvedValue(handle);
    try {
      await failure(() => readJsonInput(path), "JSON input must be a regular file");
      expect(handle.fd).toBe(-1);
    } finally { openSpy.mockRestore(); await handle.close(); }
  });

  test("closes an open result arriving after the total deadline", async () => {
    const path = fixture("{}");
    const handle = await fsPromises.open(path, "r");
    const statSpy = spyOn(fsPromises, "stat").mockResolvedValue(await handle.stat());
    let release!: (handle: fsPromises.FileHandle) => void;
    let opened!: () => void;
    let closed!: () => void;
    const called = new Promise<void>(resolve => { opened = resolve; });
    const didClose = new Promise<void>(resolve => { closed = resolve; });
    const originalClose = handle.close.bind(handle);
    spyOn(handle, "close").mockImplementation(async () => { await originalClose(); closed(); });
    const openSpy = spyOn(fsPromises, "open").mockImplementation(() => {
      opened();
      return new Promise(resolve => { release = resolve; });
    });
    try {
      const pending = readJsonInput(path, { stdinTimeoutMs: 25 });
      await called;
      await failure(() => pending, "Timed out reading JSON input");
      release(handle);
      await didClose;
      expect(handle.fd).toBe(-1);
    } finally { openSpy.mockRestore(); statSpy.mockRestore(); await originalClose(); }
  });

  test("file read deadline destroys its reader and closes its handle", async () => {
    const path = fixture("{}");
    const handle = await fsPromises.open(path, "r");
    const metadata = await handle.stat();
    const statSpy = spyOn(fsPromises, "stat").mockResolvedValue(metadata);
    spyOn(handle, "stat").mockResolvedValue(metadata);
    const input = new PassThrough();
    const create = spyOn(handle, "createReadStream").mockReturnValue(input as unknown as ReturnType<typeof handle.createReadStream>);
    const openSpy = spyOn(fsPromises, "open").mockResolvedValue(handle);
    try {
      await failure(() => readJsonInput(path, { stdinTimeoutMs: 25 }), "Timed out reading JSON input");
      expect(input.destroyed).toBe(true);
      expect(handle.fd).toBe(-1);
      expect(input.listenerCount("data")).toBe(0);
      expect(input.listenerCount("end")).toBe(0);
    } finally { create.mockRestore(); openSpy.mockRestore(); statSpy.mockRestore(); input.destroy(); await handle.close(); }
  });

  test("all emitted file buffers are cleared before parse failure returns", async () => {
    const path = fixture(`{"${SENTINEL}":`);
    const handle = await fsPromises.open(path, "r");
    const realCreate = handle.createReadStream.bind(handle);
    const chunks: Buffer[] = [];
    const create = spyOn(handle, "createReadStream").mockImplementation(options => {
      const stream = realCreate(options);
      stream.on("data", chunk => { chunks.push(chunk as Buffer); });
      return stream;
    });
    const openSpy = spyOn(fsPromises, "open").mockResolvedValue(handle);
    try {
      await failure(() => readJsonInput(path), "JSON input must contain valid JSON");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(chunk => chunk.every(byte => byte === 0))).toBe(true);
      expect(handle.fd).toBe(-1);
    } finally { create.mockRestore(); openSpy.mockRestore(); await handle.close(); }
  });
});

describe("management JSON serialization", () => {
  test("counts the composite envelope, not just individual documents", async () => {
    const part = "a".repeat(CAP / 2);
    await failure(() => serializeManagementJson({ baseline: part, next: part }), "JSON input exceeds the 4 MiB management body limit");
  });

  test("exact-cap UTF-8 succeeds, cap plus one refuses", async () => {
    expect(Buffer.byteLength(serializeManagementJson("x".repeat(CAP - 2)))).toBe(CAP);
    await failure(() => serializeManagementJson("x".repeat(CAP - 1)), "JSON input exceeds the 4 MiB management body limit");
  });

  test("Unicode size is bytes rather than UTF-16 length", async () => {
    const value = "€".repeat(Math.ceil(CAP / 3));
    expect(value.length).toBeLessThan(CAP);
    await failure(() => serializeManagementJson(value), "JSON input exceeds the 4 MiB management body limit");
  });

  test("serializes once and preserves exact wire data", () => {
    let calls = 0;
    expect(serializeManagementJson({ toJSON() { calls++; return { baseline: {}, next: {} }; } })).toBe('{"baseline":{},"next":{}}');
    expect(calls).toBe(1);
  });

  test.each([undefined, 1n, () => SENTINEL])("refuses nonserializable root values", async value => {
    await failure(() => serializeManagementJson(value), "Management body must be JSON serializable");
  });

  test("cycles and throwing serializers do not echo source errors", async () => {
    const cycle: Record<string, unknown> = {};
    cycle[SENTINEL] = cycle;
    await failure(() => serializeManagementJson(cycle), "Management body must be JSON serializable");
    await failure(() => serializeManagementJson({ toJSON() { throw new Error(SENTINEL); } }), "Management body must be JSON serializable");
  });
});
