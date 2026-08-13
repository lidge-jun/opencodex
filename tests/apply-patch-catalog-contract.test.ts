import { expect, test } from "bun:test";
import { ensureStrictCatalogFields, normalizeRoutedCatalogEntry } from "../src/codex/catalog/parsing";

test("routed catalog rows force Codex apply_patch to the freeform tool contract", () => {
  const row = normalizeRoutedCatalogEntry({
    slug: "xai/grok-4.6",
    tool_mode: "legacy",
    apply_patch_tool_type: "function",
    context_window: 128_000,
  });

  expect(row.tool_mode).toBe("code_mode_only");
  expect(row.apply_patch_tool_type).toBe("freeform");
});

test("native catalog rows preserve an explicit apply_patch tool type", () => {
  const row = ensureStrictCatalogFields({
    slug: "gpt-5.6-sol",
    apply_patch_tool_type: "function",
    context_window: 128_000,
  });

  expect(row.apply_patch_tool_type).toBe("function");
});
