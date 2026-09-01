import { describe, expect, test } from "bun:test";
import {
  CITATION_MARKER_END,
  CITATION_MARKER_SEPARATOR,
  CITATION_MARKER_START,
  createCitationMarkerFilter,
  hasCitationMarker,
  stripCitationMarkers,
} from "../src/responses/citation-markers";

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
});
