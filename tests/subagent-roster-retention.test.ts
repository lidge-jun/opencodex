/**
 * A saved subagent roster must survive an unrelated model-visibility change.
 *
 * The dashboard renders the roster from the reported available list and PUTs exactly what it
 * holds, so a
 * chosen id that GET omits is not merely hidden: the next Save writes the truncated list
 * back to config.json. Disabling a model on the Models page, narrowing a provider
 * allowlist, or removing a provider therefore used to silently shrink a deliberate
 * 5-model roster.
 */
import { describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../src/server/management-api";
import { ManagementRequest as Request } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai", ...overrides } as OcxConfig;
}

async function getRoster(config: OcxConfig): Promise<{ chosen: string[]; available: string[] }> {
  const res = await handleManagementAPI(
    new Request("http://localhost/api/subagent-models"),
    new URL("http://localhost/api/subagent-models"),
    config,
  );
  expect(res).not.toBeNull();
  return await res!.json() as { chosen: string[]; available: string[] };
}

describe("/api/subagent-models roster retention", () => {
  test("a chosen model disabled elsewhere stays listed in available", async () => {
    const chosen = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"];
    const config = makeConfig({
      subagentModels: [...chosen],
      disabledModels: ["gpt-5.5", "gpt-5.4-mini"],
    });

    const roster = await getRoster(config);

    // The saved list itself is untouched.
    expect(roster.chosen).toEqual(chosen);
    // And every slot the user saved can still be rendered, so a Save round-trip
    // cannot truncate the roster to the models that happen to be enabled today.
    for (const model of chosen) expect(roster.available).toContain(model);
  });

  test("retained roster entries are appended once, after the selectable models", async () => {
    const config = makeConfig({
      subagentModels: ["gpt-5.5", "gpt-5.5", "gpt-5.6-terra"],
      disabledModels: ["gpt-5.5"],
    });

    const { available } = await getRoster(config);

    // A duplicate saved id must not produce a duplicate row.
    expect(available.filter(model => model === "gpt-5.5").length).toBe(1);
    // An enabled chosen model is already selectable and must not be re-appended.
    expect(available.filter(model => model === "gpt-5.6-terra").length).toBe(1);
    // Retained-but-disabled entries sort after everything still selectable.
    expect(available.indexOf("gpt-5.5")).toBeGreaterThan(available.indexOf("gpt-5.6-terra"));
  });

  test("a disabled model that is NOT in the roster stays out of available", async () => {
    const config = makeConfig({
      subagentModels: ["gpt-5.6-terra"],
      disabledModels: ["gpt-5.6-sol"],
    });

    const { available } = await getRoster(config);

    expect(available).not.toContain("gpt-5.6-sol");
    expect(available).toContain("gpt-5.6-terra");
  });
});
