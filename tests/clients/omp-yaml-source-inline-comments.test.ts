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
});
