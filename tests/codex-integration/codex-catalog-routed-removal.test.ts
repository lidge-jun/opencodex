import { describe, expect, test } from "bun:test";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "../../src/codex/catalog/kinds";
import {
  routedRemovalBackedByConfigFile,
  unbackedRoutedRemovalMessage,
  unconfiguredRoutedRemoval,
} from "../../src/codex/catalog/routed-removal";
import type { RawEntry } from "../../src/codex/catalog/parsing";
import type { ConfigAdmissionSnapshot } from "../../src/config/diagnostics";
import type { OcxConfig } from "../../src/types";

const native = (slug: string): RawEntry => ({ slug, description: "native" });
const routed = (slug: string): RawEntry => ({ slug, description: `Routed via opencodex → ${slug} (owner).` });
const foreign = (slug: string): RawEntry => ({ slug, description: "routed by another tool" });
const provider = { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

function onDisk(snapshot: Partial<OcxConfig> | "missing" | "fallback" | "unreadable"): () => ConfigAdmissionSnapshot {
  if (snapshot === "missing" || snapshot === "unreadable") {
    return () => ({
      kind: "unreadable",
      diagnostics: { config: config(), source: snapshot === "missing" ? "default" : "fallback", error: null },
      contentSha256: null,
    });
  }
  if (snapshot === "fallback") {
    return () => ({
      kind: "read",
      diagnostics: { config: config(), source: "fallback", error: "parse error" },
      contentSha256: "0".repeat(64),
    });
  }
  return () => ({
    kind: "read",
    diagnostics: { config: config(snapshot), source: "file", error: null },
    contentSha256: "0".repeat(64),
  });
}

describe("routed namespaces a refresh would empty (#6529)", () => {
  test("a fresh install has nothing on disk to protect", () => {
    expect(unconfiguredRoutedRemoval(null, { models: [native("gpt-5.5")] }, config())).toBeNull();
    expect(unconfiguredRoutedRemoval({ models: [] }, { models: [native("gpt-5.5")] }, config())).toBeNull();
  });

  test("reports each namespace the driving config no longer enables, without model ids", () => {
    const active = { models: [native("gpt-5.5"), routed("ark/a"), routed("ark/b"), routed("tx/c"), routed("dot/d")] };
    const candidate = { models: [native("gpt-5.5"), routed("dot/d")] };
    const driving = config({ providers: { dot: provider, tx: { ...provider, disabled: true } } as OcxConfig["providers"] });
    expect(unconfiguredRoutedRemoval(active, candidate, driving)).toEqual({ namespaces: ["ark", "tx"] });
  });

  test("removals inside an enabled namespace are the provider's own business", () => {
    const active = { models: [routed("ark/old"), routed("ark/kept")] };
    const candidate = { models: [routed("ark/kept")] };
    const driving = config({ providers: { ark: provider } as OcxConfig["providers"] });
    expect(unconfiguredRoutedRemoval(active, candidate, driving)).toBeNull();
  });

  test("foreign and account-bound rows are not OpenCodex provider rows", () => {
    const active = {
      models: [
        foreign("cursor/composer"),
        { ...routed("desktop/gpt-5.5"), opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND },
      ],
    };
    expect(unconfiguredRoutedRemoval(active, { models: [] }, config())).toBeNull();
  });

  test("native alias rows belong to the combo namespace", () => {
    const alias = { slug: "fast", description: "alias", opencodex_catalog_kind: CODEX_NATIVE_ALIAS_CATALOG_KIND };
    expect(unconfiguredRoutedRemoval({ models: [alias] }, { models: [] }, config())).toEqual({ namespaces: ["combo"] });
    const withCombos = config({ combos: { other: { models: ["ark/a"] } } as unknown as OcxConfig["combos"] });
    expect(unconfiguredRoutedRemoval({ models: [alias] }, { models: [] }, withCombos)).toBeNull();
  });
});

describe("config.json backing for a routed removal (#6529)", () => {
  const removal = { namespaces: ["ark"] };

  test("a missing, salvaged or unreadable config.json backs nothing", () => {
    expect(routedRemovalBackedByConfigFile(removal, onDisk("missing"))).toBe(false);
    expect(routedRemovalBackedByConfigFile(removal, onDisk("fallback"))).toBe(false);
    expect(routedRemovalBackedByConfigFile(removal, onDisk("unreadable"))).toBe(false);
  });

  test("a config.json that still enables the namespace does not back its removal", () => {
    expect(routedRemovalBackedByConfigFile(removal, onDisk({ providers: { ark: provider } as OcxConfig["providers"] })))
      .toBe(false);
  });

  test("a config.json without the provider, or with it disabled, backs the removal", () => {
    expect(routedRemovalBackedByConfigFile(removal, onDisk({ providers: {} }))).toBe(true);
    expect(routedRemovalBackedByConfigFile(
      removal,
      onDisk({ providers: { ark: { ...provider, disabled: true } } as OcxConfig["providers"] }),
    )).toBe(true);
  });

  test("the log line carries a count, never names", () => {
    expect(unbackedRoutedRemovalMessage(1)).toContain("1 provider namespace ");
    expect(unbackedRoutedRemovalMessage(3)).toContain("3 provider namespaces ");
    expect(unbackedRoutedRemovalMessage(2)).not.toContain("ark");
  });
});
