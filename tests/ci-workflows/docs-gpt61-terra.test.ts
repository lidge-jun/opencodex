import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const root = "docs-site/src/content/docs";
// Discover translations from the content tree so a new locale cannot silently drift.
const locales = ["", ...readdirSync(repoPath(root), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^[a-z]{2}(?:-[a-z]{2})?$/.test(entry.name))
  .map(entry => entry.name)];
const read = (locale: string, page: string) =>
  readFileSync(repoPath(root, locale, page + ".md"), "utf8");

describe("GPT-6.1 Terra documentation", () => {
  for (const locale of locales) {
    test(`${locale || "en"}: native and API limits, pricing and Fast stay distinct`, () => {
      const doc = read(locale, "reference/configuration/providers");
      const section = doc.split("## GPT-6.1 Terra")[1]?.split(/\n## /)[0];
      expect(section).toBeDefined();
      for (const value of ["gpt-6.1-terra", "gpt-5.6-terra", "500,000", "872,000",
        "1,050,000", "128,000", "low", "ultra", "max", "none", "medium",
        "$1.00", "$0.05", "$1.25", "$5.00", "272,000", "$2.00", "$0.10",
        "$2.50", "$7.50", "Fast", "2026-06-01", "v1/responses", "v1/chat/completions"]) {
        expect(section, `${locale}: ${value}`).toContain(value);
      }
      expect(section).not.toMatch(/Ultrafast|ultrafast/);
    });

    test(`${locale || "en"}: model tables list Terra without replacing older models`, () => {
      for (const page of ["guides/providers", "guides/codex-app-models"]) {
        const doc = read(locale, page);
        expect(doc, `${locale}/${page}`).toContain("gpt-6.1-terra");
        expect(doc).toContain("gpt-5.6-terra");
        expect(doc.split("\n").filter(line => line.startsWith("| Cursor |"))
          .join("\n")).not.toContain("gpt-6.1-terra");
      }
      expect(read(locale, "reference/configuration/agents")
        .split("\n").find(line => line.startsWith("| `subagentModels?`")))
        .not.toContain("gpt-6.1-terra");
      expect(read(locale, "guides/cursor-private-inference")).not.toContain("gpt-6.1-terra");
    });

    test(`${locale || "en"}: OpenRouter and Copilot availability includes Terra`, () => {
      for (const page of ["guides/providers", "guides/codex-app-models"]) {
        const rows = read(locale, page).split("\n");
        const terra = rows.find(line => line.startsWith("| OpenRouter |") && line.includes("gpt-6.1-terra"));
        expect(terra).toContain("openrouter/openai/gpt-6.1-terra");
        expect(terra).toContain("1,050,000");
      }
      expect(read(locale, "reference/configuration/providers")
        .split("\n").find(line => line.startsWith("| `modelAdapters?`")))
        .toContain("gpt-6.1-terra");
    });
  }
});
