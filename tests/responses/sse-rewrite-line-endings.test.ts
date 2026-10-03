import { describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { ServerWebSocket } from "bun";
import { createSseInspector, createSseTerminalOutputBoundary } from "../../src/server/relay";
import { createRoutedCustomToolRestoreBlockRewrite } from "../../src/server/responses-custom-tool-repair";
import { createGithubCopilotResponsesBlockRewrite } from "../../src/server/github-copilot-responses-repair";
import { createGrokResponsesSparseTerminalBlockRewrite, GROK_REFUSED_TERMINAL_EVENT_TYPE } from "../../src/server/grok-responses-snapshot-repair";
import { createGrokResponsesControlFrameBlockRewrite } from "../../src/server/grok-responses-control-frame";
import { pumpResponsesSseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import { decodeServerSentEvents } from "../../src/lib/sse-decoder";
import { BoundedSseFrameBuffer, joinSseFrameBytes, SseFrameTooLargeError } from "../../src/server/sse-frame-buffer";
import { createSseBlockBuffer, nextSseBlock, relaySseWithBlockRewrite, replaceSseDataPayload, sseDataPayload } from "../../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { readAll } from "../helpers/sse-stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function source(chunks: string[]) {
  return new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  } });
}
const delimiters = ["\n\n", "\n\r", "\n\r\n", "\r\r", "\r\r\n", "\r\n\n", "\r\n\r", "\r\n\r\n"];

describe("shared SSE line ending contract", () => {
  test.each(delimiters)("frames %j without splitting a single CRLF", delimiter => {
    expect(nextSseBlock(`event: x\r\ndata: one${delimiter}next`)).toEqual({
      block: "event: x\r\ndata: one", delimiter, rest: "next",
    });
    expect(nextSseBlock("data: one\r\n")).toBeNull();
  });
  test.each(["\n", "\r", "\r\n"])("reads and rewrites fields with %j lines", newline => {
    const block = [": ignored", "event: update", "data", "data:  first", "data:\tsecond", "data", "database: ignored"].join(newline);
    expect(sseDataPayload(block)).toBe("\n first\n\tsecond\n");
    expect(replaceSseDataPayload(block, "one\rtwo\r\nthree\nfour")).toBe(
      [": ignored", "event: update", "data: one", "data: two", "data: three", "data: four", "database: ignored"].join(newline),
    );
    expect(replaceSseDataPayload(block, sseDataPayload(block)!)).toBe(block);
  });
  test("identity replacement keeps mixed field wire bytes", () => {
    const block = ": comment\revent: update\r\ndata\ndata:one\rdata: two\r\nid: fixture";
    expect(sseDataPayload(block)).toBe("\none\ntwo");
    expect(replaceSseDataPayload(block, "\none\ntwo")).toBe(block);
  });
  test.each(delimiters)("preserves %j identity bytes and decoder events at every split", async delimiter => {
    const wire = `: ignored\revent: first\r\ndata: one${delimiter}data: two\rdata: three${delimiter}data: tail`;
    const expected = [{ event: "first", data: "one" }, { data: "two\nthree" }, { data: "tail" }];
    for (let split = 0; split <= wire.length; split++) {
      const chunks = [wire.slice(0, split), wire.slice(split)];
      const budget = createTestTranslatorBudget();
      const output = await readAll(relaySseWithBlockRewrite(source(chunks), block => [block], budget));
      expect(output).toBe(wire);
      expect(budget.snapshot().currentBytes).toBe(0);
      const decoded = [];
      for await (const record of decodeServerSentEvents(source([output]), { translatorBudget: budget })) decoded.push(record);
      expect(decoded).toEqual(expected);
      expect(budget.snapshot().currentBytes).toBe(0);
    }
  });
  test("does not dispatch a split CRLF as a blank line", () => {
    const budget = createTestTranslatorBudget();
    const buffer = createSseBlockBuffer(budget);
    buffer.append("data: first\r");
    expect(buffer.next()).toBeNull();
    buffer.append("\ndata: second\r\n");
    expect(buffer.next()).toBeNull();
    buffer.append("\r");
    expect(sseDataPayload(buffer.next()!.block)).toBe("first\nsecond");
    buffer.append("\n");
    expect(buffer.next()).toBeNull();
    buffer.clear();
    expect(budget.snapshot().currentBytes).toBe(0);
  });
  test("a late LF is reconciled before delimiter scanning without an empty callback", async () => {
    const budget = createTestTranslatorBudget();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const seen: string[] = [];
    const reader = relaySseWithBlockRewrite(upstream, block => { seen.push(block); return [block]; }, budget).getReader();
    try {
      controller.enqueue(encoder.encode("data: one\r\r"));
      expect(decoder.decode((await reader.read()).value)).toBe("data: one\r\r");
      controller.enqueue(encoder.encode("\n\n"));
      expect(decoder.decode((await reader.read()).value)).toBe("\n");
      expect(seen).toEqual(["data: one"]);
      expect(budget.snapshot().currentBytes).toBe(1); // The second LF still belongs to the input buffer.
      controller.enqueue(encoder.encode("data: two\n\n"));
      expect(decoder.decode((await reader.read()).value)).toBe("\ndata: two\n\n");
      expect(seen).toEqual(["data: one", "\ndata: two"]);
    } finally {
      await reader.cancel();
      expect(budget.snapshot().currentBytes).toBe(0);
    }
  });

  test("incremental delimiter search and byte counts stay linear for CR fragments", () => {
    const budget = createTestTranslatorBudget();
    const buffer = createSseBlockBuffer(budget);
    const fragments = ["data: ", ...Array.from({ length: 256 }, () => "x".repeat(128)), "\r", "\r"];
    const originalExec = RegExp.prototype.exec;
    const originalByteLength = Buffer.byteLength;
    let scanned = 0;
    let counted = 0;
    const exec = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, text) {
      if (this.source === "(?:\\r\\n|\\r(?!\\n)|\\n){2}") scanned += text.length - this.lastIndex;
      return originalExec.call(this, text);
    });
    const byteLength = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (typeof value === "string") counted += value.length;
      return originalByteLength(value, encoding);
    });
    try {
      for (const fragment of fragments) { buffer.append(fragment); buffer.next(); }
      expect(scanned).toBeLessThan(fragments.join("").length * 2);
      expect(counted).toBeLessThan(fragments.join("").length * 3);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally { exec.mockRestore(); byteLength.mockRestore(); buffer.clear(); }
  });
  test.each(["\r\r", "\n\r", "\r\n\r"])("byte framing preserves %j and split CRLF at the exact cap", delimiter => {
    const framer = new BoundedSseFrameBuffer(8);
    const chunks = ["12345678" + delimiter, "\nabcdefgh\r\r", "\n"];
    const frames = chunks.flatMap(chunk => framer.feed(encoder.encode(chunk)));
    const tail = framer.finish();
    expect(decoder.decode(joinSseFrameBytes([...frames.flatMap(frame => [frame.block, frame.delimiter]), tail]))).toBe(chunks.join(""));
    expect(frames.filter(frame => frame.block.length).map(frame => decoder.decode(frame.block))).toEqual(["12345678", "abcdefgh"]);
    const oversized = new BoundedSseFrameBuffer(8);
    expect(() => oversized.feed(encoder.encode("123456789" + delimiter))).toThrow(SseFrameTooLargeError);
  });
  test.each(["\r", "\n", "\r\n"])("inspection and WebSocket delivery agree on %j fields", async newline => {
    const terminal = { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [] } };
    const wire = `: ignored${newline}event: response.completed${newline}data: ${JSON.stringify(terminal)}${newline}${newline}`;
    const observed: string[] = [];
    const inspector = createSseInspector({ onTerminal: status => observed.push(status) });
    for (const char of wire) inspector.feed(encoder.encode(char));
    expect(inspector.terminalSeen()).toBe(true);
    expect(observed).toEqual(["completed"]);
    inspector.dispose();
    const sent: string[] = [];
    const ws = { readyState: 1, data: {} as WsData, send(message: string) { sent.push(message); return 1; } } as unknown as ServerWebSocket<WsData>;
    await pumpResponsesSseToWebSocket(ws, source([...wire]));
    expect(sent.map(text => JSON.parse(text))).toEqual([terminal]);
  });

  test.each(["\r", "\n", "\r\n"])("event-field repairs preserve %j payloads with or without a leading comment", newline => {
    for (const prefix of ["", `: ignored${newline}`]) {
      const block = (type: string, fields: Record<string, unknown>) =>
        `${prefix}event: ${type}${newline}data: ${JSON.stringify({ type, ...fields })}`;
      const policy = createSseTerminalOutputBoundary();
      const failed = decoder.decode(policy.feed(encoder.encode(block("error", {
        code: "cyber_policy", message: "fixture rejection",
      }) + newline + newline)));
      expect(JSON.parse(sseDataPayload(nextSseBlock(failed)!.block)!)).toMatchObject({
        type: "response.failed", response: { error: { code: "cyber_policy" } },
      });
      expect(policy.terminalSeen()).toBe(true);
      policy.dispose();

      const custom = createRoutedCustomToolRestoreBlockRewrite(new Set(["exec"]), undefined, new Set(), new Set(["exec"]));
      const copilot = createGithubCopilotResponsesBlockRewrite(createTestTranslatorBudget());
      const grok = createGrokResponsesSparseTerminalBlockRewrite(createTestTranslatorBudget(), { tools: [], tool_choice: "none" });
      try {
        custom(block("response.output_item.added", { output_index: 0,
          item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "exec", arguments: "" } }));
        const done = custom(block("response.function_call_arguments.done", {
          output_index: 0, item_id: "fc_fixture", arguments: '{"input":"text(1)"}',
        }))[0]!;
        expect(JSON.parse(sseDataPayload(done)!)).toMatchObject({ type: "response.custom_tool_call_input.done", input: "text(1)" });
        expect(done.split(/\r\n|\r|\n/)).toContain("event: response.custom_tool_call_input.done");

        const repaired = copilot(block("response.created", { obfuscation: "padding", response: { id: "resp_fixture" } }))[0]!;
        expect(JSON.parse(sseDataPayload(repaired)!)).toMatchObject({ type: "response.created", response: { id: "resp_fixture" } });
        expect(sseDataPayload(repaired)).not.toContain("obfuscation");

        grok(block("response.output_item.done", { output_index: 0,
          item: { type: "function_call", id: "fc_other", call_id: "call_other", name: "other", arguments: "{}" } }));
        const refused = grok(block("response.completed", { response: { id: "resp_fixture", status: "completed", output: [] } }))[0]!;
        expect(JSON.parse(sseDataPayload(refused)!)).toMatchObject({ type: GROK_REFUSED_TERMINAL_EVENT_TYPE, response: { status: "incomplete" } });
        expect(refused.split(/\r\n|\r|\n/)).toContain(`event: ${GROK_REFUSED_TERMINAL_EVENT_TYPE}`);
        expect(createGrokResponsesControlFrameBlockRewrite()(`${prefix}event: codex.rate_limits${newline}data: {}`)).toEqual([]);
      } finally { custom.dispose?.(); copilot.dispose?.(); grok.dispose?.(); }
    }
  });

});
