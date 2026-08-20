import { describe, expect, test } from "bun:test";
import { buildAddModalAccountRows } from "../src/pages/providers-page-utils";
import { oauthTosRisk } from "../src/oauth-tos-risk";
import { en } from "../src/i18n/en";
import type { TFn } from "../src/i18n";
import type { ProvidersConfig } from "../src/types";

// Resolve through the real English catalog so a row hint pointing at a missing key fails here.
const t: TFn = ((key: string) => (en as Record<string, string>)[key] ?? key) as TFn;

const emptyConfig = { providers: {} } as unknown as ProvidersConfig;

function row(oauthProviders: string[], id: string) {
  return buildAddModalAccountRows(emptyConfig, oauthProviders, t).find(r => r.id === id);
}

describe("Add provider → Accounts: Gemini OAuth rows", () => {
  test("both subtypes render as OAuth rows with product labels", () => {
    const codeAssist = row(["gemini-cli", "gemini-ai-studio"], "gemini-cli");
    expect(codeAssist?.kind).toBe("oauth");
    expect(codeAssist?.label).toBe("Gemini (Code Assist)");

    const aiStudio = row(["gemini-cli", "gemini-ai-studio"], "gemini-ai-studio");
    expect(aiStudio?.kind).toBe("oauth");
    expect(aiStudio?.label).toBe("Gemini (AI Studio)");
  });

  test("each row states which subtype it authorizes", () => {
    // The two rows are subtypes of one Google account, so the label alone is ambiguous: without
    // the hint a user cannot tell which one their account needs.
    expect(row(["gemini-cli"], "gemini-cli")?.statusLabel).toBe(en["modal.accountGeminiCodeAssist"]);
    expect(row(["gemini-ai-studio"], "gemini-ai-studio")?.statusLabel)
      .toBe(en["modal.accountGeminiAiStudio"]);
    // Hints are translated strings, not raw keys leaking through.
    expect(row(["gemini-cli"], "gemini-cli")?.statusLabel).not.toContain("modal.account");
  });

  test("rows without a subtype ambiguity carry no hint", () => {
    expect(row(["anthropic"], "anthropic")?.statusLabel).toBeUndefined();
    expect(row(["google-antigravity"], "google-antigravity")?.statusLabel).toBeUndefined();
  });

  test("only the first-party-client subtype carries elevated ToS risk", () => {
    // gemini-cli presents Google's own CLI client identifiers from a proxy; gemini-ai-studio
    // authorizes the operator's own registered client, so it must not be warned about.
    expect(oauthTosRisk("gemini-cli")).toBe("elevated");
    expect(oauthTosRisk("gemini-ai-studio")).toBeNull();
  });
});
