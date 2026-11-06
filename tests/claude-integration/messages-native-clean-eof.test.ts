/**
 * A native Messages stream whose upstream ends cleanly (no reset) before the turn is over must
 * reach the client as a failure it can see, never as a finished partial answer. Covers the shared
 * stream tap (tapAnthropicSseForLog), the managed native lane end to end, and the non-stream fold.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { collectAnthropicMessage } from "../../src/claude/outbound";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { tapAnthropicSseForLog } from "../../src/server/messages-shared";
import { getRequestLogEntries, type RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const encoder = new TextEncoder();
const ev = (event: string, data: object) => "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
const start = ev("message_start", { type: "message_start", message: { id: "msg_eof", type: "message", role: "assistant", content: [], model: "claude-x", stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } });
const blockStart = ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
const delta = ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half an ans" } });
const blockStop = ev("content_block_stop", { type: "content_block_stop", index: 0 });
const md = (stopReason: string) => ev("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } });
const stop = ev("message_stop", { type: "message_stop" });
const ping = ev("ping", { type: "ping" });
const partial = start + blockStart + delta;
const ERROR_FRAME = "\n\nevent: error\ndata: ";

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
}

async function tap(raw: string | readonly string[], eofTolerant = false) {
  const calls: Array<{ status: number; [key: string]: unknown }> = [];
  const logCtx: RequestLogContext = { model: "claude-x", provider: "anth" };
  const out = tapAnthropicSseForLog(streamOf(typeof raw === "string" ? [raw] : raw), logCtx,
    (status, meta) => calls.push({ status, ...meta }), { stallMs: 5_000, maxBytes: 0, ...(eofTolerant ? { eofTolerant } : {}) });
  return { text: await new Response(out).text(), calls, logCtx };
}

// Expected verdict for each clean-EOF shape: "ok" = bytes relayed unchanged and a 200 terminal;
// "fail" = an Anthropic error event after the relayed bytes and a failed 502 row.
const CASES: Array<[string, string, boolean, "ok" | "fail"]> = [
  ["complete turn", partial + blockStop + md("end_turn") + stop, false, "ok"],
  ["upstream error event", partial + ev("error", { type: "error", error: { type: "overloaded_error", message: "busy" } }), false, "ok"],
  ["partial content", partial, false, "fail"],
  ["partial content with CRLF", partial.replace(/\n/g, "\r\n"), false, "fail"],
  ["delivered end_turn without message_stop", partial + blockStop + md("end_turn"), false, "ok"],
  ["delivered tool_use", start + md("tool_use"), false, "ok"],
  ["delivered refusal", start + md("refusal"), false, "ok"],
  ["delivered content_filter", start + md("content_filter"), false, "ok"],
  ["delivered max_tokens", partial + md("max_tokens"), false, "ok"],
  ["delivered stop_reason error", partial + md("error"), false, "fail"],
  ["tolerant + delivered stop_reason error", partial + md("error"), true, "fail"],
  ["tolerant + partial content", partial, true, "ok"],
  ["tolerant + delivered end_turn", start + md("end_turn"), true, "ok"],
  ["undelimited end_turn tail", partial + md("end_turn").slice(0, -2), false, "fail"],
  ["tolerant + undelimited stop_reason error tail", partial + md("error").slice(0, -2), true, "fail"],
  ["tolerant + undelimited end_turn tail", partial + md("end_turn").slice(0, -2), true, "fail"],
  ["delivered end_turn then a cut event", start + md("end_turn") + 'event: content_block_delta\ndata: {"type":"content_bl', false, "fail"],
  ["delivered end_turn then an undelimited keepalive comment", start + md("end_turn") + ": keepalive\n", false, "ok"],
  ["delivered end_turn then an undelimited ping", start + md("end_turn") + ping.slice(0, -2), false, "ok"],
  ["delivered end_turn then a ping", start + md("end_turn") + ping, false, "ok"],
  ["ping-named message_delta is not a stop reason", partial + ev("ping", { type: "message_delta", delta: { stop_reason: "end_turn" } }), false, "fail"],
  ["ping-named message_stop is not a terminal", partial + ev("ping", { type: "message_stop" }), false, "fail"],
  ["ping-named error is not a terminal", partial + ev("ping", { type: "error", error: {} }), false, "fail"],
  ["data-only stop reason", start + 'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n', false, "ok"],
  ["stop reason then resumed content", start + md("tool_use") + delta, false, "fail"],
  ["tolerant + stop reason then resumed content", start + md("tool_use") + delta, true, "ok"],
  ["delivered end_turn with CRLF", (partial + md("end_turn")).replace(/\n/g, "\r\n"), false, "ok"],
  ["delivered end_turn with CR-only line endings", (partial + md("end_turn")).replace(/\n/g, "\r"), false, "ok"],
  ["message_stop with CR-only line endings", (partial + md("end_turn") + stop).replace(/\n/g, "\r"), false, "ok"],
  ["last event field wins: message_stop then ping", partial + 'event: message_stop\nevent: ping\ndata: {"type":"message_stop"}\n\n', false, "fail"],
  ["last event field wins: ping then message_stop", partial + 'event: ping\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', false, "ok"],
  ["event name with a trailing space is another event", partial + 'event: message_stop \ndata: {"type":"message_stop"}\n\n', false, "fail"],
  ["event name with an extra leading space is another event", partial + 'event:  message_stop\ndata: {"type":"message_stop"}\n\n', false, "fail"],
  ["stop reason under a trailing-space event name does not count", partial + 'event: message_delta \ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n', false, "fail"],
  ["data lines split inside a JSON string are invalid JSON", partial + 'event: message_stop\ndata: {"type":"message_\ndata: stop"}\n\n', false, "fail"],
  ["data lines split at JSON whitespace still parse", partial + 'event: message_stop\ndata: {"type":\ndata: "message_stop"}\n\n', false, "ok"],
  ["empty body", "", false, "fail"],
];

describe("clean upstream EOF in the native Messages stream tap", () => {
  for (const [name, raw, tolerant, verdict] of CASES) {
    test(name + " -> " + verdict, async () => {
      const { text, calls, logCtx } = await tap(raw, tolerant);
      if (verdict === "ok") {
        expect(text).toBe(raw);
        expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
        return;
      }
      expect(text.startsWith(raw)).toBe(true);
      const frame = text.slice(raw.length);
      expect(frame.startsWith(ERROR_FRAME)).toBe(true);
      expect(JSON.parse(frame.slice(ERROR_FRAME.length).trim())).toMatchObject({ type: "error", error: { type: "api_error" } });
      expect(calls).toEqual([{ status: 502, terminalStatus: "failed", closeReason: "terminal" }]);
      expect(logCtx.transportPhase).toBe("mid_stream");
      expect(logCtx.terminalSource).toBe("synthetic");
      expect(logCtx.upstreamError).toBeTruthy();
    });
  }

  test("message_stop left undelimited at EOF still ends the turn and gets its blank line back", async () => {
    const raw = partial + blockStop + md("end_turn") + stop.slice(0, -2);
    const { text, calls } = await tap(raw);
    expect(text).toBe(raw + "\n\n");
    expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  });

  test("a CRLF split across reads is still one line ending", async () => {
    const crlf = (partial + md("end_turn")).replace(/\n/g, "\r\n");
    const at = crlf.lastIndexOf("\r\n\r\n") + 1;
    const { calls } = await tap([crlf.slice(0, at), crlf.slice(at)]);
    expect(calls).toEqual([{ status: 200, closeReason: "terminal" }]);
  });

  test("usage observed before the cut is kept on the failed turn", async () => {
    const { logCtx, calls } = await tap(partial);
    expect(calls[0]!.status).toBe(502);
    expect(logCtx.usage).toEqual(expect.objectContaining({ inputTokens: 5 }));
  });

  test("a read that resolves done after the client aborted is a cancel, not a cut upstream", async () => {
    const abort = new AbortController();
    let sent = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) { abort.abort(); controller.close(); return; }
        sent = true;
        controller.enqueue(encoder.encode(partial));
      },
    });
    const calls: Array<{ status: number; [key: string]: unknown }> = [];
    const logCtx: RequestLogContext = { model: "claude-x", provider: "anth" };
    // Keep the abort listener from winning: the done read must classify the cancel itself.
    const reqSignal = { get aborted() { return abort.signal.aborted; }, reason: undefined, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    const text = await new Response(tapAnthropicSseForLog(source, logCtx, (status, meta) => calls.push({ status, ...meta }), { stallMs: 0, maxBytes: 0, reqSignal })).text();
    expect(text).toBe(partial);
    expect(calls).toEqual([{ status: 499, closeReason: "client_cancel" }]);
  });
});

describe("non-stream fold of Messages SSE", () => {
  const fold = (chunks: readonly string[]) => collectAnthropicMessage(streamOf(chunks), "claude-x", createTestTranslatorBudget());

  test("CRLF frames fold with their content and stop reason", async () => {
    const message = await fold([(partial + blockStop + md("tool_use") + stop).replace(/\n/g, "\r\n")]);
    expect(message).toMatchObject({ type: "message", stop_reason: "tool_use", content: [{ type: "text", text: "half an ans" }] });
  });

  test("a CRLF split across reads folds the same way", async () => {
    const crlf = (partial + blockStop + md("end_turn") + stop).replace(/\n/g, "\r\n");
    const at = crlf.indexOf("\r\n\r\n") + 1;
    const message = await fold([crlf.slice(0, at), crlf.slice(at)]);
    expect(message).toMatchObject({ type: "message", content: [{ type: "text", text: "half an ans" }] });
  });

  test("data-only frames are named by their payload type", async () => {
    const dataOnly = (partial + blockStop + md("tool_use") + stop).replace(/^event: .*\n/gm, "");
    const message = await fold([dataOnly]);
    expect(message).toMatchObject({ type: "message", stop_reason: "tool_use", content: [{ type: "text", text: "half an ans" }] });
  });

  test("a final frame delimited by CR alone still folds", async () => {
    const message = await fold([(partial + blockStop + md("tool_use")).replace(/\n/g, "\r")]);
    expect(message).toMatchObject({ type: "message", stop_reason: "tool_use", content: [{ type: "text", text: "half an ans" }] });
  });
});

// --- Managed native lane, end to end against a local fake upstream ---

let upstream: ReturnType<typeof Bun.serve> | undefined;
let releaseSpendHome: (() => void) | undefined;
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-eof-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  clearKeyCooldowns();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

/** An upstream that answers with the given SSE body and then ends it cleanly. */
function cleanEofUpstream(body: string, eofTolerance = false): OcxConfig {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    await req.json();
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  } });
  releaseSpendHome ??= acquireOwnedSpendHome();
  const config = {
    port: 0,
    defaultProvider: "anth",
    providers: { anth: {
      adapter: "anthropic", baseUrl: "http://127.0.0.1:" + upstream.port, authMode: "key", apiKey: "fixture-key-alpha",
      allowPrivateNetwork: true, models: ["claude-x"], ...(eofTolerance ? { anthropicEofTolerance: true } : {}),
    } },
    protocols: { rollout: { managedMessagesNative: true } },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function send(config: OcxConfig, stream: boolean) {
  const requestId = "eof-" + crypto.randomUUID();
  const request = new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anth/claude-x", max_tokens: 64, stream, messages: [{ role: "user", content: "fixture question" }] }),
  });
  const response = await handleClaudeMessages(request, config, { model: "", provider: "" }, { requestId, start: Date.now() });
  const text = await response.text();
  for (let i = 0; i < 100 && !getRequestLogEntries().some(entry => entry.requestId === requestId); i++) await Bun.sleep(10);
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return { response, text, row: rows[0]! };
}

describe("managed native Messages lane with a clean upstream EOF", () => {
  test("a streamed turn cut before message_stop ends with an Anthropic error event and a failed row", async () => {
    const { response, text, row } = await send(cleanEofUpstream(partial), true);
    expect(response.status).toBe(200);
    expect(text).toContain("half an ans");
    expect(text).toContain(ERROR_FRAME);
    expect(text).toContain("anthropic passthrough upstream stream ended before message_stop");
    expect(row.status).toBe(502);
    expect(row.terminalStatus).toBe("failed");
    expect(row.transportPhase).toBe("mid_stream");
    expect(row.attempts?.at(-1)?.streamAborted).toBe(true);
    expect(JSON.stringify(row)).not.toContain("fixture-key-alpha");
  });

  test("a non-streaming caller gets an Anthropic 502, never the partial message", async () => {
    const { response, text, row } = await send(cleanEofUpstream(partial), false);
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(text).not.toContain("half an ans");
    expect(row.status).toBe(502);
  });

  test("a complete stop reason without message_stop is relayed as the finished turn", async () => {
    const body = partial + blockStop + md("end_turn");
    const { response, text, row } = await send(cleanEofUpstream(body), true);
    expect(response.status).toBe(200);
    expect(text).not.toContain("event: error");
    expect(row.status).toBe(200);
  });

  test("an upstream error event stays the only terminal", async () => {
    const body = partial + ev("error", { type: "error", error: { type: "overloaded_error", message: "busy" } });
    const { text } = await send(cleanEofUpstream(body), true);
    expect(text.split("event: error").length - 1).toBe(1);
    expect(text).toContain("overloaded_error");
  });

  test("a provider with anthropicEofTolerance keeps a content-only EOF as it was", async () => {
    const { response, text, row } = await send(cleanEofUpstream(partial, true), true);
    expect(response.status).toBe(200);
    expect(text).not.toContain("event: error");
    expect(row.status).toBe(200);
  });
});
