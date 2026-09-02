import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGrokManagedBlock, injectGrokConfig } from "../src/grok/inject";
import { syncGrokConfig } from "../src/grok/sync";
import { nativeOpenAiContextWindow, visibleNativeSlugs } from "../src/codex/catalog";
import type { CatalogModel } from "../src/codex/catalog";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Alias-stable exclusion (WP3, audit blocker 3): aliases are allocated over the
 * UNFILTERED list and excluded entries consume their slot without emitting a table —
 * so a model's alias never depends on which other models are switched off.
 */

const MODELS = [
  { id: "kimi/k3", contextWindow: 262_144 },
  { id: "kimi/k3[1m]", contextWindow: 1_048_576 },
  { id: "cursor/grok-4.5", contextWindow: 500_000 },
];

function tempGrokHome(): { root: string; grokHome: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-grok-sel-"));
  const grokHome = join(root, ".grok");
  mkdirSync(grokHome);
  return { root, grokHome };
}

test("no exclusions is byte-identical to the old writer", () => {
  expect(buildGrokManagedBlock(10100, MODELS))
    .toBe(buildGrokManagedBlock(10100, MODELS, undefined, undefined, new Set()));
});

test("excluding one id omits exactly that table and keeps the others", () => {
  const block = buildGrokManagedBlock(10100, MODELS, undefined, undefined, new Set(["cursor/grok-4.5"]));
  expect(block).not.toContain('model = "cursor/grok-4.5"');
  expect(block).toContain('model = "kimi/k3"');
  expect(block).toContain('model = "kimi/k3[1m]"');
});

test("excluding an unknown id changes nothing", () => {
  expect(buildGrokManagedBlock(10100, MODELS, undefined, undefined, new Set(["nope/model"])))
    .toBe(buildGrokManagedBlock(10100, MODELS));
});

// THE audit regression: kimi/k3 and kimi/k3[1m] both sanitize toward ocx-kimi-k3-….
// Switching the first off must NOT rename the second's alias.
test("excluding a colliding model leaves the survivor's alias unchanged", () => {
  const full = buildGrokManagedBlock(10100, [
    { id: "kimi/k3" },
    { id: "kimi-k3" },   // sanitizes to the same base alias as kimi/k3
  ]);
  const filtered = buildGrokManagedBlock(10100, [
    { id: "kimi/k3" },
    { id: "kimi-k3" },
  ], undefined, undefined, new Set(["kimi/k3"]));

  const survivorAlias = /\[model\.(ocx-[^\]]+)\][^[]*model = "kimi-k3"/.exec(full)?.[1];
  expect(survivorAlias).toBe("ocx-kimi-k3-2");
  expect(filtered).toContain(`[model.${survivorAlias}]`);
  expect(filtered).not.toContain('model = "kimi/k3"');
});

// The first-emitted-table blank-line rule: excluding the FIRST model must not leave a
// stray blank line or merge the marker with the next table.
test("excluding the first model keeps the TOML shape valid", () => {
  const block = buildGrokManagedBlock(10100, MODELS, undefined, undefined, new Set(["kimi/k3"]));
  const afterMarker = block.split("do not edit (removed by `ocx stop`) >>>\n")[1]!;
  // The provider block is always present; the first [model.*] table may be excluded.
  expect(afterMarker.trimStart().startsWith("[model_providers.")).toBe(true);
  expect(block).not.toContain("\n\n\n");
});

// Activation evidence for the empty case: excluding EVERY model is a valid
// "registered nothing" fence, and strip still removes it cleanly.
test("excluding everything writes a marker-only fence that strip removes", () => {
  const { root, grokHome } = tempGrokHome();
  try {
    const result = injectGrokConfig(10100, MODELS, { grokHome, excluded: new Set(MODELS.map(m => m.id)) });
    expect(result.ok).toBe(true);
    const content = readFileSync(join(grokHome, "config.toml"), "utf8");
    expect(content).toContain(">>> opencodex managed block");
    expect(content).not.toContain("[model.");
  } finally {
    removeTreeWithRetry(root);
  }
});

test("a user-reserved alias still pushes generated aliases past it while exclusions are active", () => {
  const { root, grokHome } = tempGrokHome();
  try {
    writeFileSync(join(grokHome, "config.toml"), '[model.ocx-kimi-k3]\nmodel = "mine"\n', "utf8");
    const result = injectGrokConfig(10100, [{ id: "kimi/k3" }, { id: "kimi-k3" }], {
      grokHome,
      excluded: new Set(["kimi/k3"]),
    });
    expect(result.ok).toBe(true);
    const content = readFileSync(join(grokHome, "config.toml"), "utf8");
    // The user's own table is preserved verbatim outside the fence.
    expect(content).toContain('[model.ocx-kimi-k3]\nmodel = "mine"');
    // And the survivor's generated alias starts AFTER the reservation, not at -1.
    expect(content).not.toContain("[model.ocx-kimi-k3]\nmodel = \"kimi-k3\"");
  } finally {
    removeTreeWithRetry(root);
  }
});

const baseConfig = { port: 10100, defaultProvider: "openai", providers: {} } as unknown as OcxConfig;

test("syncGrokConfig with grokExcludedModels omits that model's table end to end", async () => {
  const { root, grokHome } = tempGrokHome();
  try {
    const routed: CatalogModel[] = [
      { id: "grok-4.5", provider: "cursor", contextWindow: 500_000 } as CatalogModel,
    ];
    const config = { ...baseConfig, grokExcludedModels: ["cursor/grok-4.5"] } as OcxConfig;
    const result = await syncGrokConfig(10190, config, { grokHome }, {
      fetchAllModels: async () => routed,
      injectGrokConfig,
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    const content = readFileSync(join(grokHome, "config.toml"), "utf8");
    expect(content).not.toContain('model = "cursor/grok-4.5"');
    // Natives are untouched and still carry their windows.
    expect(content).toContain("[model.ocx-gpt-");
    expect(content).toContain(`context_window = ${nativeOpenAiContextWindow("gpt-5.6-sol")}`);
    expect(visibleNativeSlugs(config).length).toBeGreaterThan(0);
  } finally {
    removeTreeWithRetry(root);
  }
});
