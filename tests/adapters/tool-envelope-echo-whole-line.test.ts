import { describe, expect, spyOn, test } from "bun:test";
import { ToolEnvelopeEchoFilter, stripToolEnvelopeEcho } from "../../src/lib/tool-envelope-echo-filter";
import { stripGrokUpstreamEnvelopeEchoFromResponsesJson } from "../../src/server/grok-upstream-envelope-echo";
import { stripAssistantEchoedToolEnvelope } from "../../src/adapters/cursor/envelope-echo";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";

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

// Count input units presented to the whole-string scanning operations, not elapsed time.
// The old recognizer rescanned the entire accumulated padding on every input character.
function measuredFilter(text: string, fragmented: boolean): { output: string; scanned: number } {
  let scanned = 0;
  const originalTrim = String.prototype.trimEnd;
  const originalReplace = String.prototype.replace;
  const trim = spyOn(String.prototype, "trimEnd").mockImplementation(function (this: string) {
    scanned += this.length;
    return originalTrim.call(this);
  });
  const replace = spyOn(String.prototype, "replace").mockImplementation(function (this: string, ...args: Parameters<typeof String.prototype.replace>) {
    scanned += this.length;
    return Reflect.apply(originalReplace, this, args) as string;
  });
  try {
    const filter = new ToolEnvelopeEchoFilter();
    let output = "";
    if (fragmented) for (const char of text) output += filter.feed(char);
    else output = filter.feed(text);
    output += filter.finish();
    return { output, scanned };
  } finally {
    trim.mockRestore();
    replace.mockRestore();
  }
}

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

  for (const fragmented of [false, true]) test.each([2048, 4096, 8192])(
    `scans marker padding once at %i units (fragmented=${fragmented})`, size => {
      const padding = " \t\u00a0\u2003\ufeff\r".repeat(Math.ceil(size / 6)).slice(0, size);
      const text = `[Tool Result]${padding}`;
      const result = measuredFilter(text, fragmented);
      expect(result.output).toBe("");
      expect(result.scanned).toBeLessThan(text.length * 12 + 4096);
    },
  );

  test("long marker padding can still diverge into prose or close as fenced code", () => {
    const padding = " \t\u00a0\u2003".repeat(2048);
    expect(bothWays(`[Tool Result]${padding}is a heading.\r\nAfter.`))
      .toBe(`[Tool Result]${padding}is a heading.\r\nAfter.`);
    expect(bothWays(`[Tool Result${padding}] is prose.`)).toBe(`[Tool Result${padding}] is prose.`);
    const fenced = `${FENCE}\n[Tool Result]${padding}\r\nexample\n${FENCE}`;
    expect(bothWays(fenced)).toBe(fenced);
  });

  test.each(["[Tool Result]", "[Tool Error]", "[tool_result]", "[Tool Call]", "[Tool Result", "[Tool Error", "[tool_result", "[Tool Call"])(
    "refuses %s padding beyond the pending budget without releasing it", marker => {
      const filter = new ToolEnvelopeEchoFilter();
      const pending = `  ${marker}`;
      expect(filter.feed(pending + "\u2003".repeat(64 * 1024 - pending.length))).toBe("");
      expect(() => filter.feed("\t")).toThrow(TranslatorBudgetExceededError);
      expect(() => filter.finish()).toThrow(TranslatorBudgetExceededError);
      expect(() => filter.feed("is prose now.\nprivate-fixture")).toThrow(TranslatorBudgetExceededError);
      expect(filter.matched).toBe(false);
    },
  );

  const marker = "[Tool Result]";
  const atLimit = marker.padEnd(64 * 1024);
  test.each([["EOF", ""], ["LF", "\n"], ["CRLF", "\r\n"]])(
    "allows exactly the pending limit at %s and rejects one more content unit", (_name, ending) => {
      const tail = ending ? `${ending}private-fixture` : "";
      expect(bothWays(atLimit + tail)).toBe("");
      expect(() => stripToolEnvelopeEcho(atLimit + " " + tail)).toThrow(TranslatorBudgetExceededError);
      expect(() => streamed(atLimit + " " + tail)).toThrow(TranslatorBudgetExceededError);
    },
  );

  test("a CR beyond the pending limit counts as content without a following LF", () => {
    expect(() => streamed(atLimit + "\r")).toThrow(TranslatorBudgetExceededError);
    expect(() => streamed(atLimit + "\r\r\n")).toThrow(TranslatorBudgetExceededError);
    expect(() => streamed(atLimit + "\rprose")).toThrow(TranslatorBudgetExceededError);
  });

  test("an oversized candidate fails within one delta, including inside a fence", () => {
    for (const prefix of ["", `${FENCE}\n`]) {
      expect(() => stripToolEnvelopeEcho(`${prefix}[Tool Result]${" ".repeat(64 * 1024)}\nprivate-fixture`))
        .toThrow(TranslatorBudgetExceededError);
    }
  });
});

describe("xAI Responses JSON path", () => {
  test("prose starting with a marker is kept; a whole-line echo is stripped", () => {
    const body = (text: string) => JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    const read = (json: string) => (JSON.parse(json) as { output: { content: { text: string }[] }[] }).output[0]!.content[0]!.text;
    expect(read(stripGrokUpstreamEnvelopeEchoFromResponsesJson(body("[Tool Result] shows x.\nMore.")))).toBe("[Tool Result] shows x.\nMore.");
    expect(read(stripGrokUpstreamEnvelopeEchoFromResponsesJson(body("ok\n[Tool Result]\nsecret")))).toBe("ok\n");
  });

  test("an overflowing marker never falls back to the original JSON", () => {
    const json = JSON.stringify({ output: [{ content: [{ type: "output_text", text: `[Tool Result]${" ".repeat(64 * 1024)}\nprivate-fixture` }] }] });
    expect(() => stripGrokUpstreamEnvelopeEchoFromResponsesJson(json)).toThrow(TranslatorBudgetExceededError);
    expect(stripGrokUpstreamEnvelopeEchoFromResponsesJson("not JSON")).toBe("not JSON");
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

