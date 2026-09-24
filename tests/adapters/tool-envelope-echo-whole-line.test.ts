import { describe, expect, test } from "bun:test";
import { ToolEnvelopeEchoFilter, stripToolEnvelopeEcho } from "../../src/lib/tool-envelope-echo-filter";
import { stripGrokUpstreamEnvelopeEchoFromResponsesJson } from "../../src/server/grok-upstream-envelope-echo";
import { stripAssistantEchoedToolEnvelope } from "../../src/adapters/cursor/envelope-echo";

// The replayed envelope is a marker alone on its line. An answer line that only STARTS with a
// marker is prose and must reach the client whole, on the live filter (streamed and buffered),
// the xAI Responses JSON path and the Cursor history replay stripper.
function streamed(text: string): string {
  const filter = new ToolEnvelopeEchoFilter();
  let out = "";
  for (const char of text) out += filter.feed(char);
  return out + filter.finish();
}

function bothWays(text: string): string {
  const whole = stripToolEnvelopeEcho(text);
  expect(streamed(text)).toBe(whole);
  return whole;
}

const FENCE = "\x60\x60\x60";

describe("whole-line echo markers", () => {
  test("prose that starts with a marker survives with everything after it", () => {
    const text = "Here is the log:\n[Tool Result] shows the build passed.\nNext steps follow.\n";
    expect(bothWays(text)).toBe(text);
    expect(bothWays("[Tool Error] means the call failed, as explained below.\nMore.")).toBe("[Tool Error] means the call failed, as explained below.\nMore.");
  });

  test("a marker alone on its line still drops the echoed tail", () => {
    expect(bothWays("Done.\n[Tool Result]\nsecret\n")).toBe("Done.\n");
    expect(bothWays("Done.\n  [tool_result]\ncall_id: c1\n")).toBe("Done.\n");
  });

  test("CRLF and trailing whitespace after a marker are still a whole-line marker", () => {
    expect(bothWays("Done.\r\n[Tool Result]\r\nsecret")).toBe("Done.\r\n");
    expect(bothWays("Done.\n[Tool Result]   \nsecret")).toBe("Done.\n");
  });

  test("a [Tool call: line keeps its prefix rule, including a call whose arguments wrap", () => {
    expect(bothWays("[Tool call: read (call_id: c1) with args: {}]\nsecret")).toBe("");
    expect(bothWays("Done.\n[Tool call: Glob (call_id: c2) with args: {\n  \"a\": 1\n}]")).toBe("Done.\n");
  });

  test("the last line without a newline follows the same rule", () => {
    expect(bothWays("Answer:\n[Tool Result] header text")).toBe("Answer:\n[Tool Result] header text");
    expect(bothWays("Answer:\n[Tool Result")).toBe("Answer:\n");
    expect(bothWays("Answer:\n[Tool call: read (call_id: c1")).toBe("Answer:\n");
  });

  test("markers inside a closed fence stay code", () => {
    const text = "x\n" + FENCE + "\n[Tool Result] example\n[Tool Result]\n" + FENCE + "\nafter";
    expect(bothWays(text)).toBe(text);
  });

});

describe("xAI Responses JSON path", () => {
  test("prose starting with a marker is kept; a whole-line echo is stripped", () => {
    const body = (text: string) => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    const read = (json: string) => (JSON.parse(json) as { output: { content: { text: string }[] }[] }).output[0]!.content[0]!.text;
    expect(read(stripGrokUpstreamEnvelopeEchoFromResponsesJson(body("[Tool Result] shows x.\nMore.")))).toBe("[Tool Result] shows x.\nMore.");
    expect(read(stripGrokUpstreamEnvelopeEchoFromResponsesJson(body("ok\n[Tool Result]\nsecret")))).toBe("ok\n");
  });
});

describe("Cursor assistant-history replay", () => {
  test("prose starting with a marker is not stripped from replayed history", () => {
    const text = "[Tool Result] shows the tests passed.\nThe fix is in place.";
    expect(stripAssistantEchoedToolEnvelope(text)).toBe(text);
  });

  test("a whole-line envelope is still stripped with its payload run", () => {
    expect(stripAssistantEchoedToolEnvelope("Intro\n\n[Tool Result]\npayload line\n\nAfter")).toBe("Intro\n\n\nAfter");
    expect(stripAssistantEchoedToolEnvelope("[Tool call: read (call_id: c1) with args: {}]\npayload")).toBe("");
  });
});

