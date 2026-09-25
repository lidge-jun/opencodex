import { describe, expect, test } from "bun:test";
import {
  createGrokUpstreamEnvelopeEchoBlockRewrite,
  responsesRequestMayReplayToolOutput,
  stripGrokUpstreamEnvelopeEchoFromResponsesJson,
} from "../../src/server/grok-upstream-envelope-echo";
import { repoPath } from "../helpers/repo-root";
import { relaySseWithBlockRewrite } from "../../src/server/sse-payload-rewrite";
import { ToolEnvelopeEchoFilter, stripToolEnvelopeEcho } from "../../src/lib/tool-envelope-echo-filter";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const frame = (type: string, fields: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

async function relay(input: string, onCompleted?: (response: Record<string, unknown>) => void) {
  const bytes = new TextEncoder().encode(input);
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const output = await new Response(relaySseWithBlockRewrite(
    body, createGrokUpstreamEnvelopeEchoBlockRewrite(onCompleted), createTestTranslatorBudget(),
  )).text();
  return output.split(/\n\n/).filter(Boolean).map(block => JSON.parse(block.split("\ndata: ")[1]!) as Record<string, unknown>);
}

const snapshot = (text: string) => ({
  id: "resp_echo", status: "completed", model: "grok-4.6",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
});

describe("xAI Responses upstream tool-envelope echoes", () => {
  test("split marker after prose is withheld from deltas, done, terminal and continuation", async () => {
    const raw = "Done.\n  [Tool Result]\nsecret\n";
    let cached: Record<string, unknown> | undefined;
    const events = await relay([
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Done.\n  [Tool " }),
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Result]\nsecret\n" }),
      frame("response.output_text.done", { output_index: 0, content_index: 0, text: raw }),
      frame("response.completed", { response: snapshot(raw) }),
    ].join(""), response => { cached = response; });
    const deltas = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
    expect(deltas).toBe("Done.\n");
    expect(events.find(event => event.type === "response.output_text.done")?.text).toBe(deltas);
    const completed = events.find(event => event.type === "response.completed")?.response;
    expect(completed).toEqual(snapshot(deltas));
    expect(cached).toEqual(snapshot(deltas));
  });

  test("false prefixes are emitted as prose and a harmless EOF suffix is flushed", async () => {
    const text = "[Tool usage] is documentation.\n[Tool ordinary prose\n[Too";
    const events = await relay([
      frame("response.output_text.delta", { delta: "[Tool" }),
      frame("response.output_text.delta", { delta: " usage] is documentation.\n[Tool" }),
      frame("response.output_text.delta", { delta: " ordinary prose\n[Too" }),
      frame("response.completed", { response: snapshot(text) }),
    ].join(""));
    expect(events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join(""))
      .toBe(text);
    expect(events.find(event => event.type === "response.completed")?.response).toEqual(snapshot(text));
  });

  // A marker inside a fenced code block is an example the model is showing, not an echo. Before
  // the fence was tracked, this whole answer was cut after its second line.
  test("markers inside a fenced code block are kept and an echo after the fence is still removed", async () => {
    const kept = "Here is the markdown:\n```text\n[Tool Result]\nvalid code\n```\n~~~\n[tool_result]\n~~~\n";
    const raw = `${kept}[Tool Result]\nsecret\n`;
    const events = await relay([
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Here is the markdown:\n``" }),
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: "`text\n[Tool Res" }),
      frame("response.output_text.delta", { output_index: 0, content_index: 0, delta: raw.slice("Here is the markdown:\n```text\n[Tool Res".length) }),
      frame("response.completed", { response: snapshot(raw) }),
    ].join(""));
    const deltas = events.filter(event => event.type === "response.output_text.delta").map(event => event.delta).join("");
    expect(deltas).toBe(kept);
    expect(events.find(event => event.type === "response.completed")?.response).toEqual(snapshot(kept));
  });

  test("truncated marker at EOF is removed from non-streaming JSON", () => {
    const result = JSON.parse(stripGrokUpstreamEnvelopeEchoFromResponsesJson(
      JSON.stringify(snapshot("Safe.\n[Tool Result")),
    ));
    expect(result).toEqual(snapshot("Safe.\n"));
  });

  test("a terminal [DONE] flushes a harmless partial prefix", () => {
    const rewrite = createGrokUpstreamEnvelopeEchoBlockRewrite();
    expect(rewrite(frame("response.output_text.delta", { delta: "[Too" }).trimEnd())).toEqual([]);
    const flushed = rewrite("data: [DONE]");
    expect(flushed).toHaveLength(2);
    expect(JSON.parse(flushed[0]!.split("\ndata: ")[1]!).delta).toBe("[Too");
    expect(flushed[1]).toBe("data: [DONE]");
  });
});

describe("ToolEnvelopeEchoFilter fenced code", () => {
  const fence = "\x60\x60\x60";
  const bothWays = (text: string): string => {
    const whole = stripToolEnvelopeEcho(text);
    const filter = new ToolEnvelopeEchoFilter();
    let split = "";
    for (const char of text) split += filter.feed(char);
    split += filter.finish();
    expect(split).toBe(whole);
    return whole;
  };

  test("a longer opener is closed only by a matching run, not by an inner shorter fence", () => {
    const text = "x\n\x60\x60\x60\x60md\n" + fence + "\n[Tool Result]\ncode\n" + fence + "\n\x60\x60\x60\x60\nafter";
    expect(bothWays(text)).toBe(text);
  });

  test("a fence line with an info string does not close the open block", () => {
    const text = "x\n" + fence + "\n" + fence + "js\n[Tool Result]\ncode\n" + fence + "\nafter";
    expect(bothWays(text)).toBe(text);
  });

  test("an echo pasted into a block that never closes is dropped from the marker line", () => {
    expect(bothWays(fence + "ts\nconst a = 1;\n[Tool Result]\nsecret")).toBe(fence + "ts\nconst a = 1;\n");
    expect(bothWays(fence + "ts\nconst a = 1;\n")).toBe(fence + "ts\nconst a = 1;\n");
  });

  test("an echo after a closed block is still removed", () => {
    expect(bothWays("a\n" + fence + "\ncode\n" + fence + "\n[Tool Result]\nsecret")).toBe("a\n" + fence + "\ncode\n" + fence + "\n");
  });

  test("a closing fence that ends the stream without a newline releases the held code", () => {
    const text = "Intro\n" + fence + "text\n[Tool Result]\nvalid code\n" + fence;
    expect(bothWays(text)).toBe(text);
  });

  test("a closed block settles an overflow even when the closer is what overflows the hold", () => {
    for (const filler of [65_519, 65_520, 65_521, 70_000]) {
      const text = fence + "\n[Tool Result]\n" + "x".repeat(filler) + "\n" + fence + "\n";
      const filter = new ToolEnvelopeEchoFilter();
      expect(filter.feed(text) + filter.finish()).toBe(text);
      expect(filter.unverifiedMarker).toBe(false);
    }
  });

  test("the hold inside a block is bounded and releases a long block as code", () => {
    const text = fence + "\n[Tool Result]\n" + "x".repeat(70_000) + "\n";
    const filter = new ToolEnvelopeEchoFilter();
    expect(filter.feed(text)).toBe(text);
    expect(filter.finish()).toBe("");
    expect(filter.matched).toBe(false);
    expect(filter.unverifiedMarker).toBe(true);
  });
});

describe("xAI echo filter arming", () => {
  // A first turn has never seen a replayed envelope, so its text is delivered untouched.
  test("arms only for a replayed tool output or a stored-conversation continuation", () => {
    expect(responsesRequestMayReplayToolOutput({ input: "hi" })).toBe(false);
    expect(responsesRequestMayReplayToolOutput({ input: [{ type: "message", role: "user", content: "hi" }] })).toBe(false);
    expect(responsesRequestMayReplayToolOutput({
      input: [{ type: "function_call", call_id: "c1", name: "exec", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }],
    })).toBe(true);
    expect(responsesRequestMayReplayToolOutput({ input: [{ type: "custom_tool_call_output", call_id: "c1", output: "ok" }] })).toBe(true);
    // A dangling call gets a synthetic output from the paired tool-result repair before it is sent.
    expect(responsesRequestMayReplayToolOutput({ input: [{ type: "function_call", call_id: "c1", name: "exec", arguments: "{}" }] })).toBe(true);
    expect(responsesRequestMayReplayToolOutput({ previous_response_id: "resp_1", input: "next" })).toBe(true);
    expect(responsesRequestMayReplayToolOutput(undefined)).toBe(false);
  });

  test("native passthrough delivery gates the filter on the request, not the host alone", async () => {
    const source = await Bun.file(repoPath("src/server/responses/passthrough-delivery.ts")).text();
    expect(source).toContain("isXaiResponsesDestination(route.provider)\n      && responsesRequestMayReplayToolOutput(parsed._rawBody)");
  });
});
