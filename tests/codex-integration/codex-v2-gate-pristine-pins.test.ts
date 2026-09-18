/**
 * Default-mode pin preservation from the pristine installed-catalog baseline, split out of
 * codex-v2-gate.test.ts because that file sits at its file-size ratchet cap; the cases are unchanged.
 */
import { describe, expect, test } from "bun:test";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND, mergeCatalogEntriesForSync } from "../../src/codex/catalog";
import { nativeMultiAgentDefaults } from "../../src/codex/catalog/parsing";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    supported_reasoning_levels: [
      { effort: "low", description: "l" }, { effort: "medium", description: "m" },
      { effort: "high", description: "h" }, { effort: "xhigh", description: "x" },
    ],
    default_reasoning_level: "medium",
  };
}

describe("3-state multi-agent mode", () => {
  test("mode default prefers pristine-baseline pins over the bundled snapshot", () => {
    // The installed pristine backup is authoritative for the rows it contains: a
    // baseline pin wins even when the bundled snapshot pins a different value, and
    // a baseline row with no pin still gets stale forced-stamp cleanup.
    const diskSol = { ...template(), slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", multi_agent_version: "v2" };
    const diskLuna = { ...template(), slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", multi_agent_version: "v2" };
    const diskNative = { ...template(), slug: "gpt-5.5", display_name: "gpt-5.5", multi_agent_version: "v2" };
    const merged = mergeCatalogEntriesForSync(
      [diskSol as never, diskLuna as never, diskNative as never],
      [], new Map(), [], false, new Set(), null, new Set(), new Set(), "default",
      new Set(), false, true, [], new Set(), new Set(), undefined, false,
      new Map<string, string | null>([
        ["gpt-5.6-sol", "v1"],
        ["gpt-5.6-luna", "v1"],
        ["gpt-5.5", null],
      ]),
    );
    // Baseline says v1 — applied instead of the bundled snapshot's v2 pin.
    expect(merged.find(e => e.slug === "gpt-5.6-sol")?.multi_agent_version).toBe("v1");
    expect(merged.find(e => e.slug === "gpt-5.6-luna")?.multi_agent_version).toBe("v1");
    // Baseline contains the row with no pin — stale forced stamp is cleared.
    expect(merged.find(e => e.slug === "gpt-5.5")?.multi_agent_version).toBeUndefined();
  });

  test("mode default preserves pins on live native rows outside the pristine baseline", () => {
    // A preserved on-disk row the pristine backup never contained may carry a
    // user- or provider-preserved pin newer than our bundled snapshot. It was not
    // stamped by us, so default mode must not delete it.
    const liveNative = { ...template(), slug: "custom-native", display_name: "Custom Native", multi_agent_version: "v2" };
    // A routed row is never in the bare-native baseline, so its absence proves
    // nothing; default mode still clears its stale pin.
    const staleRouted = { ...template(), slug: "provider/model", display_name: "Routed", multi_agent_version: "v1" };
    const merged = mergeCatalogEntriesForSync(
      [liveNative as never, staleRouted as never],
      [], new Map(), [], false, new Set(), null, new Set(), new Set(), "default",
      new Set(), false, true, [], new Set(), new Set(), undefined, false,
      new Map([["gpt-5.6-sol", "v2"]]),
    );
    expect(merged.find(e => e.slug === "custom-native")?.multi_agent_version).toBe("v2");
    expect(merged.find(e => e.slug === "provider/model")?.multi_agent_version).toBeUndefined();
  });

  test("mode default keys baseline pins by trusted account-bound slugs only", () => {
    // hasNativeDefault resolves the lookup slug through
    // trustedAccountBoundNativeCatalogSlug, so an account-bound clone tracks its
    // bound native's pristine pin: the backup's "v1" beats both the bundled
    // snapshot's "v2" and a stale stamp on the clone, and a baseline row with no
    // pin still clears the clone's stale stamp.
    const boundSol = {
      ...template(),
      slug: "team/gpt-5.6-sol",
      display_name: "team / GPT-5.6 Sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      multi_agent_version: "v2",
    };
    const boundNative = {
      ...template(),
      slug: "team/gpt-5.5",
      display_name: "team / gpt-5.5",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      multi_agent_version: "v2",
    };
    // An untrusted slashed row must not key the baseline by its post-slash part:
    // "external/gpt-5.6-sol" is not the native "gpt-5.6-sol" row, so its preserved
    // pin survives instead of being rewritten to the baseline's "v1".
    const foreignRouted = {
      ...template(),
      slug: "external/gpt-5.6-sol",
      display_name: "External Sol",
      multi_agent_version: "v2",
    };
    const merged = mergeCatalogEntriesForSync(
      [foreignRouted as never], [], new Map(), [], false,
      new Set(), null, new Set(), new Set(), "default",
      new Set(), false, true, [boundSol as never, boundNative as never],
      new Set(), new Set(), undefined, false,
      new Map<string, string | null>([["gpt-5.6-sol", "v1"], ["gpt-5.5", null]]),
    );
    expect(merged.find(e => e.slug === "team/gpt-5.6-sol")?.multi_agent_version).toBe("v1");
    expect(merged.find(e => e.slug === "team/gpt-5.5")?.multi_agent_version).toBeUndefined();
    expect(merged.find(e => e.slug === "external/gpt-5.6-sol")?.multi_agent_version).toBe("v2");

    // The baseline extractor itself never indexes slashed rows, so account-bound
    // or routed rows inside a backup cannot alias a bare native slug.
    const defaults = nativeMultiAgentDefaults([
      { slug: "gpt-5.6-sol", multi_agent_version: "v1" },
      { slug: "team/gpt-5.6-sol", multi_agent_version: "v2" },
      { slug: "gpt-5.5" },
    ]);
    expect(defaults.get("gpt-5.6-sol")).toBe("v1");
    expect(defaults.has("team/gpt-5.6-sol")).toBe(false);
    expect(defaults.has("gpt-5.5")).toBe(true);
    expect(defaults.get("gpt-5.5")).toBeNull();
  });
});
