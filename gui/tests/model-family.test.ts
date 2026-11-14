// Cases ported from Magpie's internal/catalog/family_test.go (MIT, Copyright (c) 2026 yetone).
import { describe, expect, test } from "bun:test";
import { familyOf, latestPerFamily, latestPerFamilyBy, modelFamilyKey } from "../src/lib/model-family";

describe("familyOf", () => {
  const cases: Array<[string, string, number[], string, boolean]> = [
    ["claude-opus-4-8", "claude-opus", [4, 8], "", false],
    ["claude-opus-5-5", "claude-opus", [5, 5], "", false],
    ["claude-opus-5", "claude-opus", [5], "", false],
    // a dated snapshot is its alias
    ["claude-opus-4-5-20251101", "claude-opus", [4, 5], "20251101", false],
    ["claude-haiku-4-5-20251001", "claude-haiku", [4, 5], "20251001", false],
    ["gpt-4o-2024-08-06", "gpt-o", [4], "2024-08-06", false],
    ["deepseek-r1-0528", "deepseek-r", [1], "0528", false],
    ["qwen3-235b-a22b-instruct-2507", "qwen-235b-a22b-instruct", [3], "2507", false],
    ["gemini-2.5-flash-preview-05-20", "gemini-flash", [2, 5], "05-20", true],
    ["gemini-embedding-001", "gemini-embedding", [], "001", false],
    ["command-r7b-12-2024", "command-r7b", [], "12-2024", false],
    // the version mid-name
    ["claude-3-5-sonnet-20241022", "claude-sonnet", [3, 5], "20241022", false],
    ["meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-70b-instruct", [3, 3], "", false],
    // sizes and suffixes stay in the name
    ["gpt-5.4-mini", "gpt-mini", [5, 4], "", false],
    ["gpt-5.5-pro", "gpt-pro", [5, 5], "", false],
    ["gpt-4.1-nano", "gpt-nano", [4, 1], "", false],
    ["gpt-5.3-codex-spark", "gpt-codex-spark", [5, 3], "", false],
    ["qwen3.6-27b", "qwen-27b", [3, 6], "", false],
    ["qwen3.6-35b-a3b", "qwen-35b-a3b", [3, 6], "", false],
    ["mistralai/mixtral-8x7b-instruct", "mistralai/mixtral-8x7b-instruct", [], "", false],
    ["gemma-3n-e4b-it", "gemma-n-e4b-it", [3], "", false],
    // gemini: flash, flash-lite and pro are three
    ["gemini-3.5-flash", "gemini-flash", [3, 5], "", false],
    ["gemini-3.5-flash-lite", "gemini-flash-lite", [3, 5], "", false],
    ["gemini-3.1-pro-preview", "gemini-pro", [3, 1], "", true],
    ["gemini-pro-latest", "gemini-pro", [], "", false],
    // the o-series
    ["o3", "o", [3], "", false],
    ["o4-mini", "o-mini", [4], "", false],
    ["o1-pro", "o-pro", [1], "", false],
    // a word that ends in its version
    ["kimi-k2.6", "kimi-k", [2, 6], "", false],
    ["glm-4.6v", "glm-v", [4, 6], "", false],
    ["deepseek-v4-flash", "deepseek-flash", [4], "", false],
    // a provider prefix stays
    ["anthropic/claude-opus-4.5", "anthropic/claude-opus", [4, 5], "", false],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-sonnet", [4, 5, 1, 0], "20250929", false],
    ["Qwen/Qwen3.8-27B", "qwen/qwen-27b", [3, 8], "", false],
    ["claude-sonnet-4-5[1m]", "claude-sonnet[1m", [4, 5], "", false],
  ];
  for (const [id, name, version, snapshot, preview] of cases) {
    test(id, () => {
      expect(familyOf(id)).toEqual({ name, version, snapshot, preview });
    });
  }
});

test("different models never share a family", () => {
  const pairs: Array<[string, string]> = [
    ["gpt-5.4", "gpt-5.4-mini"],
    ["gpt-5.4-mini", "gpt-5.4-nano"],
    ["gpt-5.5", "gpt-5.5-pro"],
    ["gpt-4", "gpt-4o"],
    ["o3", "o3-mini"],
    ["o3", "o3-pro"],
    ["gemini-3.5-flash", "gemini-3.1-pro-preview"],
    ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
    ["qwen3-8b", "qwen3-32b"],
    ["llama-3.1-8b-instruct", "llama-3.1-70b-instruct"],
    ["gpt-6.1-sol", "gpt-6.1-terra"],
    ["claude-opus-5-5", "claude-sonnet-5-5"],
    ["kimi-k2-thinking", "kimi-k2"],
    ["openai/gpt-5", "azure/gpt-5"],
    ["deepseek/deepseek-r1:free", "deepseek/deepseek-r1"],
  ];
  for (const [a, b] of pairs) expect(modelFamilyKey(a)).not.toBe(modelFamilyKey(b));
});

describe("latestPerFamily", () => {
  const cases: Array<[string, string[], string[]]> = [
    ["codex", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"]],
    // a newer one listed takes the old one's place by itself
    ["opus 5.6", ["claude-opus-5-6", "claude-opus-5-5", "claude-sonnet-5-5"], ["claude-opus-5-6", "claude-sonnet-5-5"]],
    ["openai sizes", ["gpt-5.6", "gpt-5.5", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-nano", "gpt-5.4-nano", "gpt-5.5-pro", "gpt-5-pro"],
      ["gpt-5.6", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5-pro"]],
    ["o-series", ["o1", "o3", "o3-mini", "o4-mini", "o1-pro", "o3-pro"], ["o3", "o4-mini", "o3-pro"]],
    ["gemini", ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.5-pro", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite", "gemini-pro-latest"],
      ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"]],
    // at one version, a release over its preview
    ["preview", ["gemini-3-pro-image-preview", "gemini-3-pro-image"], ["gemini-3-pro-image"]],
    // the alias over its dated snapshots
    ["snapshots", ["gpt-4o", "gpt-4o-2024-08-06", "gpt-4o-2024-11-20"], ["gpt-4o"]],
    ["snapshots alone", ["mistral-medium-2505", "mistral-medium-2508"], ["mistral-medium-2508"]],
    ["qwen sizes", ["Qwen/Qwen3.5-27B", "Qwen/Qwen3.6-27B", "Qwen/Qwen3.8-27B", "Qwen/Qwen3.6-35B-A3B", "Qwen/Qwen3.5-35B-A3B"],
      ["Qwen/Qwen3.8-27B", "Qwen/Qwen3.6-35B-A3B"]],
    ["mid-name version", ["claude-3-5-sonnet-20241022", "claude-sonnet-4-5"], ["claude-sonnet-4-5"]],
    ["bedrock", ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us.anthropic.claude-sonnet-5-5", "us.meta.llama3-1-70b-instruct-v1:0", "us.meta.llama3-3-70b-instruct-v1:0"],
      ["us.anthropic.claude-sonnet-5-5", "us.meta.llama3-3-70b-instruct-v1:0"]],
    ["provider prefix", ["openai/gpt-5.5", "openai/gpt-5.6", "azure/gpt-5.5"], ["openai/gpt-5.6", "azure/gpt-5.5"]],
    ["none", [], []],
  ];
  for (const [name, input, want] of cases) {
    test(name, () => {
      expect(latestPerFamily(input)).toEqual(want);
    });
  }

  test("keeps rows by their id, in order", () => {
    const rows = [{ id: "claude-sonnet-4-5", n: 1 }, { id: "gpt-5", n: 2 }, { id: "claude-sonnet-4-6", n: 3 }, { id: "gpt-5.1", n: 4 }];
    expect(latestPerFamilyBy(rows, (row) => row.id).map((row) => row.n)).toEqual([3, 4]);
  });

  test("keeps every row that carries the newest id, such as a native and a custom row", () => {
    const rows = [{ id: "gpt-5", n: 1 }, { id: "gpt-5.1", n: 2 }, { id: "gpt-5.1", n: 3 }];
    expect(latestPerFamilyBy(rows, (row) => row.id).map((row) => row.n)).toEqual([2, 3]);
  });

  test("compares dated snapshots by date whatever their separators", () => {
    expect(latestPerFamily(["claude-sonnet-4-5-20251101", "claude-sonnet-4-5-2025-12-01"])).toEqual(["claude-sonnet-4-5-2025-12-01"]);
    expect(latestPerFamily(["claude-sonnet-4-5-2025-12-01", "claude-sonnet-4-5-20251101"])).toEqual(["claude-sonnet-4-5-2025-12-01"]);
  });
});
