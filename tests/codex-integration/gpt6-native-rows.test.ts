/**
 * GPT-6 Sol, Luna and Astra Minor native rows.
 *
 * Held in its own file because tests/codex-integration/codex-catalog.test.ts sits at its
 * file-size ratchet cap (see AGENTS.md, "The file-size ratchet has almost no headroom").
 *
 * Evidence: the authenticated roster probe of 2026-09-23
 * (`chatgpt.com/backend-api/codex/models?client_version=0.155.0`, main account), pinned verbatim
 * in src/codex/data/roster-pinned-models.json, and
 * https://openai.com/index/introducing-gpt-6-sol-and-luna/ (announced 2026-09-22).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  buildCatalogEntries,
  NATIVE_OPENAI_MODELS,
  nativeDefaultReasoningEffort,
  nativeInputModalities,
  nativeOpenAiCapabilitySourceSlug,
  nativeOpenAiContextTier,
  nativeOpenAiContextWindow,
  nativeReasoningEfforts,
  upstreamNativeEntry,
} from "../../src/codex/catalog";
import {
  ACCOUNT_GATED_NATIVE_OPENAI_MODELS,
  NATIVE_GPT6_ASTRA_MINOR_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
  NATIVE_GPT6_LUNA_MODEL,
  NATIVE_GPT6_SOL_MODEL,
  NATIVE_MAIN_DRAIN_SENTINEL_MODELS,
  SELF_DESCRIBED_NATIVE_OPENAI_MODELS,
  hasNativeOpenAiCapabilityMetadata,
  isNativeOpenAiCapabilityAliasModel,
  nativeOpenAiAliasPresentation,
} from "../../src/codex/catalog/native-models";
import { isGpt56NativeSlug, nativeLadderIncludesUltra } from "../../src/codex/catalog/effort";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS, nativeOpenAiCapabilityDisplayName } from "../../src/codex/catalog/metadata";
import { pinnedNativeModelRows } from "../../src/codex/catalog/pinned-models";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { repoPath } from "../helpers/repo-root";

afterEach(() => resetCodexModelEntitlementCacheForTests());

type Row = { slug?: unknown; supported_reasoning_levels?: Array<{ effort?: string }> };

function readRows(rel: string): Row[] {
  return (JSON.parse(readFileSync(repoPath(rel), "utf8")) as { models?: Row[] }).models ?? [];
}

function efforts(entry: { supported_reasoning_levels?: unknown } | null | undefined): string[] {
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

const SOL_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LUNA_LADDER = ["low", "medium", "high", "xhigh", "max"];

describe("GPT-6 Sol and Luna are self-described flagship natives", () => {
  test("each projects its own roster row with its own label, windows and exact ladder", () => {
    const cases = [
      { slug: NATIVE_GPT6_SOL_MODEL, wire: "gpt-6-sol", displayName: "GPT-6-Sol", ladder: SOL_LADDER },
      { slug: NATIVE_GPT6_LUNA_MODEL, wire: "gpt-6-luna", displayName: "GPT-6-Luna", ladder: LUNA_LADDER },
    ];
    for (const { slug, wire, displayName, ladder } of cases) {
      expect(slug).toBe(wire);
      expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(slug)).toBe(true);
      expect(isNativeOpenAiCapabilityAliasModel(slug)).toBe(false);
      expect(hasNativeOpenAiCapabilityMetadata(slug)).toBe(true);
      // Self-described: resolves to itself, never to a borrowed source.
      expect(nativeOpenAiCapabilitySourceSlug(slug)).toBe(slug);
      expect(nativeOpenAiCapabilityDisplayName(slug)).toBe(displayName);

      expect(upstreamNativeEntry(slug)).toMatchObject({
        slug,
        display_name: displayName,
        context_window: 272_000,
        max_context_window: 872_000,
      });
      expect(nativeOpenAiContextWindow(slug)).toBe(272_000);
      expect(nativeOpenAiContextTier(slug)).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
      expect(nativeReasoningEfforts(slug)).toEqual(ladder);
      expect(nativeDefaultReasoningEffort(slug)).toBe("medium");
      expect(nativeInputModalities(slug)).toEqual(["text", "image"]);
      expect(isGpt56NativeSlug(slug)).toBe(true);
    }
    // The ultra rung follows the row: Sol ships it, Luna does not.
    expect(nativeLadderIncludesUltra(NATIVE_GPT6_SOL_MODEL)).toBe(true);
    expect(nativeLadderIncludesUltra(NATIVE_GPT6_LUNA_MODEL)).toBe(false);
  });

  test("the built catalog keeps Sol at ultra and Luna at max", () => {
    const entries = buildCatalogEntries(nativeTemplate(), [NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL], []);
    const sol = entries.find(entry => entry.slug === NATIVE_GPT6_SOL_MODEL);
    const luna = entries.find(entry => entry.slug === NATIVE_GPT6_LUNA_MODEL);
    expect(sol?.display_name).toBe("GPT-6-Sol");
    expect(luna?.display_name).toBe("GPT-6-Luna");
    expect(efforts(sol)).toEqual(SOL_LADDER);
    expect(efforts(luna)).toEqual(LUNA_LADDER);
    expect(efforts(luna)).not.toContain("ultra");
  });

  test("both are listed natives and neither is account-gated", () => {
    for (const slug of [NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL]) {
      expect(NATIVE_OPENAI_MODELS).toContain(slug);
      expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)).toBe(false);
      expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(slug);
      expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(slug)).toBe(true);
    }
  });
});

describe("gpt-6-astra-minor is an account-gated capability alias of gpt-6-astra", () => {
  test("gated, borrows Astra's capabilities, and carries its own presentation", () => {
    const minor = NATIVE_GPT6_ASTRA_MINOR_MODEL;
    expect(minor).toBe("gpt-6-astra-minor");
    expect(NATIVE_OPENAI_MODELS).toContain(minor);
    expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(minor)).toBe(true);
    expect(NATIVE_MAIN_DRAIN_SENTINEL_MODELS.has(minor)).toBe(true);
    expect(SELF_DESCRIBED_NATIVE_OPENAI_MODELS.has(minor)).toBe(false);
    expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).not.toContain(minor);

    expect(isNativeOpenAiCapabilityAliasModel(minor)).toBe(true);
    expect(nativeOpenAiCapabilitySourceSlug(minor)).toBe(NATIVE_GPT6_ASTRA_MODEL);
    expect(nativeReasoningEfforts(minor)).toEqual(nativeReasoningEfforts(NATIVE_GPT6_ASTRA_MODEL));
    expect(nativeDefaultReasoningEffort(minor)).toBe(nativeDefaultReasoningEffort(NATIVE_GPT6_ASTRA_MODEL));
    expect(nativeInputModalities(minor)).toEqual(nativeInputModalities(NATIVE_GPT6_ASTRA_MODEL));
    expect(nativeOpenAiContextWindow(minor)).toBe(272_000);
    expect(nativeOpenAiContextTier(minor)).toEqual({ defaultWindow: 272_000, longWindow: 872_000 });
    expect(isGpt56NativeSlug(minor)).toBe(true);
    expect(nativeLadderIncludesUltra(minor)).toBe(true);

    const presentation = {
      displayName: "GPT-6-Astra-Minor",
      description: "Unreleased GPT-6 Astra variant; shown only when your account's Codex roster lists it.",
    };
    expect(nativeOpenAiAliasPresentation(minor)).toEqual(presentation);
    expect(nativeOpenAiCapabilityDisplayName(minor)).toBe(presentation.displayName);

    const entry = upstreamNativeEntry(minor);
    expect(entry).toMatchObject({
      slug: minor,
      display_name: presentation.displayName,
      description: presentation.description,
      context_window: 272_000,
      max_context_window: 872_000,
    });
    expect(efforts(entry)).toEqual(efforts(upstreamNativeEntry(NATIVE_GPT6_ASTRA_MODEL)));
    // The alias must never replay Astra's own label or its "now available" NUX.
    expect(entry?.display_name).not.toBe(upstreamNativeEntry(NATIVE_GPT6_ASTRA_MODEL)?.display_name);
    expect(entry?.availability_nux).toBeUndefined();
    // Astra ships only model_messages; the alias row must still carry the native row shape.
    expect(typeof entry?.base_instructions).toBe("string");
  });
});

describe("roster-pinned-models.json", () => {
  test("holds only Sol and Luna, verbatim roster rows", () => {
    const roster = readRows("src/codex/data/roster-pinned-models.json");
    expect(roster.map(row => row.slug)).toEqual([NATIVE_GPT6_SOL_MODEL, NATIVE_GPT6_LUNA_MODEL]);
    expect(efforts(roster[0])).toEqual(SOL_LADDER);
    expect(efforts(roster[1])).toEqual(LUNA_LADDER);
  });

  test("never shadows a slug already in upstream-models.json", () => {
    const upstream = readRows("src/codex/data/upstream-models.json");
    const roster = readRows("src/codex/data/roster-pinned-models.json");
    const upstreamSlugs = new Set(upstream.map(row => row.slug));
    // The files are disjoint today; a codex-rs re-pin that bundles Sol or Luna must win.
    expect(roster.filter(row => upstreamSlugs.has(row.slug))).toEqual([]);

    const merged = pinnedNativeModelRows();
    const slugs = merged.map(row => row.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    // Snapshot rows come first and are the snapshot's own objects, in order.
    expect(slugs.slice(0, upstream.length)).toEqual(upstream.map(row => row.slug));
    for (const row of merged.slice(upstream.length)) {
      expect(upstreamSlugs.has(row.slug)).toBe(false);
    }
  });
});
