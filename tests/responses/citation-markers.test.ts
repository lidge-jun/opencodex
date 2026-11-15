import { describe, expect, test } from "bun:test";
import {
  CITATION_MARKER_END,
  CITATION_MARKER_SEPARATOR,
  CITATION_MARKER_START,
  createCitationMarkerFilter,
  createMemoryCitationEscaper,
  escapeMemoryCitationMentions,
  hasCitationMarker,
  stripCitationMarkers,
} from "../../src/responses/citation-markers";
import { encodeChatCompletionSse } from "../../src/protocols/encoders/chat";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { buildResponseJSON } from "../../src/bridge/response-json";
import type { AdapterEvent } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { isAnthropicProgressMirror } from "../../src/responses/anthropic-progress";
import { decodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";

/**
 * #3150: the ChatGPT backend delimits inline citations with private-use characters
 * (U+E200 open, U+E202 separate, U+E201 close). The desktop client renders them as source
 * chips; the Codex TUI prints them literally, so the user saw
 * "citeturn1view0turn1view1" in the answer and in the saved transcript.
 *
 * OpenCodex neither emits nor understands the grammar - it is upstream text passing
 * through - so the proxy strips it before a client that cannot render it.
 */

const S = CITATION_MARKER_START;
const P = CITATION_MARKER_SEPARATOR;
const E = CITATION_MARKER_END;
const span = `${S}cite${P}turn1view0${P}turn1view1${E}`;

/** Text of the first assistant message in a buffered Responses body. */
function messageText(body: Record<string, unknown>): string {
  const output = body.output as Array<{ type?: string; content?: Array<{ text?: string }> }>;
  return output.find(item => item.type === "message")?.content?.[0]?.text ?? "";
}

describe("citation marker stripping (#3150)", () => {
  test("a complete span is removed and the surrounding text survives", () => {
    expect(stripCitationMarkers(`The setting is supported. ${span} Next.`))
      .toBe("The setting is supported.  Next.");
  });

  test("several spans in one message are all removed", () => {
    expect(stripCitationMarkers(`a${span}b${S}cite${P}turn2view0${E}c`)).toBe("abc");
  });

  test("text with no markers is returned unchanged", () => {
    // The common case must not be rewritten at all.
    const plain = "ordinary answer text with no private-use characters";
    expect(stripCitationMarkers(plain)).toBe(plain);
    expect(hasCitationMarker(plain)).toBe(false);
  });

  test("an unterminated span keeps its text instead of truncating the answer", () => {
    // Malformed input must not delete everything after the opening marker: that would
    // silently drop real answer text.
    // The opening marker is kept too: without a terminator there is no proof this is a
    // citation span at all, so the input is returned verbatim rather than partly rewritten.
    expect(stripCitationMarkers(`tail ${S}cite${P}turn1`)).toBe(`tail ${S}cite${P}turn1`);
  });

  test("a stray separator or terminator alone is left alone", () => {
    expect(stripCitationMarkers(`a${P}b`)).toBe(`a${P}b`);
    expect(stripCitationMarkers(`a${E}b`)).toBe(`a${E}b`);
  });

  test("a malformed START before a later valid span is kept, not paired with that span's END", () => {
    // Whole-string stripping must agree with the streaming filter: the malformed prefix
    // survives and only the real span is removed (bridge re-strips the accumulated text
    // for output_text.done, so any disagreement would make done != concatenated deltas).
    const malformed = `${S}${"y".repeat(5_000)}`;
    expect(stripCitationMarkers(`a${malformed}${S}cite${P}turn1view0${E} tail`)).toBe(`a${malformed} tail`);
    expect(stripCitationMarkers(`a${S}cite${S}cite${P}turn1view0${E}b`)).toBe(`a${S}citeb`);
  });
});

describe("streaming citation marker filter (#3150)", () => {
  const drain = (chunks: readonly string[]): string => {
    const filter = createCitationMarkerFilter();
    let out = "";
    for (const chunk of chunks) out += filter.push(chunk);
    return out + filter.flush();
  };

  test("a span split across deltas is removed, not leaked", () => {
    // The case a stateless per-delta strip gets wrong: the opening marker arrives in one
    // chunk and the terminator in the next, so the tail would be emitted unrecognized.
    expect(drain([`The setting is supported. ${S}cite${P}`, `turn1view0${P}turn1view1${E}`, " Next."]))
      .toBe("The setting is supported.  Next.");
  });

  test("a span split one character at a time is still removed", () => {
    expect(drain([...`ok ${span} done`])).toBe("ok  done");
  });

  test("a stream ending mid-span releases the held text rather than swallowing it", () => {
    // Withhold, not drop: if the stream dies inside a marker the bytes still reach the user.
    expect(drain([`abc ${S}cite${P}turn1`])).toBe(`abc ${S}cite${P}turn1`);
  });

  test("marker-free deltas pass through byte-identical", () => {
    expect(drain(["hello ", "world", "!"])).toBe("hello world!");
  });

  test("text before an open span is emitted immediately, not held to the end", () => {
    // Streaming must stay streaming: only the unterminated span is withheld.
    const filter = createCitationMarkerFilter();
    expect(filter.push(`visible now ${S}cite`)).toBe("visible now ");
  });

  test("an unterminated span past the bound is released instead of retained", () => {
    // A backend that opens a span and never closes it must not make the filter accumulate
    // the rest of the response, which every later delta would then re-scan.
    const filter = createCitationMarkerFilter();
    let out = filter.push(`kept ${S}cite`);
    expect(out).toBe("kept ");
    for (let i = 0; i < 5_000; i += 1) out += filter.push("x");

    // Everything after the malformed START is emitted verbatim, so nothing is lost, and
    // flush() has nothing left to release.
    expect(out).toBe(`kept ${S}cite${"x".repeat(5_000)}`);
    expect(filter.flush()).toBe("");
  });

  test("a later START still opens a valid span after a released malformed one", () => {
    const filter = createCitationMarkerFilter();
    let out = filter.push(`a${S}${"y".repeat(5_000)}`);
    out += filter.push(`${S}cite${P}turn1view0${E} tail`);
    expect(out).toBe(`a${S}${"y".repeat(5_000)} tail`);
    expect(filter.flush()).toBe("");
  });

  test("an oversized malformed span survives a later valid marker in the same delta", () => {
    const filter = createCitationMarkerFilter();
    const malformed = `${S}${"y".repeat(5_000)}`;
    expect(filter.push(`a${span}${malformed}${S}cite${P}turn1view0${E} tail`))
      .toBe(`a${malformed} tail`);
    expect(filter.flush()).toBe("");
  });

  test("concatenated streaming output equals whole-string stripping for every chunking", () => {
    // The bridge emits deltas through the filter and then re-strips the accumulated text for
    // output_text.done / output_item.done, so the two contracts must produce identical text.
    const malformed = `${S}${"y".repeat(5_000)}`;
    const inputs = [
      `a${span}${malformed}${S}cite${P}turn1view0${E} tail`,
      `kept ${S}cite${"x".repeat(5_000)}`,
      `a${S}cite${S}cite${P}turn1view0${E}b`,
      `a${span}b${S}cite${P}turn2view0${E}c`,
      // An over-bound span that is eventually terminated: the streaming filter has already
      // released it verbatim, so whole-string stripping must keep it too.
      `late ${S}cite${P}${"z".repeat(4_090)}${E} end`,
      // Exactly at the bound (4096 chars START..END inclusive) is still a span.
      `edge ${S}cite${P}${"z".repeat(4_089)}${E} end`,
      // Non-citation directives pass through on both paths (#6039).
      `a ${S}visualize${P}{"path":"/tmp/x.html"}${E} b${span}c`,
      `${S}cit${S}filecite${P}turn0file0${E}${S}citex${P}y${E}`,
    ];
    for (const input of inputs) {
      for (const size of [1, 7, 4_097, input.length]) {
        const chunks: string[] = [];
        for (let i = 0; i < input.length; i += size) chunks.push(input.slice(i, i + size));
        expect(drain(chunks)).toBe(stripCitationMarkers(input));
      }
    }
  });
});

describe("non-citation directive spans pass through (#6039)", () => {
  // The Codex App draws inline visualizations from a span in the same private-use grammar.
  // Deleting it meant a correctly formed reference never reached the app.
  const viz = `${S}visualize${P}{"path":"/tmp/x.html","mode":"wide"}${E}`;
  const drain = (chunks: readonly string[]): string => {
    const filter = createCitationMarkerFilter();
    let out = "";
    for (const chunk of chunks) out += filter.push(chunk);
    return out + filter.flush();
  };

  test("a visualize directive survives whole-string stripping", () => {
    const text = `before\n${viz}\nafter`;
    expect(stripCitationMarkers(text)).toBe(text);
  });

  test("a visualize directive survives streaming at every chunk size", () => {
    const text = `before\n${viz}\nafter`;
    for (const size of [1, 2, 5, text.length]) {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
      expect(drain(chunks)).toBe(text);
    }
  });

  test("citations next to a directive are still removed", () => {
    expect(stripCitationMarkers(`a${span}${viz}b`)).toBe(`a${viz}b`);
    expect(drain([...`a${span}${viz}b`])).toBe(`a${viz}b`);
  });

  test("private-use characters inside a directive payload are not read as new spans", () => {
    const nested = `a${S}visualize${P}{"path":"/tmp/${S}cite${P}chart.html"}${E}b${span}c`;
    const expected = `a${S}visualize${P}{"path":"/tmp/${S}cite${P}chart.html"}${E}bc`;
    expect(stripCitationMarkers(nested)).toBe(expected);
    for (const size of [1, 3, nested.length]) {
      const chunks: string[] = [];
      for (let i = 0; i < nested.length; i += size) chunks.push(nested.slice(i, i + size));
      expect(drain(chunks)).toBe(expected);
    }
  });

  test("an unterminated directive stops shielding STARTs at the span bound", () => {
    const open = `${S}visualize${P}${"q".repeat(5_000)}`;
    expect(stripCitationMarkers(`${open}${span}end`)).toBe(`${open}end`);
  });

  test("filecite spans are citations too", () => {
    expect(stripCitationMarkers(`x${S}filecite${P}turn0file0${E}y`)).toBe("xy");
  });

  test("a keyword split across deltas is decided before the span is removed or released", () => {
    // "ci" could still become "cite", so the filter must wait; "cit" + "y" rules it out.
    expect(drain(["a", S, "ci", `te${P}turn1view0${E}`, "b"])).toBe("ab");
    expect(drain(["a", S, "ci", "ty", `${P}x${E}b`])).toBe(`a${S}city${P}x${E}b`);
  });

  test("a directive is released as soon as its keyword rules out a citation", () => {
    // Streaming must stay streaming: the directive is not held until its END arrives.
    const filter = createCitationMarkerFilter();
    expect(filter.push(`go ${S}vis`)).toBe(`go ${S}vis`);
    expect(filter.push(`ualize${P}{"path"`)).toBe(`ualize${P}{"path"`);
    expect(filter.flush()).toBe("");
  });

  // The Codex client treats a literal <oai-mem-citation> as markup: it keeps the LAST block and
  // drops everything between the first opening tag and the last closing one. A model that quotes
  // the tag name in prose therefore loses the rest of its answer, which is the "truncated at a
  // backtick" report. Escaping the leading `<` keeps the characters visible without matching.
  test("a literal memory-citation tag in prose is escaped, not left to the client", () => {
    expect(escapeMemoryCitationMentions("put the `<oai-mem-citation>` block last"))
      .toBe("put the `&lt;oai-mem-citation>` block last");
    expect(escapeMemoryCitationMentions("</oai-mem-citation>"))
      .toBe("&lt;/oai-mem-citation>");
    // Text that merely shares a prefix is untouched.
    expect(escapeMemoryCitationMentions("<oai-mem-citationless> and <p> tags"))
      .toBe("<oai-mem-citationless> and <p> tags");
  });

  test("a real memory-citation block keeps its tags so the client can still render it", () => {
    const block = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n"
      + "<rollout_ids>\n0123\n</rollout_ids>\n</oai-mem-citation>";
    // A mention before the block is escaped, the block itself survives byte for byte.
    expect(escapeMemoryCitationMentions(`put the \`<oai-mem-citation>\` block last.\n\n${block}`))
      .toBe(`put the \`&lt;oai-mem-citation>\` block last.\n\n${block}`);
    expect(escapeMemoryCitationMentions(block)).toBe(block);
  });

  test("the streaming escaper escapes a tag split across deltas", () => {
    const escaper = createMemoryCitationEscaper();
    const chunks = ["answer: ", "<", "oai", "-mem-cit", "ation", ">", " rest"];
    const out = chunks.map(chunk => escaper.push(chunk)).join("") + escaper.pending();
    expect(out).toBe("answer: &lt;oai-mem-citation> rest");
  });

  test("the streaming escaper releases a tail that stops looking like a tag", () => {
    const escaper = createMemoryCitationEscaper();
    // "<o" could still open the tag, so it is held; "ps" proves it cannot and releases it.
    expect(escaper.push("a <o")).toBe("a ");
    expect(escaper.push("ps b")).toBe("<ops b");
    expect(escaper.pending()).toBe("");
    // An unterminated open tag is released verbatim at close, so no text is invented or lost.
    const held = createMemoryCitationEscaper();
    expect(held.push("tail <oai-mem")).toBe("tail ");
    expect(held.pending()).toBe("<oai-mem");
  });

  const REAL_BLOCK = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n"
    + "<rollout_ids>\n0123\n</rollout_ids>\n</oai-mem-citation>";

  /** Feed a string to the escaper in the given pieces and resolve what it still holds. */
  const streamed = (pieces: string[]): string => {
    const escaper = createMemoryCitationEscaper();
    return pieces.map(piece => escaper.push(piece)).join("") + escapeMemoryCitationMentions(escaper.pending());
  };

  test("a real block split one character at a time keeps both tags, equal to the final text", () => {
    const text = `see this\n\n${REAL_BLOCK}`;
    expect(streamed([...text])).toBe(text);
    expect(streamed([...text])).toBe(escapeMemoryCitationMentions(text));
  });

  test("an incomplete or invalid block is a mention and is escaped like the final text", () => {
    for (const text of [
      "x <oai-mem-citation><citation_entries>e</citation_entries></oai-mem-citation> y",
      "x <oai-mem-citation><citation_entries>never closes",
      "quoted <oai-mem-citation> prose </oai-mem-citation> more",
    ]) {
      expect(streamed([...text])).toBe(escapeMemoryCitationMentions(text));
    }
  });

  test("delta/done parity holds for every two-way split of a mixed text", () => {
    const text = `a \`<oai-mem-citation>\` b ${REAL_BLOCK} c </oai-mem-citation> d`;
    const expected = escapeMemoryCitationMentions(text);
    for (let cut = 0; cut <= text.length; cut++) {
      expect(streamed([text.slice(0, cut), text.slice(cut)])).toBe(expected);
    }
  });

  async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
    for (const event of events) yield event;
  }
  const textEvents = (pieces: string[]): AdapterEvent[] => [
    ...pieces.map(text => ({ type: "text_delta", text }) as AdapterEvent),
    { type: "done" } as AdapterEvent,
  ];

  test("the Chat encoder never rewrites the tag: Chat clients do not parse it", async () => {
    const chatText = async (pieces: string[]) => {
      const raw = await new Response(encodeChatCompletionSse(replay(textEvents(pieces)), {
        model: "client-model", translatorBudget: createTestTranslatorBudget(),
      })).text();
      return raw.split("\n").filter(line => line.startsWith("data: {")).map(line => {
        const content = (JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        return content ?? "";
      }).join("");
    };
    expect(await chatText(["quoted <oai-mem-", "citation> prose"])).toBe("quoted <oai-mem-citation> prose");
    const real = `lead\n${REAL_BLOCK}`;
    expect(await chatText([...real])).toBe(real);
  });

  const bridgeText = async (pieces: string[], escapeMemoryCitationTags?: boolean) => {
    const raw = await new Response(bridgeToResponsesSSE(
      replay(textEvents(pieces)), "internal/model", undefined, undefined, undefined, undefined, 2_000,
      { translatorBudget: createTestTranslatorBudget(), enforceDeclaredToolNames: false,
        ...(escapeMemoryCitationTags === undefined ? {} : { escapeMemoryCitationTags }) },
    )).text();
    const frames = raw.split("\n\n").map(block => block.split("\n").find(line => line.startsWith("data: "))).filter(line => line && line !== "data: [DONE]")
      .map(line => JSON.parse(line!.slice(6)) as { type?: string; delta?: string; text?: string });
    return {
      deltas: frames.filter(f => f.type === "response.output_text.delta").map(f => f.delta ?? "").join(""),
      done: frames.find(f => f.type === "response.output_text.done")?.text ?? "",
    };
  };

  test("Chat and Messages deliveries through the Responses bridge keep the raw tag", async () => {
    const raw = await bridgeText(["quoted <oai-mem-", "citation> prose"], false);
    expect(raw).toEqual({ deltas: "quoted <oai-mem-citation> prose", done: "quoted <oai-mem-citation> prose" });
    const json = buildResponseJSON(textEvents(["quoted <oai-mem-citation> prose"]), "internal/model", { escapeMemoryCitationTags: false });
    expect(messageText(json)).toBe("quoted <oai-mem-citation> prose");
  });

  test("a buffered Responses body escapes the mention and keeps a real block", () => {
    const json = buildResponseJSON(textEvents([`quoted <oai-mem-citation> prose\n${REAL_BLOCK}`]), "internal/model");
    expect(messageText(json)).toBe(`quoted &lt;oai-mem-citation> prose\n${REAL_BLOCK}`);
  });

  test("a block carrying only an ids list is real too, as the client accepts it", async () => {
    for (const ids of ["rollout_ids", "thread_ids"]) {
      const block = `<oai-mem-citation>
<${ids}>
0123
</${ids}>
</oai-mem-citation>`;
      const text = `answer
${block}`;
      expect(escapeMemoryCitationMentions(text)).toBe(text);
      expect(streamed([...text])).toBe(text);
    }
    // Neither list: still a mention.
    expect(escapeMemoryCitationMentions("<oai-mem-citation><notes>x</notes></oai-mem-citation>"))
      .toBe("&lt;oai-mem-citation><notes>x</notes>&lt;/oai-mem-citation>");
  });

  test("many unclosed candidates stay linear in both forms", () => {
    const text = "<oai-mem-citation><citation_entries>x ".repeat(80_000) + "</oai-mem-citation>";
    const started = performance.now();
    const whole = escapeMemoryCitationMentions(text);
    const escaper = createMemoryCitationEscaper();
    const pieces = text.match(/[\s\S]{1,200000}/g)!;
    const stream = pieces.map(piece => escaper.push(piece)).join("") + escapeMemoryCitationMentions(escaper.pending());
    expect(stream).toBe(whole);
    expect(whole.startsWith("&lt;oai-mem-citation><citation_entries>x ")).toBe(true);
    // The earlier quadratic scan took about 13 s on this 3 MB input; the bounded one takes well under a second.
    expect(performance.now() - started).toBeLessThan(4_000);
  });

  test("a real block without an ids list still counts as real, as the client parses it", async () => {
    const entriesOnly = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n</oai-mem-citation>";
    const text = `answer\n${entriesOnly}`;
    expect(escapeMemoryCitationMentions(text)).toBe(text);
    expect(streamed([...text])).toBe(text);
    expect(await bridgeText([...text])).toEqual({ deltas: text, done: text });
  });

  test("the Responses bridge streams the same text it reports as done", async () => {
    const run = async (pieces: string[]) => {
      const raw = await new Response(bridgeToResponsesSSE(
        replay(textEvents(pieces)), "internal/model", undefined, undefined, undefined, undefined, 2_000,
        { translatorBudget: createTestTranslatorBudget(), enforceDeclaredToolNames: false },
      )).text();
      const frames = raw.split("\n\n").map(block => block.split("\n").find(line => line.startsWith("data: "))).filter(line => line && line !== "data: [DONE]")
        .map(line => JSON.parse(line!.slice(6)) as { type?: string; delta?: string; text?: string });
      return {
        deltas: frames.filter(f => f.type === "response.output_text.delta").map(f => f.delta ?? "").join(""),
        done: frames.find(f => f.type === "response.output_text.done")?.text ?? "",
      };
    };
    const real = `lead\n${REAL_BLOCK}`;
    const block = await run([...real]);
    expect(block.deltas).toBe(real);
    expect(block.done).toBe(real);
    const mention = await run(["quoted <oai-mem-", "citation> prose"]);
    expect(mention.deltas).toBe("quoted &lt;oai-mem-citation> prose");
    expect(mention.done).toBe(mention.deltas);
  });

  test("a held candidate block is charged to the translator budget and released at close", async () => {
    const body = "MEMORY.md:1-2|note=[x]\n".repeat(150);
    const candidate = `<oai-mem-citation>\n<citation_entries>\n${body}`;
    const pieces: string[] = [];
    for (let at = 0; at < candidate.length; at += 500) pieces.push(candidate.slice(at, at + 500));
    const peak = async (text: string[]) => {
      const budget = createTestTranslatorBudget();
      await new Response(bridgeToResponsesSSE(
        replay(textEvents(text)), "internal/model", undefined, undefined, undefined, undefined, 2_000,
        { translatorBudget: budget, enforceDeclaredToolNames: false },
      )).text();
      return budget.snapshot();
    };
    const held = await peak(pieces);
    // Same bytes and newlines, but not a tag, so nothing is held.
    const free = await peak(pieces.map(piece => piece.replace("<oai-mem-citation>", "<oai-mem-citatioX>")));
    // The never-closed candidate is held whole, so the bridge's high-water mark carries it ...
    expect(held.highWaterBytes).toBeGreaterThanOrEqual(free.highWaterBytes + Buffer.byteLength(candidate) / 2);
    // ... and everything is released once the message closes.
    // (The escaped `&lt;` adds a few bytes to the retained text, nothing more.)
    expect(Math.abs(held.currentBytes - free.currentBytes)).toBeLessThanOrEqual(16);
  });

  test("an oversized candidate stops being held and is escaped like the final text", () => {
    const huge = `<oai-mem-citation>\n<citation_entries>\n${"y".repeat(40_000)}`;
    const escaper = createMemoryCitationEscaper();
    const out = [...huge.match(/[\s\S]{1,4000}/g)!].map(piece => escaper.push(piece)).join("");
    expect(Buffer.byteLength(escaper.pending())).toBeLessThanOrEqual(16_384 + 4_000);
    expect(out + escapeMemoryCitationMentions(escaper.pending())).toBe(escapeMemoryCitationMentions(huge));
  });

  test("a block above the hold limit is a mention in the streamed and the final text alike", () => {
    const big = `<oai-mem-citation>\n<citation_entries>\n${"MEMORY.md:1-2|note=[x]\n".repeat(900)}</citation_entries>\n`
      + "<rollout_ids>\n0123\n</rollout_ids>\n</oai-mem-citation>";
    expect(big.length).toBeGreaterThan(16_384);
    const finalText = escapeMemoryCitationMentions(big);
    expect(finalText.startsWith("&lt;oai-mem-citation>")).toBe(true);
    expect(streamed(big.match(/[\s\S]{1,1000}/g)!)).toBe(finalText);
  });

  test("signed progress text escapes only its visible copy, and the mirror check still matches", async () => {
    const raw = "quoted <oai-mem-citation> prose";
    const sse = await new Response(bridgeToResponsesSSE(
      replay([
        { type: "text_delta", text: raw, anthropicThinkingSignature: "SyntheticProgressSignature123456==" } as AdapterEvent,
        { type: "done" } as AdapterEvent,
      ]), "internal/model", undefined, undefined, undefined, undefined, 2_000,
      { translatorBudget: createTestTranslatorBudget(), enforceDeclaredToolNames: false },
    )).text();
    const frames = sse.split("\n\n").map(block => block.split("\n").find(line => line.startsWith("data: ")))
      .filter(line => line && line !== "data: [DONE]").map(line => JSON.parse(line!.slice(6)) as {
        type?: string; text?: string; delta?: string; item?: { type?: string; encrypted_content?: string; content?: unknown[] };
      });
    const escaped = "quoted &lt;oai-mem-citation> prose";
    expect(frames.find(f => f.type === "response.output_text.delta")?.delta).toBe(escaped);
    expect(frames.find(f => f.type === "response.output_text.done")?.text).toBe(escaped);
    const items = frames.filter(f => f.type === "response.output_item.done").map(f => f.item!);
    const carrier = items.find(item => item.type === "reasoning")!;
    const envelope = decodeReasoningEnvelope(carrier.encrypted_content!);
    expect(envelope?.txt).toBe(raw);
    const visible = items.find(item => item.type === "message") as { content?: Array<{ text?: string }> } | undefined;
    expect(visible?.content?.[0]?.text).toBe(escaped);
    expect(isAnthropicProgressMirror(visible, envelope)).toBe(true);
  });
});
