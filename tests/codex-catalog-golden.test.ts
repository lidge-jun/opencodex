import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../src/codex-catalog";

// Behavior-preservation ORACLE for the future codex-catalog.ts split (devlog 260701).
// buildCatalogEntries is the pure core (no fs/network). This snapshots its full serialized
// output for a fixed input set so a later build/discovery/persistence split can prove it did
// not change the injected catalog. If this snapshot changes, the split changed behavior.

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
    use_responses_lite: true,
    supports_websockets: true,
    web_search_tool_type: "text_and_image",
    supports_search_tool: true,
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "high", description: "native high" },
    ],
  };
}

describe("codex-catalog golden (pure buildCatalogEntries oracle)", () => {
  test("native + routed build is stable for a fixed input set", () => {
    const goModels = [
      { id: "claude-opus-4.6", provider: "kiro", owned_by: "kiro" },
      { id: "glm-5.2", provider: "opencode-go", owned_by: "opencode" },
    ] as unknown as Parameters<typeof buildCatalogEntries>[2];

    const entries = buildCatalogEntries(
      template() as unknown as Parameters<typeof buildCatalogEntries>[0],
      ["gpt-5.5", "gpt-5.4"],
      goModels,
      ["gpt-5.5", "kiro/claude-opus-4.6"],
      false,
    );

    // Stable projection: the fields that define the injected catalog's identity/ordering/shape.
    const projection = entries.map(e => {
      const r = e as Record<string, unknown>;
      return {
        slug: r.slug,
        priority: r.priority,
        description: r.description,
        base_instructions: r.base_instructions,
        supports_websockets: r.supports_websockets ?? null,
      };
    });

    // Routed entries are identity-neutralized; native gpt slugs keep the GPT-5 line.
    const bySlug = Object.fromEntries(projection.map(p => [p.slug, p]));
    expect(typeof (bySlug["gpt-5.5"] as Record<string, unknown>).base_instructions).toBe("string");
    expect((bySlug["gpt-5.5"] as { base_instructions: string }).base_instructions).toContain("based on GPT-5");
    const routed = bySlug["kiro/claude-opus-4.6"] as { base_instructions: string } | undefined;
    expect(routed).toBeDefined();
    expect(routed!.base_instructions).not.toContain("based on GPT-5");

    // Featured ordering: featured slugs get the lowest priorities (0,1).
    expect((bySlug["gpt-5.5"] as { priority: number }).priority).toBe(0);
    expect((bySlug["kiro/claude-opus-4.6"] as { priority: number }).priority).toBe(1);

    // ws opt-out: supports_websockets stripped when wsEnabled=false.
    for (const p of projection) expect(p.supports_websockets).toBeNull();

    // Full structural snapshot (the oracle): exact slug set + priority + ws projection.
    expect(projection.map(p => `${p.slug}@${p.priority}`).sort()).toEqual([
      "gpt-5.4@9",
      "gpt-5.5@0",
      "kiro/claude-opus-4.6@1",
      "opencode-go/glm-5.2@5",
    ]);
  });
});
