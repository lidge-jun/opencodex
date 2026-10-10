import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeAutoReviewModelOverride,
  resolveAutoReviewOverrideSelector,
} from "../../src/codex/catalog/auto-review";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { OcxConfig } from "../../src/types";

/**
 * The global override block (Models settings -> Auto-review override) is the GUI-facing
 * selector. It has to sit between provider stamps and Codex's own root `auto_review_model`,
 * and disabling it must fall back rather than leave the previous stamp behind.
 */
const OVERRIDE = "9router/ocg-muse-spark-1.3-contributor";
const ROOT = "9router/ocg-deepseek-v4.1-flash";

let home: string | undefined;
let previousHome: string | undefined;

/** A temp CODEX_HOME so the root-selector fallback reads a fixture, never the developer's config. */
function codexHomeWith(rootModel: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-auto-review-"));
  writeFileSync(join(dir, "config.toml"), `auto_review_model = "${rootModel}"\n`);
  return dir;
}

function rows(): RawEntry[] {
  // The override target must exist in the final catalog, so the fixture carries it as a row.
  return [
    { slug: "gpt-5.6-sol" },
    { slug: "9router/ocg-deepseek-v4.1-flash" },
    { slug: OVERRIDE },
  ] as unknown as RawEntry[];
}

function configWith(block: OcxConfig["autoReviewOverride"], providers: OcxConfig["providers"] = {}): Pick<OcxConfig, "providers" | "autoReviewOverride"> {
  return { providers, autoReviewOverride: block };
}

beforeEach(() => { previousHome = process.env.CODEX_HOME; });
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (home) { rmSync(home, { recursive: true, force: true }); home = undefined; }
});

describe("resolveAutoReviewOverrideSelector", () => {
  test("returns a trimmed selector only while the block is enabled and nonblank", () => {
    expect(resolveAutoReviewOverrideSelector(configWith({ enabled: true, model: ` ${OVERRIDE} ` }))).toBe(OVERRIDE);
    expect(resolveAutoReviewOverrideSelector(configWith({ enabled: true, model: "   " }))).toBeUndefined();
    expect(resolveAutoReviewOverrideSelector(configWith({ enabled: false, model: OVERRIDE }))).toBeUndefined();
    expect(resolveAutoReviewOverrideSelector(configWith({}))).toBeUndefined();
    expect(resolveAutoReviewOverrideSelector(undefined)).toBeUndefined();
  });
});

describe("finalizeAutoReviewModelOverride with the global override", () => {
  test("stamps every unowned row and wins over Codex's root selector", () => {
    home = codexHomeWith(ROOT);
    process.env.CODEX_HOME = home;
    const models = rows();
    const result = finalizeAutoReviewModelOverride(models, [], configWith({ enabled: true, model: OVERRIDE }));
    expect(result).toBe("applied");
    for (const row of models) expect(row.auto_review_model_override).toBe(OVERRIDE);
  });

  test("falls back to Codex's root selector when the block is disabled", () => {
    home = codexHomeWith(ROOT);
    process.env.CODEX_HOME = home;
    const models = rows();
    finalizeAutoReviewModelOverride(models, [], configWith({ enabled: false, model: OVERRIDE }));
    for (const row of models) expect(row.auto_review_model_override).toBe(ROOT);
  });

  test("a provider-scoped stamp keeps its precedence over the global override", () => {
    home = codexHomeWith(ROOT);
    process.env.CODEX_HOME = home;
    const models = rows();
    finalizeAutoReviewModelOverride(models, [], configWith(
      { enabled: true, model: OVERRIDE },
      { "9router": { adapter: "openai-responses", baseUrl: "https://router.example.test/v1", autoReviewModel: "gpt-5.6-sol" } } as unknown as OcxConfig["providers"],
    ));
    const routed = models.find(row => row.slug === "9router/ocg-deepseek-v4.1-flash");
    expect(routed?.auto_review_model_override).toBe("gpt-5.6-sol");
  });
});
