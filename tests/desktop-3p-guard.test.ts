import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDesktop3pModelsValid } from "../src/claude/desktop-3p-guard";
import { generateDesktop3pModels, writeDesktop3pConfig } from "../src/claude/desktop-3p";
import type { Desktop3pModelEntry } from "../src/claude/desktop-3p";

/**
 * D2: the Desktop 3P output guard. The name was never the leak (non-Anthropic names
 * are hashed); the label was. Normalization runs first, the guard validates the
 * resulting entries, and both are proven against the REAL generator output, not only
 * synthetic fixtures.
 */

function entry(overrides: Partial<Desktop3pModelEntry>): Desktop3pModelEntry {
  return {
    name: "claude-opus-4-8-abc",
    labelOverride: "Some Model (prov)",
    anthropicFamilyTier: "opus",
    ...overrides,
  };
}

test("k3[1m] renders as a clean label with no bracket marker", () => {
  const models = generateDesktop3pModels([], [
    { provider: "kimi", id: "k3[1m]", contextWindow: 1_048_576 },
  ]);
  const kimi = models.find(m => m.labelOverride.includes("kimi"));
  expect(kimi).toBeDefined();
  expect(kimi!.labelOverride).toBe("K3 1M (kimi)");
  expect(kimi!.labelOverride).not.toContain("[");
  expect(kimi!.labelOverride).not.toContain("]");
  // The hashed name is untouched — names were never the leak.
  expect(kimi!.name).toMatch(/^claude-opus-4-8-/);
});

test("the real generator output passes the guard for a representative catalog", () => {
  const models = generateDesktop3pModels(["gpt-5.6-sol"], [
    { provider: "kimi", id: "k3[1m]", contextWindow: 1_048_576 },
    { provider: "google-antigravity", id: "gemini-3.1-pro", contextWindow: 1_048_576 },
    { provider: "alibaba-token-plan-intl", id: "glm-5.2", contextWindow: 1_000_000 },
  ]);
  expect(() => assertDesktop3pModelsValid(models)).not.toThrow();
});

test("the guard rejects an invalid name shape", () => {
  expect(() => assertDesktop3pModelsValid([entry({ name: "Kimi-K3" })]))
    .toThrow(/not a valid Claude-shaped id/);
});

test("the guard rejects a duplicated name (collision-skip regression net)", () => {
  expect(() => assertDesktop3pModelsValid([entry({}), entry({})]))
    .toThrow(/duplicated/);
});

test("the guard rejects a label that still carries a bracket marker", () => {
  expect(() => assertDesktop3pModelsValid([entry({ labelOverride: "K3[1m] (kimi)" })]))
    .toThrow(/capability marker/);
});

test("the guard rejects an over-long label", () => {
  expect(() => assertDesktop3pModelsValid([entry({ labelOverride: `${"x".repeat(81)} (p)` })]))
    .toThrow(/exceeds/);
});

test("writeDesktop3pConfig emits a config whose model list passes the guard end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocx-desktop-guard-"));
  const prev = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = dir;
  try {
    const result = writeDesktop3pConfig(
      10100,
      ["gpt-5.6-sol"],
      [{ provider: "kimi", id: "k3[1m]", contextWindow: 1_048_576 }],
      "test-key",
      "static",
    );
    expect(result.written).toBe(true);
    const written = JSON.parse(readFileSync(result.path, "utf8")) as {
      inferenceModels: Desktop3pModelEntry[];
    };
    expect(() => assertDesktop3pModelsValid(written.inferenceModels)).not.toThrow();
    const kimi = written.inferenceModels.find(m => m.labelOverride.includes("kimi"));
    expect(kimi?.labelOverride).toBe("K3 1M (kimi)");
  } finally {
    if (prev === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
    else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
