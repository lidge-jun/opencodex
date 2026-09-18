import { describe, expect, test } from "bun:test";
import { projectDevinCliAuthMode } from "../../src/providers/devin-cli-authmode-migration";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import type { OcxConfig } from "../../src/types";

function cfg(row: Record<string, unknown> | undefined): OcxConfig {
  return { providers: row ? { "devin-cli": row } : {} } as unknown as OcxConfig;
}

describe("devin-cli retired-adapter migration", () => {
  // The authMode half of this projection moved into
  // devin-provider-merge-migration.ts: the `devin-cli` registry entry is gone,
  // so the PROVIDER_REGISTRY lookup that gated the local -> oauth rewrite here
  // could never fire again. What remains is the adapter repair, which must
  // keep working for custom-named rows that no registry pin protects.

  test("rewrites the registry-id row that still names the removed ACP adapter", () => {
    // The ACP adapter is gone, so the saved id is no longer constructible. The
    // registry pin already protected this row's requests; the rewrite is what
    // keeps the persisted file honest about what it now runs.
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin-cli", baseUrl: "https://cli.devin.ai", authMode: "oauth" }));
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]!.adapter).toBe("devin");
    expect(p.config.providers!["devin-cli"]!.baseUrl).toBe("https://server.codeium.com");
    expect(p.warnings.join(" ")).toContain("devin-cli -> devin");
  });

  test("converts a custom-named ACP row, which no registry pin protects", () => {
    // `devin-acp` was the documented escape hatch. Nothing pins a custom name,
    // so after the removal this row is the one that would throw
    // `Unknown adapter: devin-cli` on every request.
    const config = {
      providers: {
        "devin-acp": { adapter: "devin-cli", baseUrl: "https://cli.devin.ai" },
      },
    } as unknown as Parameters<typeof projectDevinCliAuthMode>[0];
    const p = projectDevinCliAuthMode(config);
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-acp"]!.adapter).toBe("devin");
    expect(p.config.providers!["devin-acp"]!.baseUrl).toBe("https://server.codeium.com");
    expect(p.warnings.join(" ")).toContain("devin-acp");
  });

  test("leaves a non-ACP baseUrl alone while still retiring the adapter", () => {
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin-cli", baseUrl: "https://eu.windsurf.com/_route/api_server", authMode: "oauth" }));
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]!.adapter).toBe("devin");
    expect(p.config.providers!["devin-cli"]!.baseUrl).toBe("https://eu.windsurf.com/_route/api_server");
  });

  test("no longer touches authMode — the merge migration owns that on the moved row", () => {
    // A devin-cli row with authMode "local" is handled while its key moves to
    // "devin" in projectDevinProviderMerge; this pass must not double-report
    // it, and a custom-named row keeps whatever authMode it has because the
    // retired adapter rewrite is the only repair left here.
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "local" }));
    expect(p.changed).toBe(false);
    expect(p.config.providers!["devin-cli"]!.authMode).toBe("local");
    expect(p.warnings).toEqual([]);
  });

  test("is a no-op when the provider is not configured", () => {
    const p = projectDevinCliAuthMode(cfg(undefined));
    expect(p.changed).toBe(false);
    expect(p.warnings).toEqual([]);
  });

  test("runs inside the shared startup repair pass", () => {
    // One boot step owns persistence, adopt and failure handling for all the
    // repairs; a second pass would have to reimplement them.
    const p = projectStartupConfigRepairs(cfg({ adapter: "devin-cli", baseUrl: "https://cli.devin.ai", authMode: "oauth" }));
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]!.adapter).toBe("devin");
  });
});
