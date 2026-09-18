import { describe, expect, test } from "bun:test";
import { projectStaleContextWindows, STALE_CONTEXT_WINDOWS } from "../../src/providers/stale-context-window-migration";
import type { OcxConfig } from "../../src/types";

function devinConfig(windows: Record<string, number>, adapter = "devin"): OcxConfig {
  return {
    providers: {
      devin: { adapter, baseUrl: "https://server.codeium.com", modelContextWindows: { ...windows } },
    },
  } as unknown as OcxConfig;
}

describe("stale context window migration", () => {
  test("repairs a window the config inherited from the wrong registry seed", () => {
    // `enrichProviderFromRegistry` is fill-only, so a config saved while the
    // registry shipped 256k for Grok keeps reporting 256k forever. Correcting
    // the registry fixes new installs only; this is what reaches the old ones.
    const config = devinConfig({ "grok-4-5": 256_000, "claude-sonnet-5": 200_000 });
    const projection = projectStaleContextWindows(config);
    expect(projection.changed).toBe(true);
    expect(projection.config.providers!.devin!.modelContextWindows).toMatchObject({
      "grok-4-5": 500_000,
      "claude-sonnet-5": 1_000_000,
    });
    expect(projection.warnings.join(" ")).toContain("grok-4-5 256000 -> 500000");
  });

  test("leaves a value the user chose alone", () => {
    // The guard is an exact match on the wrong number. Anything else is a
    // deliberate override and outranks this migration.
    const config = devinConfig({ "grok-4-5": 300_000 });
    const projection = projectStaleContextWindows(config);
    expect(projection.changed).toBe(false);
    expect(projection.config.providers!.devin!.modelContextWindows!["grok-4-5"]).toBe(300_000);
  });

  test("skips a row that no longer carries the registry adapter", () => {
    // A `devin` row retargeted at another transport is not the provider these
    // numbers describe, so rewriting its windows would be a guess.
    const projection = projectStaleContextWindows(devinConfig({ "grok-4-5": 256_000 }, "openai-chat"));
    expect(projection.changed).toBe(false);
  });

  test("is a no-op on a config with no such provider", () => {
    const projection = projectStaleContextWindows({ providers: {} } as unknown as OcxConfig);
    expect(projection.changed).toBe(false);
    expect(projection.warnings).toEqual([]);
  });

  test("every entry names a real correction", () => {
    // A from/to pair that is equal would make the migration claim a change it
    // never performs, and an entry for another provider would silently do nothing.
    for (const entry of STALE_CONTEXT_WINDOWS) {
      expect(entry.from).not.toBe(entry.to);
      expect(entry.provider).toBe("devin");
    }
  });
});

