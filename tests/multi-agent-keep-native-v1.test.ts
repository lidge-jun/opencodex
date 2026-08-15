import { describe, expect, test } from "bun:test";
import {
  applyMultiAgentMode,
  catalogEntryIsNativeChatGpt,
  type RawEntry,
} from "../src/codex/catalog/parsing";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../src/codex/catalog/kinds";

describe("keepNativeChatGptOnV1", () => {
  test("v2 without the switch stamps every row v2", () => {
    const entries: RawEntry[] = [
      { slug: "gpt-5.6-sol" },
      { slug: "xai/grok-4.6" },
    ];
    applyMultiAgentMode(entries, "v2");
    expect(entries[0]!.multi_agent_version).toBe("v2");
    expect(entries[1]!.multi_agent_version).toBe("v2");
  });

  test("v2 + keepNativeChatGptOnV1 leaves ChatGPT-native on v1 and routed on v2", () => {
    const entries: RawEntry[] = [
      { slug: "gpt-5.6-sol" },
      { slug: "gpt-5.6-terra" },
      { slug: "xai/grok-4.6" },
      { slug: "anthropic/claude-fable-5" },
      { slug: "combo/grok_4.6_fast_cursor_xai_fallback" },
    ];
    applyMultiAgentMode(entries, "v2", false, { keepNativeChatGptOnV1: true });
    expect(entries.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v1");
    expect(entries.find(e => e.slug === "gpt-5.6-terra")!.multi_agent_version).toBe("v1");
    expect(entries.find(e => e.slug === "xai/grok-4.6")!.multi_agent_version).toBe("v2");
    expect(entries.find(e => e.slug === "anthropic/claude-fable-5")!.multi_agent_version).toBe("v2");
    expect(entries.find(e => e.slug === "combo/grok_4.6_fast_cursor_xai_fallback")!.multi_agent_version).toBe("v2");
  });

  test("the switch does nothing in v1 or default mode", () => {
    const v1: RawEntry[] = [{ slug: "xai/grok-4.6" }];
    applyMultiAgentMode(v1, "v1", false, { keepNativeChatGptOnV1: true });
    expect(v1[0]!.multi_agent_version).toBe("v1");

    const base: RawEntry[] = [{ slug: "xai/grok-4.6", multi_agent_version: "v1" }];
    applyMultiAgentMode(base, "default", false, { keepNativeChatGptOnV1: true });
    expect(base[0]!.multi_agent_version).toBeUndefined();
  });

  test("native alias rows count as native; routed providers do not", () => {
    const alias: RawEntry = { slug: "sol", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND };
    expect(catalogEntryIsNativeChatGpt(alias)).toBe(true);
    expect(catalogEntryIsNativeChatGpt({ slug: "xai/grok-4.6" })).toBe(false);
    expect(catalogEntryIsNativeChatGpt({ slug: "gpt-5.6-sol" })).toBe(true);
  });
});
