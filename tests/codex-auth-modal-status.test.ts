import { describe, expect, test } from "bun:test";

describe("Codex auth modal status feedback", () => {
  test("keeps a distinct submitted/waiting state for manual code login", async () => {
    const [reducer, oauth, waiting] = await Promise.all([
      Bun.file("gui/src/components/add-codex-account-reducer.ts").text(),
      Bun.file("gui/src/components/use-add-codex-account-oauth.ts").text(),
      Bun.file("gui/src/components/add-codex-account-waiting-step.tsx").text(),
    ]);
    expect(reducer).toContain('export type ManualCodeState = "idle" | "submitting" | "waiting"');
    expect(reducer).toContain('manualCodeState: "idle"');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthCodeSubmitted")');
    expect(oauth).toContain('statusNotice: t("codexAuth.oauthStatusRetrying")');
    // The paste control now comes from the shared LoginHint component, so this
    // guard is a prop rather than a JSX attribute. The condition itself is
    // unchanged: a submit stays blocked while a code is in flight, while a
    // previous one is still settling, when the field is empty, and before the
    // flow id arrives.
    expect(waiting).toContain("disabled: manualCodeBusy || manualCodeWaiting || !manualCode.trim() || !flowId");
    // The distinct "submitting" copy must survive the move to a shared control.
    expect(waiting).toContain('submittingLabel: t("codexAuth.oauthSubmittingCode")');
    expect(waiting).toContain('aria-live="polite"');
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
