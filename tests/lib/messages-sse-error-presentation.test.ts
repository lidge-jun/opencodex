import { expect, test } from "bun:test";
import { messagesRelayedOverflowPresentation, messagesSseErrorOverflowPresentation } from "../../src/lib/messages-error-body";
import { messagesSseErrorPayload, messagesSseOversizePayload, messagesSseEchoRenamedError } from "../../src/lib/messages-sse-error-presentation";
import { pinnedMessagesObservation } from "../helpers/messages-sse-observer";
import { messagesSseCases, SSE_SENTINEL } from "../helpers/messages-sse-cases";
const bytes = (value: string) => new TextEncoder().encode(value);
for (const input of messagesSseCases.filter(row => row.kind === "error-block" && !row.echo && !row.guard)) test(`full diagnostic selection: ${input.id}`, () => {
  const raw = input.chunks.join("");
  const base = pinnedMessagesObservation(bytes(raw));
  const data = base.events.find(row => row.event === "error")?.data;
  if (data === undefined) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { parsed = undefined; }
  expect(messagesSseErrorOverflowPresentation(data, parsed)).toBe(base.clientRecognizes);
  if (data === "") return;
  const payload = messagesSseErrorPayload(data);
  expect(payload.length).toBeGreaterThan(0);
  expect(payload.includes(SSE_SENTINEL)).toBe(false);
  expect(pinnedMessagesObservation(bytes(`event: error\ndata: ${payload}\n\n`)).clientRecognizes).toBe(base.clientRecognizes);
});
test("buffered caller keeps its distinct falsey parsed fallback", () => {
  for (const value of [null, false, 0, ""]) {
    expect(messagesRelayedOverflowPresentation("prompt is too long", value)).toBe(true);
    expect(messagesSseErrorOverflowPresentation("false", value)).toBe(false);
  }
});
test("SSE fallback has a status-independent closed type and literal code", () => {
  expect(JSON.parse(messagesSseErrorPayload('{"error":{"type":"unknown","code":"unknown"}}')).error.type).toBe("api_error");
  expect(JSON.parse(messagesSseErrorPayload('{"error":{"type":"billing_error","code":"rate_limit_exceeded"}}')).error).toEqual({ type: "billing_error", code: "rate_limit_exceeded", message: "The provider rate limit was reached; retry later." });
});
test("a non-object error member falls back to the top-level type and code", () => {
  for (const nested of ["null", "\"x\"", "1", "[]"]) {
    const error = JSON.parse(messagesSseErrorPayload('{"type":"rate_limit_error","code":"rate_limit_exceeded","error":' + nested + '}')).error;
    expect(error.type).toBe("rate_limit_error");
    expect(error.code).toBe("rate_limit_exceeded");
  }
});
test("OVERSIZE-1M has the independently authored exact fixed output", () => {
  expect(messagesSseOversizePayload()).toBe('{"type":"error","error":{"type":"api_error","message":"The provider stream reported an error."}}');
});
test("echo provenance requires the first field and effective final name", () => {
  expect(messagesSseEchoRenamedError(": comment\nevent:error\ndata:{}\n\n")).toBe(true);
  for (const prefix of ["id: x\n", "retry: 1\n", "data: {}\n", "event: ping\n", " \n"]) expect(messagesSseEchoRenamedError(prefix + "event:error\ndata:{}\n\n")).toBe(false);
  for (const suffix of ["event:ping", "event:", "event:error "]) expect(messagesSseEchoRenamedError("event:error\n" + suffix + "\ndata:{}\n\n")).toBe(false);
});

test("pinned recognition stops at the first thrown named error", () => {
  const first = 'event: error\ndata: {"message":"service unavailable"}\n\n';
  const second = 'event: error\ndata: {"message":"prompt is too long"}\n\n';
  expect(pinnedMessagesObservation(bytes(first + second)).clientRecognizes).toBe(false);
  expect(pinnedMessagesObservation(bytes(second + first)).clientRecognizes).toBe(true);
});
