import { describe, expect, test } from "bun:test";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";

/**
 * Regression coverage for #3666 — the CLI half.
 *
 * The issue asks for `ocx model list --free-only`. That command does not exist; the live
 * catalog listing is `ocx models live`, so the flag lands there, on the same
 * `pricingStatus` the Dashboard filter reads. Absent `pricingStatus` is excluded for the
 * same fail-closed reason the classifier omits it: a model the provider never priced is not
 * evidence of a free one.
 */
const ROWS = [
  { provider: "openrouter", id: "gemma:free", namespaced: "openrouter/gemma:free", pricingStatus: "free" },
  { provider: "openrouter", id: "claude-sonnet-5", namespaced: "openrouter/claude-sonnet-5", pricingStatus: "paid" },
  { provider: "openrouter", id: "mystery", namespaced: "openrouter/mystery" },
  { provider: "ollama", id: "llama3.2", namespaced: "ollama/llama3.2", pricingStatus: "free" },
];

async function runLive(args: string[]): Promise<{ code: number | null; out: string[] }> {
  const out: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(" ")); };
  try {
    const code = await handleModelsRuntimeCommand("live", args, {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: (async () => Response.json(ROWS)) as unknown as typeof fetch,
    });
    return { code, out };
  } finally {
    console.log = original;
  }
}

describe("ocx models live --free-only (#3666)", () => {
  test("--free-only keeps only rows the provider priced at zero", async () => {
    const { code, out } = await runLive(["--free-only", "--json"]);
    expect(code).toBe(0);
    const rows = JSON.parse(out.join("\n")) as Array<{ namespaced: string }>;
    expect(rows.map(row => row.namespaced)).toEqual(["openrouter/gemma:free", "ollama/llama3.2"]);
  });

  test("--free-only composes with --provider instead of replacing it", async () => {
    const { out } = await runLive(["--provider", "openrouter", "--free-only", "--json"]);
    const rows = JSON.parse(out.join("\n")) as Array<{ namespaced: string }>;
    expect(rows.map(row => row.namespaced)).toEqual(["openrouter/gemma:free"]);
  });

  test("without the flag every row is still listed", async () => {
    const { out } = await runLive(["--json"]);
    expect((JSON.parse(out.join("\n")) as unknown[]).length).toBe(ROWS.length);
  });

  test("the human listing marks a free row so the flag is discoverable", async () => {
    const { out } = await runLive([]);
    // Read the bracketed flag list, not the whole line: "openrouter/gemma:free" contains the
    // word "free" in its own id, so a substring check on the line would pass vacuously.
    const flags = (prefix: string): string => {
      const line = out.find(entry => entry.startsWith(prefix)) ?? "";
      return line.slice(line.indexOf("["));
    };
    expect(flags("ollama/llama3.2")).toContain("free");
    expect(flags("openrouter/gemma:free")).toContain("free");
    expect(flags("openrouter/claude-sonnet-5")).not.toContain("free");
    expect(flags("openrouter/mystery")).not.toContain("free");
  });
});
