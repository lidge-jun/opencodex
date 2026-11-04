import { expect, spyOn, test } from "bun:test";
import { createMessagesSseErrorFilter } from "../../src/server/messages-sse-error-filter";
import { MessagesSseFrameContext, messagesSseFrameHooks, MESSAGES_SSE_ERROR_HOLD_BYTES } from "../../src/lib/messages-sse-error-presentation";
import { pinnedMessagesObservation } from "../helpers/messages-sse-observer";
import { messagesSseCases, SSE_SENTINEL } from "../helpers/messages-sse-cases";
const encode = (text: string) => new TextEncoder().encode(text);
const generic = '{"type":"error","error":{"type":"api_error","message":"The provider failed to complete the request."}}';
const run = (chunks: Uint8Array[]) => {
  const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
  for (const chunk of chunks) filter.push(chunk, bytes => out.push(bytes));
  filter.finish(bytes => out.push(bytes));
  return out;
};
// INV-MESSAGES-SSE-01: immutable first-field gate; no possible-prefix delay.
for (const input of messagesSseCases.filter(row => !row.fold && !row.fault && !row.echo && !row.guard)) test(`client boundary: ${input.id}`, () => {
  const original = encode(input.chunks.join(""));
  const out = Buffer.concat(run(input.chunks.map(encode)));
  expect(out.length).toBeGreaterThan(0);
  if (input.kind === "non-error" || input.kind === "rename") expect(out).toEqual(original);
  else if (input.kind === "error-block") {
    expect(out.includes(SSE_SENTINEL)).toBe(false);
    expect(pinnedMessagesObservation(out).clientRecognizes).toBe(pinnedMessagesObservation(original).clientRecognizes);
  } else if (input.kind === "OVERSIZE-1M") {
    expect(out.includes('"message":"The provider stream reported an error."')).toBe(true);
    expect(pinnedMessagesObservation(out).clientRecognizes).toBe(false);
  }
});
for (const field of ["event: ping", "event: errorX", "event: error ", "event:", "data: {}", "id: x", "retry: 1", " ", "unknown"]) test(`every prefix split relays immediately: ${field}`, () => {
  const raw = encode(field + "\r\ndata: {}\r\nevent: error\r\n\r\n");
  for (let split = 1; split < raw.length; split++) {
    const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
    const first = raw.subarray(0, split), last = raw.subarray(split);
    filter.push(first, bytes => out.push(bytes));
    expect(out).toHaveLength(1); expect(out[0]).toBe(first);
    filter.push(last, bytes => out.push(bytes));
    expect(out).toHaveLength(2); expect(out[1]).toBe(last);
  }
});
test("eligible declaration prefixes are public at every byte and split CRLF stays one ending", () => {
  const filter = createMessagesSseErrorFilter(); const out: Uint8Array[] = [];
  const prefix = ": comment\r\nevent: error\r\n";
  for (const char of prefix) {
    const bytes = encode(char); const before = out.length;
    filter.push(bytes, chunk => out.push(chunk));
    expect(out.length).toBe(before + 1); expect(out.at(-1)).toBe(bytes);
  }
  filter.push(encode(`data: {"error":{"message":"${SSE_SENTINEL}"}}\r\n`), bytes => out.push(bytes));
  expect(Buffer.concat(out).toString()).toBe(prefix);
  filter.push(encode("\r\n"), bytes => out.push(bytes));
  const text = Buffer.concat(out).toString();
  expect(text.includes(SSE_SENTINEL)).toBe(false);
  expect(text.startsWith(prefix + "data: ")).toBe(true);
  expect(pinnedMessagesObservation(encode(text)).events).toHaveLength(1);
});
test("closed formatting variants have exact independently authored bytes", () => {
  for (const nl of ["\n", "\r", "\r\n"]) for (const space of ["", " "]) {
    const raw = `event:${space}error${nl}data: {"message":"opaque"}${nl}${nl}`;
    expect(Buffer.concat(run([encode(raw)])).toString()).toBe(`event:${space}error${nl}data:${space}${generic}${nl}${nl}`);
  }
});
test("EOF does not create a dispatch, empty error does dispatch the generic APIError", () => {
  for (const suffix of ["data: oops", "data: oops\n", "data: oops\nevent: ping"]) {
    const text = Buffer.concat(run([encode("event: error\n" + suffix)]));
    expect(pinnedMessagesObservation(text).events).toHaveLength(0);
  }
  const empty = Buffer.concat(run([encode("event: error\n\n")]));
  expect(empty.toString()).toBe("event: error\n\n");
  expect(pinnedMessagesObservation(empty).events[0]?.diagnostic).toBe("(no status code or body)");
});
test("BOM and delimiter reset obey the stream-start decoder", () => {
  const text = Buffer.concat(run([encode("\ufeffevent: error\ndata: oops\n\nid: x\nevent: error\ndata: kept\n\n")]));
  expect(text.toString().startsWith("\ufeffevent: error\ndata: " + generic)).toBe(true);
  expect(text.toString().endsWith("id: x\nevent: error\ndata: kept\n\n")).toBe(true);
});
test("only construction identity can carry a local frame or echo flag", () => {
  const context = new MessagesSseFrameContext(); const hooks = messagesSseFrameHooks(context);
  const input = encode("event: message_start\ndata: {}\n\n");
  const origin = { echoRenamedError: true as const };
  context.register(input, origin); hooks.input(input, true);
  const output = input.slice(); hooks.output(new TextDecoder().decode(input), output);
  expect(context.take(output)).toBe(origin); expect(context.take(input)).toBeUndefined();
  expect(context.take(input.slice())).toBeUndefined();
  context.register(input, origin); hooks.input(input, true);
  expect(() => hooks.output("event: ping\n\n", output)).toThrow("The proxy could not reach or read the provider.");
  expect(context.take(output)).toBeUndefined();
});
test("failed enqueue disposes held bytes and emits no rescue frame", () => {
  const filter = createMessagesSseErrorFilter();
  filter.push(encode("event: error\n"), () => {});
  filter.push(encode("data: " + "x".repeat(MESSAGES_SSE_ERROR_HOLD_BYTES - 6)), () => {});
  let calls = 0;
  expect(() => filter.push(encode("\n\n"), () => { calls++; throw new Error("closed"); })).toThrow("closed");
  expect(calls).toBe(1);
  filter.dispose();
});

test("complete-frame identity keeps only a finite digest of a large legacy product", () => {
  const context = new MessagesSseFrameContext(), hooks = messagesSseFrameHooks(context);
  const text = '\n\nevent: error\ndata: {"message":"' + "x".repeat(2 * MESSAGES_SSE_ERROR_HOLD_BYTES) + '"}\n\n';
  const bytes = encode(text), client = encode('\n\nevent: error\ndata: {"type":"error"}\n\n');
  context.register(bytes, { client });
  const originalDecode = TextDecoder.prototype.decode;
  const sizes: number[] = [];
  const decode = spyOn(TextDecoder.prototype, "decode").mockImplementation(function(this: TextDecoder, input, options) {
    sizes.push(input?.byteLength ?? 0); return originalDecode.call(this, input, options);
  });
  try { hooks.input(bytes, true); } finally { decode.mockRestore(); }
  expect(sizes.every(size => size < 1024)).toBe(true);
  hooks.output("\n\n", encode("\n\n"));
  const output = encode(text.slice(2)); hooks.output(text.slice(2), output);
  expect(context.take(output)).toEqual({ client: client.subarray(2) });
});
