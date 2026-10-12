// 260924: the catalog block is model-neutral on disk (#5217) — the assertion side of the change.
//
// Codex stores a session's instruction block once and replays it verbatim when it spawns a
// sub-agent on a DIFFERENT model, so a model id baked into `base_instructions` follows the worker
// and makes it answer identity questions with the parent's id. The destination id is written at
// request time instead. These cases exist so the negative half of that contract — no row may bake
// an id in — is asserted against the rows themselves, not only against the sentence that replaced
// it. `codex-catalog.test.ts` sits at its line cap, so the coverage lives here.
import { describe, expect, test } from "bun:test";
import { NEUTRAL_IDENTITY_LINE } from "../../src/adapters/identity";
import {
  buildCatalogEntries,
  deriveComboCatalogModel,
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import type { NormalizedComboConfig } from "../../src/combos/types";

/** The pinned native template every routed row derives from; its identity line is Codex's own. */
function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    multi_agent_version: "v2",
  };
}

function comboConfig(): NormalizedComboConfig {
  return {
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: "medium",
    reasoningEffortMode: "strict",
    imageInput: "auto",
    alias: null,
    nativeAlias: false,
    displayName: null,
    targets: [
      { provider: "a", model: "m1", weight: 1 },
      { provider: "b", model: "m2", weight: 1 },
    ],
  };
}

/** Two identically capable members: the combo row derives from the intersection of all of them. */
const members = ["m1", "m2"].map((id, index) => ({
  provider: index === 0 ? "a" : "b",
  id,
  contextWindow: 200_000,
  maxInputTokens: 180_000,
  inputModalities: ["text"],
  reasoningEfforts: ["low"],
  parallelToolCalls: true,
}));

describe("catalog identity text is model-neutral on disk (#5217)", () => {
  test("a routed row names no model and keeps the rest of its instructions", () => {
    const rows = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "zenmux", id: "moonshotai/kimi-k3-free" },
    ]);
    const routed = rows.find(row => row.slug === "zenmux/moonshotai-kimi-k3-free")!;
    expect(routed.base_instructions).toContain(NEUTRAL_IDENTITY_LINE);
    expect(routed.base_instructions).not.toContain("powered by the");
    expect(routed.base_instructions).not.toContain("moonshotai/kimi-k3-free");
    expect(routed.base_instructions).toContain("Use tools carefully.");
  });

  test("a native-slug custom row is neutral as well", () => {
    const rows = buildCatalogEntries(nativeTemplate(), [], [
      { provider: "openai", id: NATIVE_GPT6_ASTRA_MODEL },
    ]);
    const astra = rows.find(row => row.slug === `openai/${NATIVE_GPT6_ASTRA_MODEL}`)!;
    expect(astra.base_instructions).toContain(NEUTRAL_IDENTITY_LINE);
    expect(astra.base_instructions).not.toContain("powered by the");
  });

  test("a combo alias row names the alias nowhere in its instructions", () => {
    const combo = deriveComboCatalogModel("mixed", comboConfig(), members)!;
    const rows = buildCatalogEntries(nativeTemplate(), [], [combo], undefined, false, "default", new Set(["mixed"]));
    expect(rows[0]!.base_instructions).toContain(NEUTRAL_IDENTITY_LINE);
    expect(rows[0]!.base_instructions).not.toContain("powered by the");
  });

  test("a native capability alias row is neutral in both instruction fields", () => {
    // Daybreak borrows Sol's pinned row, so both its `base_instructions` and the model_messages
    // template are rewritten on the way out of the pinned snapshot.
    const source = upstreamNativeEntry(NATIVE_DAYBREAK_BLUE_MODEL)!;
    expect(source.base_instructions).toContain(NEUTRAL_IDENTITY_LINE);
    expect(source.base_instructions).not.toContain("powered by the");
    expect(source.base_instructions).not.toContain(NATIVE_DAYBREAK_BLUE_MODEL);
    const template = (source.model_messages as { instructions_template?: string })?.instructions_template;
    expect(template).toContain(NEUTRAL_IDENTITY_LINE);
    expect(template).not.toContain("powered by the");
  });

  test("a self-described native row keeps Codex's own line", () => {
    // Neutralization is the routed/alias path. Astra ships its own pinned row, so its identity line
    // is Codex's — the guard against a widening that would rewrite first-party rows too.
    const astra = upstreamNativeEntry(NATIVE_GPT6_ASTRA_MODEL)!;
    expect(astra.base_instructions).toContain("You are Codex");
    expect(astra.base_instructions).not.toContain("powered by the");
  });
});
