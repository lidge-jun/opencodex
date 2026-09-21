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
});
