import { createHash } from "node:crypto";
export const SSE_SENTINEL = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
export const SSE_BASE = "895a859893147d3056ebd1881ec398ab03b037d2";
export const sseFrame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
export const sseStart = sseFrame("message_start", { type: "message_start", message: { id: "msg_fixture", role: "assistant", content: [], model: "wire-model", usage: { input_tokens: 5, output_tokens: 0 } } });
export const sseDone = sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) + sseFrame("message_stop", { type: "message_stop" });
export interface MessagesSseCase {
  id: string; kind: "error-block" | "non-error" | "rename" | "local" | "OVERSIZE-1M" | "FOLD-502";
  chunks: string[]; guard?: boolean; fault?: "read" | "read-overflow" | "stall" | "cap" | "cancel";
  fold?: boolean; echo?: boolean;
}
const data = JSON.stringify({ type: "error", error: { type: "api_error", message: SSE_SENTINEL, param: SSE_SENTINEL, code: SSE_SENTINEL }, request_id: SSE_SENTINEL, nested: { value: SSE_SENTINEL } });
const error = (id: string, payload: string): MessagesSseCase => ({ id, kind: "error-block", chunks: [`event: error\ndata: ${payload}\n\n`] });
export const messagesSseCases: MessagesSseCase[] = [
  error("sentinel-fields", data), error("unknown-type", JSON.stringify({ error: { type: SSE_SENTINEL, code: SSE_SENTINEL, message: SSE_SENTINEL } })),
  error("top-message", JSON.stringify({ message: `prompt is too long ${SSE_SENTINEL}`, error: { type: "request_too_large", code: "context_length_exceeded" } })),
  error("nested-message", JSON.stringify({ error: { type: "api_error", message: `prompt is too long ${SSE_SENTINEL}` } })),
  error("auditor-padded-debug", JSON.stringify({ message: "service unavailable", error: { type: "api_error" }, debug: "x".repeat(18 * 1024) + "prompt is too long" })),
  error("unrelated-phrase", '{"message":"service unavailable","debug":"prompt is too long"}'),
  error("duplicate-message-negative", '{"message":"prompt is too long","message":"service unavailable"}'),
  error("duplicate-message-positive", '{"message":"service unavailable","message":"prompt is too long"}'),
  error("malformed-phrase", `not JSON prompt is too long ${SSE_SENTINEL}`),
  error("escaped-phrase", '{"message":"pr\\u006fmpt is too long"}'),
  error("non-string-message", '{"message": {"nested": "input is too long for requested model"}, "debug": "unused"}'),
  error("string", '"prompt is too long"'), error("null", "null"), error("false", "false"), error("zero", "0"), error("empty-string", '""'),
  error("array", '["prompt is too long"]'), error("done", "[DONE]"), error("empty-data", ""),
  { id: "no-data", kind: "error-block", chunks: ["event: error\n\n"] },
  { id: "split-phrase", kind: "error-block", chunks: ['event: error\ndata: {"message":"PrOmPt Is ', 'ToO LoNg"}\n\n'] },
  { id: "comment-first", kind: "error-block", chunks: [": synthetic comment\n", ": another\n", "ev", "ent: error\n", `data: ${data}\n`, "\n"] },
  { id: "split-data-first", kind: "non-error", chunks: ['data: {"type":"error",\n', `data: "error":{"type":"api_error","message":"prompt is too long ${SSE_SENTINEL}"}}\n`, "event: error\n", "\n"] },
  { id: "auditor-round2-exact", kind: "non-error", chunks: ['data:{"debug":"prompt is too long",\n', 'event: error\n', 'data:"message":"service unavailable","type":"error","error":{"type":"api_error"}}\n', '\n'] },
  { id: "success", kind: "non-error", chunks: [sseStart, sseDone] },
  { id: "guard-relay", kind: "error-block", chunks: [`event: error\ndata: ${data}\n\n`], guard: true },
  { id: "guard-refusal", kind: "local", guard: true, chunks: [sseStart, sseFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fixture", name: SSE_SENTINEL } })] },
  { id: "tap-eof", kind: "local", chunks: [sseStart] },
  { id: "tap-stop-error", kind: "local", chunks: [sseStart, sseFrame("message_delta", { type: "message_delta", delta: { stop_reason: "error" } })] },
  { id: "tap-read", kind: "local", chunks: [sseStart], fault: "read" },
  { id: "tap-read-overflow", kind: "local", chunks: [sseStart], fault: "read-overflow" },
  { id: "tap-stall", kind: "local", chunks: [sseStart], fault: "stall" },
  { id: "tap-cap", kind: "local", chunks: [sseStart], fault: "cap" },
  { id: "cancel", kind: "non-error", chunks: [sseStart], fault: "cancel" },
];
for (const value of ['""', "null", "false", "0"]) messagesSseCases.push(error(`falsey-message-${value}`, `{"debug":"prompt is too long","message":${value}}`));
for (const nl of ["\n", "\r", "\r\n"]) for (const space of ["", " "]) {
  messagesSseCases.push({ id: `format-${JSON.stringify(nl)}-${space.length}`, kind: "error-block", chunks: [`event:${space}error${nl}data:${space}${data}${nl}${nl}`] });
}
for (const prefix of ["id: fixture", "retry: 1000", "event: ping", "event:", "event: errorX", "event:  error", "event: error ", "unknown", " ", "data: {}", ": after\nid: fixture"]) {
  messagesSseCases.push({ id: `excluded-${prefix}`, kind: "non-error", chunks: [prefix + "\n", "event: error\n", `data: ${data}\n\n`] });
}
for (const name of ["ping", "", "unknown"]) {
  messagesSseCases.push({ id: `rename-${name}`, kind: "rename", chunks: ["event: error\n", `data: ${data}\n`, `event: ${name}\n\n`] });
  messagesSseCases.push({ id: `oversize-rename-${name}`, kind: "OVERSIZE-1M", chunks: ["event: error\n", `data: ${"x".repeat(1024 * 1024)}\n`, `event: ${name}\n\n`] });
}
for (const [extra, kind] of [[-1, "error-block"], [0, "error-block"], [1, "OVERSIZE-1M"]] as const) {
  // Retained suffix counts the data field and its line ending, excluding the empty delimiter.
  const payload = '"prompt is too long ' + "x".repeat(1024 * 1024 + extra - 28) + '"';
  messagesSseCases.push({ id: `limit-${extra}`, kind, chunks: ["event: error\n", `data: ${payload}\n`, "\n"] });
}
for (const field of ["data: ", "id: ", "retry: "]) messagesSseCases.push({ id: `large-excluded-${field}`, kind: "non-error", chunks: [field + "x".repeat(1024 * 1024 + 1) + "\n", "event: error\n", `data: ${data}\n\n`] });
const echoData = (withError: boolean) => ({ type: "message_start", message: { model: "wire", usage: {} }, request_id: SSE_SENTINEL, ...(withError ? { error: { type: "api_error", message: SSE_SENTINEL } } : {}) });
for (const guard of [false, true]) for (const withError of [false, true]) {
  messagesSseCases.push({ id: `echo-${guard}-${withError}`, kind: "error-block", chunks: [sseFrame("error", echoData(withError))], guard, echo: true });
}
for (const prefix of ["data: {}\n", "id: fixture\n", "retry: 1\n", "event: ping\n"]) {
  messagesSseCases.push({ id: `echo-excluded-${prefix}`, kind: "non-error", chunks: [prefix + sseFrame("error", echoData(false))], echo: true });
}
messagesSseCases.push({ id: "echo-renamed-ping", kind: "rename", echo: true, chunks: ["event: error\nevent: ping\ndata: " + JSON.stringify(echoData(false)) + "\n\n"] });
for (const [id, payload] of [["fold-empty", ""], ["fold-malformed", "oops"], ["fold-scalar", "1"], ["fold-array", "[]"], ["fold-untyped", '{"message":"service unavailable"}'], ["fold-nonerror", '{"type":"ping"}']]) {
  messagesSseCases.push({ id: id!, kind: "FOLD-502", chunks: [`event: error\ndata: ${payload}\n\n`, sseStart, sseDone], fold: true });
}
export const messagesSseCaseHash = () => createHash("sha256").update(JSON.stringify(messagesSseCases)).digest("hex");
