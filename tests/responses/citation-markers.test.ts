import { describe, expect, test } from "bun:test";
import {
  CITATION_MARKER_END,
  CITATION_MARKER_SEPARATOR,
  CITATION_MARKER_START,
  createCitationMarkerFilter,
  hasCitationMarker,
  stripCitationMarkers,
} from "../../src/responses/citation-markers";

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
      `late ${S}${"z".repeat(4_096)}${E} end`,
      // Exactly at the bound (4096 chars START..END inclusive) is still a span.
      `edge ${S}${"z".repeat(4_094)}${E} end`,
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
