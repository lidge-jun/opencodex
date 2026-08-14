import { describe, expect, test } from "bun:test";
import {
  FORMAT_MEDIA_TYPE,
  UnserializableValueError,
  quoteTomlKey,
  renderToml,
  renderYaml,
  serializeDocument,
  tomlString,
} from "../src/integrations/serialize";

/**
 * Activation coverage for devlog/_fin/260802_client_toggle_api/011 §1.
 *
 * The round-trip assertions are the load-bearing ones: a renderer that emits
 * plausible-looking text a parser then reads differently is worse than one that
 * throws, so every format proves itself against its own parser.
 */
describe("renderYaml", () => {
  test("renders block style, not Bun's flow style", () => {
    const text = renderYaml({ a: 1, b: { c: "d" } });
    expect(text).toBe("a: 1\nb:\n  c: d\n");
    // The reason this renderer exists at all.
    expect(Bun.YAML.stringify({ a: 1, b: { c: "d" } })).not.toBe(text);
  });

  test("round-trips through Bun.YAML.parse", () => {
    const doc = {
      providers: {
        opencodex: {
          api: "http://127.0.0.1:10100/v1",
          api_key: "${OPENCODEX_HERMES_API_KEY}",
          discover_models: false,
          models: ["anthropic/claude-opus-4-8", "openai/gpt-5.5"],
        },
      },
    };
    expect(Bun.YAML.parse(renderYaml(doc))).toEqual(doc);
  });

  test("round-trips a sequence of maps", () => {
    const doc = {
      providers: {
        opencodex: {
          baseUrl: "http://127.0.0.1:10100/v1",
          models: [
            { id: "a/b", name: "A (routed)", input: ["text"] },
            { id: "c/d", name: "C (native)", input: ["text"], contextWindow: 200000 },
          ],
        },
      },
    };
    expect(Bun.YAML.parse(renderYaml(doc))).toEqual(doc);
  });

  test("quotes anything that is not an unambiguous single token", () => {
    // `${...}` must survive verbatim: it is how the credential stays out of the file.
    expect(renderYaml({ k: "${VAR}" })).toBe('k: "${VAR}"\n');
    expect(renderYaml({ k: "yes" })).toBe('k: "yes"\n');
    expect(renderYaml({ k: "" })).toBe('k: ""\n');
    expect(renderYaml({ k: "has space" })).toBe('k: "has space"\n');
    expect(renderYaml({ "needs.quote?": 1 })).toBe('"needs.quote?": 1\n');
  });

  test("empty collections stay on one line", () => {
    expect(renderYaml({ a: {}, b: [] })).toBe("a: {}\nb: []\n");
  });

  test("renders the values YAML actually allows", () => {
    /*
     * These renderers used to see only our own builder output, so anything
     * richer threw. The integration writer feeds them the USER's whole parsed
     * config, and a legitimate `null` threw straight out of the writer as a
     * 500 on a file we had no business rejecting.
     */
    expect(renderYaml({ k: null })).toBe("k: null\n");
    expect(renderYaml({ k: { nested: null } })).toBe("k:\n  nested: null\n");
  });

  test("still refuses what YAML genuinely cannot represent", () => {
    expect(() => renderYaml({ k: Number.NaN })).toThrow(/YAML cannot represent the number/);
    expect(() => renderYaml({ a: 1 }, -1)).toThrow(/non-negative integer/);
    // The message names the KIND, never the value — a config may hold secrets.
    expect(() => renderYaml({ k: () => 1 })).toThrow(/YAML cannot represent .*function/);
  });

  test("nested sequences render, because YAML has always allowed them", () => {
    // This threw a PLAIN Error carrying `String(item)` — untyped, so the
    // writer surfaced it as a 500, and it repeated the value's contents into
    // the message of a config that may hold secrets.
    expect(renderYaml({ matrix: [[1, 2], [3, 4]] })).toBe("matrix:\n  -\n    - 1\n    - 2\n  -\n    - 3\n    - 4\n");
    expect(renderYaml({ k: [[]] })).toBe("k:\n  - []\n");
  });
});

describe("renderToml", () => {
  test("round-trips through Bun.TOML.parse", () => {
    const doc = {
      providers: { opencodex: { type: "openai", base_url: "http://127.0.0.1:10100/v1" } },
      models: { "opencodex/a-b": { provider: "opencodex", model: "a/b", max_context_size: 200000 } },
    };
    expect(Bun.TOML.parse(renderToml(doc))).toEqual(doc);
  });

  test("quotes keys that are not bare-safe, and they survive the parser", () => {
    expect(quoteTomlKey("plain_key-1")).toBe("plain_key-1");
    expect(quoteTomlKey("anthropic/claude-opus-4.8")).toBe('"anthropic/claude-opus-4.8"');
    const doc = { models: { "anthropic/claude-opus-4.8": { model: "x" } } };
    expect(Bun.TOML.parse(renderToml(doc))).toEqual(doc);
  });

  test("renders arrays of any scalar, not only strings", () => {
    // TOML 1.0 permits mixed-type arrays; the string-only check was written
    // against our builder output and refused `ports = [1, 2]` in a real file.
    expect(renderToml({ k: [1, 2] })).toContain("k = [1, 2]");
    expect(renderToml({ k: [true, false] })).toContain("k = [true, false]");
    expect(renderToml({ k: ["a", 1, true] })).toContain('k = ["a", 1, true]');
  });

  test("still refuses what TOML cannot express inline", () => {
    // TOML has no null; that is a real limit of the format, not of our renderer.
    expect(() => renderToml({ k: null })).toThrow(/TOML cannot represent/);
    expect(() => renderToml({ k: () => 1 })).toThrow(/TOML cannot represent .*function/);
  });

  test("escapes strings", () => {
    expect(tomlString('a"b')).toBe('"a\\"b"');
  });
});

describe("serializeDocument", () => {
  const doc = { a: 1, b: { c: "d" } };

  test("every format ends with exactly one newline", () => {
    for (const format of ["json", "yaml", "toml", "json5"] as const) {
      const text = serializeDocument(doc, format);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.endsWith("\n\n")).toBe(false);
    }
  });

  test("every format round-trips to the same document", () => {
    expect(JSON.parse(serializeDocument(doc, "json"))).toEqual(doc);
    expect(Bun.YAML.parse(serializeDocument(doc, "yaml"))).toEqual(doc);
    expect(Bun.TOML.parse(serializeDocument(doc, "toml"))).toEqual(doc);
    expect(Bun.JSON5.parse(serializeDocument(doc, "json5"))).toEqual(doc);
  });

  test("is byte-stable across calls", () => {
    for (const format of ["json", "yaml", "toml", "json5"] as const) {
      expect(serializeDocument(doc, format)).toBe(serializeDocument(doc, format));
    }
  });

  test("a TOML root must be a table", () => {
    expect(() => serializeDocument([1, 2], "toml")).toThrow(/TOML root must be a table/);
  });

  test("json refuses numbers that would not survive the rewrite", () => {
    expect(() => serializeDocument({ q: Infinity }, "json")).toThrow(UnserializableValueError);
    expect(() => serializeDocument({ q: Number.NaN }, "json")).toThrow(UnserializableValueError);
    expect(() => serializeDocument({ q: -0 }, "json")).toThrow(UnserializableValueError);
    // The failure names where the value sits — including through arrays and
    // for a bare root scalar.
    expect(() => serializeDocument({ a: { b: [1, -Infinity] } }, "json")).toThrow(/a\.b\[1\]/);
    expect(() => serializeDocument({ a: [{ b: -0 }] }, "json")).toThrow(/a\[0\]\.b/);
    expect(() => serializeDocument(-0, "json")).toThrow(/at \$/);
    // Empty containers pass the walk untouched.
    expect(serializeDocument({}, "json")).toBe("{}\n");
    expect(serializeDocument([], "json")).toBe("[]\n");
  });

  test("json keeps every finite non-negative-zero double, however large", () => {
    // A finite double round-trips value-exactly; refusing 2^54 here while the
    // parse-time scanner admits it turned a classifier-promised 'stale' into
    // a permanent 'unsafe' refusal.
    expect(JSON.parse(serializeDocument({ q: 2 ** 54 }, "json"))).toEqual({ q: 2 ** 54 });
    expect(JSON.parse(serializeDocument({ q: 1e21 }, "json"))).toEqual({ q: 1e21 });
  });

  test("hostile nesting depth is a structured refusal, not a RangeError", () => {
    // The walk itself is iterative, and past MAX_SERIALIZED_JSON_NESTING it
    // refuses — JSON.stringify recurses, so letting a 50k-deep document
    // through would trade the refusal for a multi-GB spike and a raw
    // RangeError. The refusal message stays readable (clamped path).
    let deep: unknown = -Infinity;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    try {
      serializeDocument({ q: deep }, "json");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(UnserializableValueError);
      expect((error as Error).message).toContain("nests deeper");
      expect((error as Error).message.length).toBeLessThan(500);
      // The clamp keeps head and tail of the path, joined by an ellipsis.
      expect((error as Error).message).toMatch(/q\[0\].*….*\[0\]/);
    }
  });

  test("nesting within the ceiling still serializes, up to the exact boundary", () => {
    // The ceiling admits exactly MAX_JSON_NESTING container levels — the same
    // count the parse-time scanner admits. Pinning both edges catches an
    // off-by-one drift in either layer.
    let atCeiling: unknown = 1;
    for (let i = 0; i < 1000; i += 1) atCeiling = [atCeiling];
    expect(() => serializeDocument(atCeiling, "json")).not.toThrow();
    expect(() => serializeDocument([atCeiling], "json")).toThrow(/nests deeper/);
  });

  test("media types are declared for every format", () => {
    expect(Object.keys(FORMAT_MEDIA_TYPE).sort()).toEqual(["json", "json5", "toml", "yaml"]);
  });
});
