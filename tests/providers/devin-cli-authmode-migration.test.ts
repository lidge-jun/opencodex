import { describe, expect, test } from "bun:test";
import { projectDevinCliAuthMode } from "../../src/providers/devin-cli-authmode-migration";
import { projectStartupConfigRepairs } from "../../src/providers/model-rename-startup";
import type { OcxConfig } from "../../src/types";

function cfg(row: Record<string, unknown> | undefined): OcxConfig {
  return { providers: row ? { "devin-cli": row } : {} } as unknown as OcxConfig;
}

describe("devin-cli authMode migration", () => {
  test("rewrites the seeded local authMode the registry no longer allows", () => {
    // derive.ts seeds authMode from authKind, so every config saved while the
    // provider was local carries "local", and auth-cors fails closed on it.
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "local" }));
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]!.authMode).toBe("oauth");
    expect(p.warnings.join(" ")).toContain("local -> oauth");
  });

  test("leaves an already-migrated row alone", () => {
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "oauth" }));
    expect(p.changed).toBe(false);
    expect(p.warnings).toEqual([]);
  });

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

  test("is a no-op when the provider is not configured", () => {
    const p = projectDevinCliAuthMode(cfg(undefined));
    expect(p.changed).toBe(false);
    expect(p.warnings).toEqual([]);
  });

  test("runs inside the shared startup repair pass", () => {
    // One boot step owns persistence, adopt and failure handling for all three
    // repairs; a second pass would have to reimplement them.
    const p = projectStartupConfigRepairs(cfg({ adapter: "devin", baseUrl: "https://server.codeium.com", authMode: "local" }));
    expect(p.changed).toBe(true);
    expect(p.config.providers!["devin-cli"]!.authMode).toBe("oauth");
  });
});
