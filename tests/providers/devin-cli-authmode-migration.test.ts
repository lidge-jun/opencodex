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

  test("warns without mutating when the saved row still names the ACP adapter", () => {
    // The saved adapter no longer chooses the transport — routing pins it from
    // the registry — so an operator who chose ACP must be told, not silently moved.
    const p = projectDevinCliAuthMode(cfg({ adapter: "devin-cli", baseUrl: "https://cli.devin.ai", authMode: "oauth" }));
    expect(p.changed).toBe(false);
    expect(p.config.providers!["devin-cli"]!.adapter).toBe("devin-cli");
    expect(p.warnings.join(" ")).toContain("devin-acp");
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

