import { describe, expect, test } from "bun:test";
import {
  FORMAT_MEDIA_TYPE,
  quoteTomlKey,
  renderToml,
  renderYaml,
  serializeDocument,
  tomlString,
} from "../src/integrations/serialize";

/**
 * Activation coverage for devlog/_plan/260802_client_toggle_api/011 §1.
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

  test("throws rather than emitting ambiguous bytes", () => {
    expect(() => renderYaml({ k: null })).toThrow(/unsupported YAML value/);
    expect(() => renderYaml({ k: Number.NaN })).toThrow(/unsupported YAML number/);
    expect(() => renderYaml({ k: [[1]] })).toThrow(/unsupported YAML array item/);
    expect(() => renderYaml({ a: 1 }, -1)).toThrow(/non-negative integer/);
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

  test("throws on a value TOML cannot express inline", () => {
    expect(() => renderToml({ k: null })).toThrow(/unsupported TOML value/);
    expect(() => renderToml({ k: [1, 2] })).toThrow(/unsupported TOML value/);
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

  test("media types are declared for every format", () => {
    expect(Object.keys(FORMAT_MEDIA_TYPE).sort()).toEqual(["json", "json5", "toml", "yaml"]);
  });
});
