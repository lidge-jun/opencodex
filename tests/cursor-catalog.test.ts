import { describe, expect, test } from "bun:test";
import {
  CURSOR_CAPABILITIES,
  cursorUmbrellaRows,
  parseCursorVariantId,
  recordLiveCursorClaudeModels,
  resetLiveCursorClaudeWireIdentitiesForTests,
  resolveCursorSelection,
} from "../src/adapters/cursor/catalog";
import {
  cursorEffortSuffix,
  cursorModelHasEffortTiers,
  cursorRequestWireModelIdWithEffort,
  CURSOR_THINKING_MODEL_IDS,
} from "../src/adapters/cursor/effort-map";

/**
 * The frozen legacy picker ids (discovery.ts static seed minus the 4 router
 * rows). The legacy effort-map is the back-compat ORACLE: for every id and
 * every Codex effort, the new resolver must produce the identical wire id.
 */
const LEGACY_EFFORT_IDS = [
  "claude-4.5-opus", "claude-4.6-opus", "claude-4.6-sonnet",
  "claude-fable-5", "claude-opus-4-7", "claude-opus-4-7-fast",
  "claude-opus-4-8", "claude-opus-4-8-fast", "claude-opus-5-fast",
  "claude-sonnet-5", "glm-5.2", "glm-5.3", "gemini-3.6-flash",
  "gemini-3.7-flash", "kimi-k3", "kimi-k3-1m", "grok-4.5", "grok-4.5-fast",
  "grok-4.6", "grok-4.6-fast", "gpt-5.1", "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex",
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "gpt-5.5-extra",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  ...CURSOR_THINKING_MODEL_IDS,
] as const;

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra", undefined] as const;

const EXISTING_CLAUDE_WIRE_SNAPSHOT = {
  "claude-opus-5@high": "claude-opus-5-thinking-high",
  "claude-opus-5-thinking-fast@max": "claude-opus-5-thinking-max-fast",
  "claude-4.6-opus@max": "claude-4.6-opus-max-thinking",
  "claude-4.6-opus-thinking@high": "claude-4.6-opus-high-thinking",
  "claude-4.5-sonnet@high": "claude-4.5-sonnet-thinking",
  "claude-4.5-sonnet-thinking@max": "claude-4.5-sonnet-thinking",
} as const;

function existingClaudeWireSnapshot(): Record<keyof typeof EXISTING_CLAUDE_WIRE_SNAPSHOT, string> {
  return {
    "claude-opus-5@high": resolveCursorSelection("claude-opus-5", "high").wireId,
    "claude-opus-5-thinking-fast@max": resolveCursorSelection("claude-opus-5-thinking-fast", "max").wireId,
    "claude-4.6-opus@max": resolveCursorSelection("claude-4.6-opus", "max").wireId,
    "claude-4.6-opus-thinking@high": resolveCursorSelection("claude-4.6-opus-thinking", "high").wireId,
    "claude-4.5-sonnet@high": resolveCursorSelection("claude-4.5-sonnet", "high").wireId,
    "claude-4.5-sonnet-thinking@max": resolveCursorSelection("claude-4.5-sonnet-thinking", "max").wireId,
  };
}

/** Legacy composition: what request-builder sends today for a picked id + effort. */
function legacyWireId(pickedId: string, reasoning: string | undefined): string {
  // request-builder strips the synthetic -1m marker before composing.
  const baseId = pickedId === "kimi-k3-1m" ? "kimi-k3" : pickedId;
  if (!cursorModelHasEffortTiers(baseId)) return baseId;
  const suffix = cursorEffortSuffix(baseId, reasoning);
  if (suffix === undefined) return baseId;
  return cursorRequestWireModelIdWithEffort(baseId, suffix);
}

/**
 * The ONE intentional behavior change of the umbrella redesign: a bare claude
 * base id now routes its THINKING variant (user decision: thinking merges into
 * the base identity). Every other id x effort combination must stay byte-equal
 * to the legacy effort-map composition.
 */
const INTENTIONAL_THINKING_DEFAULTS = new Set(
  Object.entries(CURSOR_CAPABILITIES)
    .filter(([, capability]) => capability.defaultVariant === "thinking")
    .map(([baseId]) => baseId),
);

describe("cursor umbrella catalog (devlog 260828_cursor_umbrella_catalog)", () => {
  describe("back-compat oracle: byte-equal wire ids for every legacy id x effort", () => {
    for (const id of LEGACY_EFFORT_IDS) {
      if (INTENTIONAL_THINKING_DEFAULTS.has(id)) continue;
      test(`legacy ${id} resolves to the same wire ids as the effort-map`, () => {
        for (const effort of CODEX_EFFORTS) {
          const resolved = resolveCursorSelection(id, effort);
          expect(`${id}@${effort}: ${resolved.wireId}`).toBe(`${id}@${effort}: ${legacyWireId(id, effort)}`);
        }
      });
    }

    test("intentional change: bare claude bases route their thinking variant now", () => {
      for (const id of INTENTIONAL_THINKING_DEFAULTS) {
        for (const effort of CODEX_EFFORTS) {
          const resolved = resolveCursorSelection(id, effort);
          // The thinking variant's own legacy id must produce the SAME wire id —
          // proving the merge maps onto an id the wire already served.
          const thinkingLegacy = legacyWireId(
            id === "claude-4.5-sonnet" || id === "claude-4-sonnet" ? `${id}-thinking` : `${id}-thinking`,
            effort,
          );
          expect(`${id}@${effort}: ${resolved.wireId}`).toBe(`${id}@${effort}: ${thinkingLegacy}`);
        }
      }
    });

    test("legacy thinking/fast slugs stay byte-equal (alias retention)", () => {
      for (const id of LEGACY_EFFORT_IDS) {
        if (!INTENTIONAL_THINKING_DEFAULTS.has(id)) continue;
        // The variant slugs themselves (claude-x-thinking, -fast, ...) are
        // covered by the main loop; here we re-assert the base's non-default
        // variants remain reachable via their legacy slugs.
        const fastSlug = `${id}-fast`;
        if ((LEGACY_EFFORT_IDS as readonly string[]).includes(fastSlug)) {
          for (const effort of CODEX_EFFORTS) {
            expect(resolveCursorSelection(fastSlug, effort).wireId).toBe(legacyWireId(fastSlug, effort));
          }
        }
      }
    });

    test("existing Claude wire ids are byte-identical before and after live-roster state is reset", () => {
      resetLiveCursorClaudeWireIdentitiesForTests();
      const before = existingClaudeWireSnapshot();
      try {
        recordLiveCursorClaudeModels([
          "claude-5-opus-thinking-high",
          "claude-opus-4-6-thinking-high",
          "claude-sonnet-4-5-thinking",
        ]);
      } finally {
        resetLiveCursorClaudeWireIdentitiesForTests();
      }
      const after = existingClaudeWireSnapshot();
      expect(before).toEqual(EXISTING_CLAUDE_WIRE_SNAPSHOT);
      expect(after).toEqual(EXISTING_CLAUDE_WIRE_SNAPSHOT);
    });
  });

  describe("parser precedence", () => {
    test("exact base identities never mis-parse as effort suffixes", () => {
      expect(parseCursorVariantId("gpt-5.1-codex-max")).toMatchObject({ baseId: "gpt-5.1-codex-max", kind: "regular", known: true });
      expect(parseCursorVariantId("gpt-5.5-extra")).toMatchObject({ baseId: "gpt-5.5-extra", kind: "regular", known: true });
    });

    test("cursor- prefixed wire forms round-trip to prefix-free bases", () => {
      expect(parseCursorVariantId("cursor-grok-4.6-xhigh")).toMatchObject({ baseId: "grok-4.6", level: "xhigh", kind: "regular", known: true });
      expect(parseCursorVariantId("cursor-grok-4.5-high")).toMatchObject({ baseId: "grok-4.5", level: "high", kind: "regular", known: true });
    });

    test("synthetic -1m marker parses as ultra on the base", () => {
      expect(parseCursorVariantId("kimi-k3-1m")).toMatchObject({ baseId: "kimi-k3", ultra: true, known: true });
    });

    test("thinking and fast dimensions parse from every observed shape", () => {
      expect(parseCursorVariantId("claude-opus-5-thinking-high")).toMatchObject({ baseId: "claude-opus-5", kind: "thinking", level: "high" });
      expect(parseCursorVariantId("claude-opus-5-thinking-high-fast")).toMatchObject({ baseId: "claude-opus-5", kind: "thinkingFast", level: "high" });
      expect(parseCursorVariantId("claude-4.6-opus-high-thinking")).toMatchObject({ baseId: "claude-4.6-opus", kind: "thinking", level: "high" });
      expect(parseCursorVariantId("claude-4-sonnet-thinking")).toMatchObject({ baseId: "claude-4-sonnet", kind: "thinking" });
      expect(parseCursorVariantId("grok-4.6-high-fast")).toMatchObject({ baseId: "grok-4.6", kind: "fast", level: "high" });
    });

    test("every Fable 5.1 spelling parses to the canonical capability base", () => {
      for (const id of ["claude-fable-5-1", "claude-fable-5.1", "claude-5.1-fable"]) {
        expect(parseCursorVariantId(id), id).toMatchObject({
          baseId: "claude-fable-5-1",
          kind: "thinking",
          known: true,
        });
      }
    });

    test("unknown ids pass through unchanged", () => {
      const parsed = parseCursorVariantId("composer-9.9-special");
      expect(parsed.known).toBe(false);
      expect(resolveCursorSelection("composer-9.9-special", "high").wireId).toBe("composer-9.9-special");
    });
  });

  describe("umbrella semantics", () => {
    test("thinking merges into the base: picking the base routes the thinking variant", () => {
      const resolved = resolveCursorSelection("claude-opus-5", "high");
      expect(resolved.wireId).toBe("claude-opus-5-thinking-high");
    });

    test("bare-thinking families ignore effort", () => {
      expect(resolveCursorSelection("claude-4-sonnet", "max").wireId).toBe("claude-4-sonnet-thinking");
    });

    test("per-variant ladders diverge: opus-5 fast clamps to high, thinking-fast reaches max", () => {
      expect(resolveCursorSelection("claude-opus-5-fast", "max").wireId).toBe("claude-opus-5-high-fast");
      expect(resolveCursorSelection("claude-opus-5-thinking-fast", "max").wireId).toBe("claude-opus-5-thinking-max-fast");
    });

    test("Fable 5.1 saved aliases stay routable with their exact spelling when no roster is recorded", () => {
      resetLiveCursorClaudeWireIdentitiesForTests();
      expect(resolveCursorSelection("claude-fable-5.1", "high").wireId).toBe("claude-fable-5.1-thinking-high");
      expect(resolveCursorSelection("claude-5.1-fable", "max").wireId).toBe("claude-5.1-fable-max-thinking");
      expect(resolveCursorSelection("claude-fable-5.1-thinking", "xhigh").wireId)
        .toBe("claude-fable-5.1-thinking-xhigh");
      expect(resolveCursorSelection("claude-5.1-fable-thinking", "max").wireId)
        .toBe("claude-5.1-fable-max-thinking");
    });

    test("the live roster spelling overrides both requested and canonical spellings", () => {
      recordLiveCursorClaudeModels(["claude-5.1-fable-high-thinking"]);
      try {
        expect(resolveCursorSelection("claude-fable-5-1", "high").wireId).toBe("claude-5.1-fable-high-thinking");
        expect(resolveCursorSelection("claude-fable-5.1", "high").wireId).toBe("claude-5.1-fable-high-thinking");
      } finally {
        resetLiveCursorClaudeWireIdentitiesForTests();
      }
    });

    test("ultra arms maxMode only on evidence-gated bases", () => {
      const kimi = resolveCursorSelection("kimi-k3-1m", "ultra");
      expect(kimi.maxMode).toBe(true);
      expect(kimi.wireId).toBe("kimi-k3-max");
      const claude = resolveCursorSelection("claude-opus-4-8", "ultra");
      expect(claude.maxMode).toBe(false);
      expect(claude.wireId).toBe("claude-opus-4-8-thinking-max");
    });

    test("live maxModeModels evidence extends the static gate", () => {
      const live = new Set(["claude-opus-4-8"]);
      expect(resolveCursorSelection("claude-opus-4-8", "ultra", live).maxMode).toBe(true);
      expect(resolveCursorSelection("claude-opus-4-8", "high", live).maxMode).toBe(false);
    });

    test("umbrella rows: one per base, quarantined default excluded, thinking sibling honored", () => {
      const rows = cursorUmbrellaRows();
      const ids = rows.map(row => row.id);
      expect(ids).toContain("claude-opus-5");
      expect(ids).not.toContain("claude-opus-5-thinking");
      expect(ids).not.toContain("claude-opus-5-fast");
      expect(ids).not.toContain("kimi-k3-1m");
      expect(ids.filter(id => id.includes("fable") && id.includes("5-1"))).toEqual(["claude-fable-5-1"]);
      expect(rows.length).toBe(Object.keys(CURSOR_CAPABILITIES).length);
      const kimi = rows.find(row => row.id === "kimi-k3");
      expect(kimi?.maxModeVerified).toBe(true);
      expect(kimi?.window).toBe(1_000_000);
    });

    test("variant-specific quarantine: opus-5 regular quarantined, umbrella row still present via thinking default", () => {
      expect(CURSOR_CAPABILITIES["claude-opus-5"]!.variants.regular?.quarantined).toBe(true);
      expect(CURSOR_CAPABILITIES["claude-opus-5"]!.defaultVariant).toBe("thinking");
    });
  });
});
