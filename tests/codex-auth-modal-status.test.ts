import { describe, expect, test } from "bun:test";

describe("Codex auth modal status feedback", () => {
  test("keeps a distinct submitted/waiting state for manual code login", async () => {
    const source = await Bun.file("gui/src/components/AddCodexAccountModal.tsx").text();
    expect(source).toContain('useState<"idle" | "submitting" | "waiting">("idle")');
    expect(source).toContain('setStatusNotice(t("codexAuth.oauthCodeSubmitted"))');
    expect(source).toContain('setStatusNotice(t("codexAuth.oauthStatusRetrying"))');
    expect(source).toContain('disabled={manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId}');
    expect(source).toContain('aria-live="polite"');
  });

  test("defines the new status copy in every shipped GUI locale", async () => {
    const localePaths = [
      "gui/src/i18n/en.ts",
      "gui/src/i18n/de.ts",
      "gui/src/i18n/ja.ts",
      "gui/src/i18n/ko.ts",
      "gui/src/i18n/ru.ts",
      "gui/src/i18n/zh.ts",
    ];
    const locales = await Promise.all(localePaths.map(path => Bun.file(path).text()));
    for (const source of locales) {
      expect(source).toContain('"codexAuth.oauthSubmittingCode"');
      expect(source).toContain('"codexAuth.oauthCodeSubmitted"');
      expect(source).toContain('"codexAuth.oauthStatusRetrying"');
    }
  });
});
