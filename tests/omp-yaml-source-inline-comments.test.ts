import { describe, expect, test } from "bun:test";
import { patchOmpYamlSource } from "../src/integrations/omp-yaml-source";

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
});
