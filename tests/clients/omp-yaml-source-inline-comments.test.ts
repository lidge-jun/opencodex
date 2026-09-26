import { describe, expect, test } from "bun:test";
import { patchOmpYamlSource } from "../../src/integrations/omp-yaml-source";

const SOURCE_WITH_NESTED_INLINE_COMMENT = [
  "providers:",
  "  opencodex:",
  "    baseUrl: http://127.0.0.1:10100/v1 # user note",
  "    api: openai-completions",
  "",
].join("\n");

const CURRENT_VALUE = {
  baseUrl: "http://127.0.0.1:10100/v1",
  api: "openai-completions",
};

const SOURCE_WITH_QUOTED_HASH = [
  "providers:",
  "  opencodex:",
  "    models:",
  "      - id: \"provider/model#variant\"",
  "        name: 'model#variant (provider)'",
  "",
].join("\n");

const VALUE_WITH_QUOTED_HASH = {
  models: [{
    id: "provider/model#variant",
    name: "model#variant (provider)",
  }],
};

// Quote characters embedded in a plain scalar are content, not openers — the
// ` #` behind them is a real comment the mutation would silently delete.
const SOURCE_WITH_PLAIN_SCALAR_QUOTES = [
  "providers:",
  "  opencodex:",
  "    name: user's model # user note",
  "    api: openai-completions",
  "",
].join("\n");

const SOURCE_WITH_EMBEDDED_DOUBLE_QUOTE = [
  "providers:",
  "  opencodex:",
  "    name: model\"beta # user note",
  "    api: openai-completions",
  "",
].join("\n");

const PLAIN_QUOTED_VALUE = {
  name: "user's model",
  api: "openai-completions",
};

const EMBEDDED_QUOTED_VALUE = {
  name: "model\"beta",
  api: "openai-completions",
};

// A quoted scalar may span physical lines. The closing quote on the
// continuation line is not an opener — the ` #` behind it is a real comment.
const SOURCE_WITH_MULTILINE_QUOTE_COMMENT = [
  "providers:",
  "  opencodex:",
  "    name: \"alpha",
  "      \" # keep this note",
  "    api: openai-completions",
  "",
].join("\n");

const MULTILINE_QUOTE_VALUE = {
  name: "alpha ",
  api: "openai-completions",
};

// A `#` on a continuation line still inside an open quote is scalar content,
// not a comment — the mutation must not refuse it.
const SOURCE_WITH_MULTILINE_QUOTED_HASH = [
  "providers:",
  "  opencodex:",
  "    name: \"alpha",
  "      has # inside\"",
  "    api: openai-completions",
  "",
].join("\n");

const MULTILINE_QUOTED_HASH_VALUE = {
  name: "alpha has # inside",
  api: "openai-completions",
};

// A quote character on a plain scalar's continuation line is content too, so
// the ` #` behind it is a real comment the mutation would silently delete.
const SOURCE_WITH_PLAIN_CONTINUATION_QUOTE = [
  "providers:",
  "  opencodex:",
  "    name: alpha",
  "      \" # keep this note",
  "    api: openai-completions",
  "",
].join("\n");

const PLAIN_CONTINUATION_VALUE = {
  name: "alpha \"",
  api: "openai-completions",
};

// A `- ` indicator opens a new sequence item: scalar state from the previous
// item must not carry over and hide the quoted item's ` #` as a comment.
const SOURCE_WITH_QUOTED_ITEM_AFTER_PLAIN = [
  "providers:",
  "  opencodex:",
  "    models:",
  "      - plain",
  "      - \"model # variant\"",
  "",
].join("\n");

const QUOTED_ITEM_VALUE = {
  models: ["plain", "model # variant"],
};

// The blank between a leaf and the next sibling is a separator, not scalar
// content — refreshing or removing the leaf must leave it in place.
const SOURCE_WITH_BLANK_SEPARATOR = [
  "providers:",
  "  opencodex:",
  "    api: openai-completions",
  "",
  "  other:",
  "    api: openai-responses",
  "",
].join("\n");

const BLANK_SEPARATOR_VALUE = { api: "openai-completions" };

describe("OMP managed YAML inline comments", () => {
  test("refresh refuses to replace a managed block containing a nested inline comment", () => {
    const nextValue = {
      ...CURRENT_VALUE,
      baseUrl: "http://127.0.0.1:10101/v1",
    };

    expect(patchOmpYamlSource(
      SOURCE_WITH_NESTED_INLINE_COMMENT,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue } },
    )).toBeNull();
  });

  test("disable refuses to remove a managed block containing a nested inline comment", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_NESTED_INLINE_COMMENT,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBeNull();
  });

  test("refresh accepts hash characters inside quoted model scalars", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_QUOTED_HASH,
      { kind: "upsert", value: VALUE_WITH_QUOTED_HASH },
      { providers: { opencodex: VALUE_WITH_QUOTED_HASH } },
    )).not.toBeNull();
  });

  test("disable accepts hash characters inside quoted model scalars", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_QUOTED_HASH,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBe("");
  });

  test("refresh refuses an inline comment hidden behind a plain-scalar apostrophe", () => {
    const nextValue = { ...PLAIN_QUOTED_VALUE, api: "openai-responses" };
    expect(patchOmpYamlSource(
      SOURCE_WITH_PLAIN_SCALAR_QUOTES,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue } },
    )).toBeNull();
  });

  test("disable refuses an inline comment hidden behind a plain-scalar apostrophe", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_PLAIN_SCALAR_QUOTES,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBeNull();
  });

  test("refresh refuses an inline comment hidden behind an embedded double quote", () => {
    const nextValue = { ...EMBEDDED_QUOTED_VALUE, api: "openai-responses" };
    expect(patchOmpYamlSource(
      SOURCE_WITH_EMBEDDED_DOUBLE_QUOTE,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue } },
    )).toBeNull();
  });

  test("disable refuses an inline comment hidden behind an embedded double quote", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_EMBEDDED_DOUBLE_QUOTE,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBeNull();
  });

  test("refresh refuses a trailing comment on a multiline quoted scalar's closing line", () => {
    const nextValue = { ...MULTILINE_QUOTE_VALUE, api: "openai-responses" };
    expect(patchOmpYamlSource(
      SOURCE_WITH_MULTILINE_QUOTE_COMMENT,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue } },
    )).toBeNull();
  });

  test("disable refuses a trailing comment on a multiline quoted scalar's closing line", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_MULTILINE_QUOTE_COMMENT,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBeNull();
  });

  test("refresh accepts a hash inside a multiline quoted scalar continuation", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_MULTILINE_QUOTED_HASH,
      { kind: "upsert", value: MULTILINE_QUOTED_HASH_VALUE },
      { providers: { opencodex: MULTILINE_QUOTED_HASH_VALUE } },
    )).not.toBeNull();
  });

  test("disable accepts a hash inside a multiline quoted scalar continuation", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_MULTILINE_QUOTED_HASH,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBe("");
  });

  test("refresh refuses a comment hidden behind a quote on a plain-scalar continuation", () => {
    const nextValue = { ...PLAIN_CONTINUATION_VALUE, api: "openai-responses" };
    expect(patchOmpYamlSource(
      SOURCE_WITH_PLAIN_CONTINUATION_QUOTE,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue } },
    )).toBeNull();
  });

  test("disable refuses a comment hidden behind a quote on a plain-scalar continuation", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_PLAIN_CONTINUATION_QUOTE,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBeNull();
  });

  test("refresh accepts a quoted list item after a plain list item", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_QUOTED_ITEM_AFTER_PLAIN,
      { kind: "upsert", value: QUOTED_ITEM_VALUE },
      { providers: { opencodex: QUOTED_ITEM_VALUE } },
    )).not.toBeNull();
  });

  test("disable accepts a quoted list item after a plain list item", () => {
    expect(patchOmpYamlSource(
      SOURCE_WITH_QUOTED_ITEM_AFTER_PLAIN,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBe("");
  });

  test("refresh keeps the blank separator before a sibling", () => {
    const nextValue = { ...BLANK_SEPARATOR_VALUE, api: "openai-responses" };
    const result = patchOmpYamlSource(
      SOURCE_WITH_BLANK_SEPARATOR,
      { kind: "upsert", value: nextValue },
      { providers: { opencodex: nextValue, other: { api: "openai-responses" } } },
    );
    expect(result).toContain("openai-responses\n\n  other:");
  });

  test("disable keeps the blank separator before a sibling", () => {
    const result = patchOmpYamlSource(
      SOURCE_WITH_BLANK_SEPARATOR,
      { kind: "remove", removeEmptyProviders: false },
      { providers: { other: { api: "openai-responses" } } },
    );
    expect(result).toContain("providers:\n\n  other:");
  });

  test("disable scans a long blank run inside the managed block once", () => {
    const source = [
      "providers:",
      "  opencodex:",
      "    api: openai-completions",
      ...Array.from({ length: 40_000 }, () => ""),
      "    baseUrl: http://127.0.0.1:10100/v1",
      "",
    ].join("\n");

    expect(patchOmpYamlSource(
      source,
      { kind: "remove", removeEmptyProviders: true },
      {},
    )).toBe("");
  }, { timeout: 1_000 });
});
