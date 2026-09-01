import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MODELS_RUNTIME_SUBCOMMANDS, isModelsRuntimeSubcommand } from "../src/cli/models-runtime-subcommands";
import { MODELS_RUNTIME_USAGE, handleModelsRuntimeCommand } from "../src/cli/models-runtime";

/**
 * #3094: `ocx models new-policy` and `ocx models new-arrivals` were implemented in
 * models-runtime.ts, listed in its USAGE, and documented on the docs site, but
 * handleModels in models.ts routed a separately written array that omitted them. Both
 * commands reached handleConfiguredModels instead and died with
 * "Unexpected argument(s)".
 *
 * The repair removed the duplication: one exported set is the routing decision on both
 * sides. These tests pin the general form of the defect, not just the two names, so a
 * future runtime subcommand added without touching the shared set fails here.
 */
describe("models runtime subcommand dispatch (#3094)", () => {
  test("every documented runtime subcommand is in the shared routing set", () => {
    // USAGE is the user-facing contract: "  ocx models <sub> ..." per line.
    const documented = new Set<string>();
    for (const line of MODELS_RUNTIME_USAGE.split("\n")) {
      const match = /^\s+ocx models ([a-z-]+)/.exec(line);
      if (match?.[1]) documented.add(match[1]);
    }
    // `ocx models <enable|disable> ...` is written as an alternation in USAGE.
    if (MODELS_RUNTIME_USAGE.includes("ocx models <enable|disable>")) {
      documented.add("enable");
      documented.add("disable");
    }
    expect(documented.size).toBeGreaterThan(0);
    const missing = [...documented].filter(sub => !isModelsRuntimeSubcommand(sub));
    expect(missing).toEqual([]);
  });

  test("new-policy and new-arrivals are routed, not swallowed by the configured-models path", () => {
    expect(isModelsRuntimeSubcommand("new-policy")).toBe(true);
    expect(isModelsRuntimeSubcommand("new-arrivals")).toBe(true);
  });

  test("handleModels routes exactly the shared set to the runtime module", () => {
    // Reading the source keeps this honest without booting the CLI: the dispatch must
    // consult the shared predicate rather than re-listing names inline.
    const source = readFileSync(new URL("../src/cli/models.ts", import.meta.url), "utf8");
    expect(source).toContain("isModelsRuntimeSubcommand(subcommand)");
    // The old inline array is what allowed the drift; it must not come back.
    expect(source).not.toMatch(/\["live",\s*"edit"/);
  });

  test("handleModelsRuntimeCommand returns null for a name outside the set", async () => {
    expect(await handleModelsRuntimeCommand("definitely-not-a-subcommand", [])).toBeNull();
  });

  test("the shared set has no duplicates", () => {
    expect(new Set(MODELS_RUNTIME_SUBCOMMANDS).size).toBe(MODELS_RUNTIME_SUBCOMMANDS.length);
  });
});

