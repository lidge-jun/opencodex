import { expect, test } from "bun:test";
import { createMessagesSseErrorFilter, filterMessagesSseErrors } from "../../src/server/messages-sse-error-filter";
import { MessagesSseFrameContext, messagesSseLocalFrame, MESSAGES_SSE_ERROR_HOLD_BYTES } from "../../src/lib/messages-sse-error-presentation";
import { SSE_SENTINEL } from "../helpers/messages-sse-cases";
const encode = (text: string) => new TextEncoder().encode(text);
for (const oversized of [false, true]) test(`cancel while ${oversized ? "discarding" : "holding"} cancels once without a rescue error`, async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let cancels = 0, pulls = 0;
  let requested!: () => void; const demand = new Promise<void>(resolve => { requested = resolve; });
  const source = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { pulls++; requested(); }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const reader = filterMessagesSseErrors(source).getReader();
  controller!.enqueue(encode("event: error\n"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event: error\n");
  controller!.enqueue(encode("data: " + (oversized ? "x".repeat(MESSAGES_SSE_ERROR_HOLD_BYTES) : SSE_SENTINEL)));
  const pending = reader.read();
  await demand; await reader.cancel("synthetic client cancellation");
  expect(await pending).toEqual({ value: undefined, done: true });
  expect(cancels).toBe(1); expect(pulls).toBeGreaterThan(0);
});
test("source rejection drops the held suffix without a delivered acknowledgment", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const reader = filterMessagesSseErrors(new ReadableStream<Uint8Array>({ start(c) { controller = c; } })).getReader();
  controller!.enqueue(encode("event: error\n")); await reader.read();
  controller!.enqueue(encode(`data: ${SSE_SENTINEL}`));
  const pending = reader.read(); controller!.error(new Error("synthetic reset"));
  await expect(pending).rejects.toThrow("synthetic reset");
});
test("ordinary events above 32 MiB retain the same chunk object, no classifier cap", () => {
  const filter = createMessagesSseErrorFilter();
  const raw = encode("event: ping\ndata: " + "x".repeat(33 * 1024 * 1024) + "\n\n");
  let count = 0;
  filter.push(raw, value => { count++; expect(value).toBe(raw); });
  expect(count).toBe(1);
});
test("many tiny fragments retain one bounded error copy and a second block starts cleanly", () => {
  const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
  const emit = (bytes: Uint8Array) => out.push(bytes);
  filter.push(encode("event: error\n"), emit);
  for (const byte of encode(`data: {"message":"${SSE_SENTINEL}"}\n`)) filter.push(new Uint8Array([byte]), emit);
  expect(Buffer.concat(out).toString()).toBe("event: error\n");
  filter.push(encode("\nevent: error\ndata: prompt is too long\n\n"), emit);
  const text = Buffer.concat(out).toString();
  expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(SSE_SENTINEL);
  expect(text).toContain("prompt is too long: The request exceeds the model's context window.");
});
test("repeated control fields count toward the hold and a later rename cannot undo over-limit", () => {
  const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
  const emit = (bytes: Uint8Array) => out.push(bytes);
  filter.push(encode("event: error\n"), emit);
  filter.push(encode(": " + "x".repeat(MESSAGES_SSE_ERROR_HOLD_BYTES - 3) + "\n"), emit);
  filter.push(encode("event: ping\n\n"), emit);
  const text = Buffer.concat(out).toString();
  expect(text).toContain('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"The provider stream reported an error."}}\n\n');
  expect(text.includes("ping")).toBe(false);
  expect(text.match(/^event: error$/gm)).toHaveLength(1);
});
test("registered product and an upstream exact copy take distinct paths", () => {
  const context = new MessagesSseFrameContext();
  const raw = encode(`\n\nevent: error\ndata: {"type":"error","error":{"type":"api_error","message":"${SSE_SENTINEL}"}}\n\n`);
  context.register(raw, { client: messagesSseLocalFrame("read", SSE_SENTINEL) });
  const owned: Uint8Array[] = [], upstream: Uint8Array[] = [];
  createMessagesSseErrorFilter(context).push(raw, bytes => owned.push(bytes));
  createMessagesSseErrorFilter(context).push(raw.slice(), bytes => upstream.push(bytes));
  expect(Buffer.concat(owned).toString()).toContain('"message":"anthropic passthrough upstream stream failed"');
  expect(Buffer.concat(upstream).toString()).toContain('"message":"The provider failed to complete the request."');
});
test("final error drops suffix control fields while preserving leading comments", () => {
  const raw = encode(`: leading comment\nevent:error\nid: ${SSE_SENTINEL}\nretry: ${SSE_SENTINEL}\n: ${SSE_SENTINEL}\nextension: ${SSE_SENTINEL}\nevent: error\ndata: {"message":"${SSE_SENTINEL}"}\n\n`);
  const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
  filter.push(raw, bytes => out.push(bytes));
  const text = Buffer.concat(out).toString();
  expect(text.length).toBeGreaterThan(0);
  expect(text.startsWith(": leading comment\nevent:error\ndata:")).toBe(true);
  expect(text.includes(SSE_SENTINEL)).toBe(false);
  expect(text.match(/^event: ?error$/gm)).toHaveLength(1);
});
for (const nl of ["\n", "\r", "\r\n"]) for (const space of ["", " "]) for (const data of ["", "data", "data:", "data: "]) {
  test(`empty-data fields: ${JSON.stringify({ nl, space, data })}`, () => {
    const raw = encode(`event:${space}error${nl}id: ${SSE_SENTINEL}${nl}${data ? data + nl : ""}: ${SSE_SENTINEL}${nl}event: error${nl}${nl}`);
    const out: Uint8Array[] = []; createMessagesSseErrorFilter().push(raw, bytes => out.push(bytes));
    const text = Buffer.concat(out).toString();
    expect(text.length).toBeGreaterThan(0);
    expect(text.includes(SSE_SENTINEL)).toBe(false);
    expect(text).toBe(`event:${space}error${nl}${data ? data + nl : ""}${nl}`);
  });
}
test("within-bound non-error rename retains suffix fields in original order", () => {
  const raw = encode(`event: error\nid: ${SSE_SENTINEL}\n: ${SSE_SENTINEL}\ndata: {}\nevent: ping\n\n`);
  const out: Uint8Array[] = []; createMessagesSseErrorFilter().push(raw, bytes => out.push(bytes));
  expect(Buffer.concat(out).length).toBeGreaterThan(0);
  expect(Buffer.concat(out)).toEqual(raw);
});
