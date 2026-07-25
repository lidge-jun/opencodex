import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodexAccountPickerSetting } from "../src/components/CodexAccountPickerSetting";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: previousLanguage });
});

function renderSetting(
  enabled: boolean | null,
  saving = false,
  feedback: { tone: "ok" | "err"; message: string } | null = null,
): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <CodexAccountPickerSetting
        enabled={enabled}
        saving={saving}
        feedback={feedback}
        onToggle={() => {}}
      />
    </LanguageProvider>,
  );
}

describe("Codex account picker setting", () => {
  test("renders one intent-level off toggle without implementation terminology", () => {
    const html = renderSetting(false);
    expect(html).toContain("Choose a Codex login per conversation");
    expect(html).toContain("choose the login directly from the model picker");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("Bare + accounts");
    expect(html).not.toContain("Picker layout");
  });

  test("explains strict binding and compatibility when enabled", () => {
    const html = renderSetting(true);
    expect(html).toContain("The prefix is that login&#x27;s label, such as Personal or Work");
    expect(html).toContain("pins the conversation to that login and its quota");
    expect(html).toContain("OpenCodex will not switch accounts");
    expect(html).toContain("does not change your Pool or Direct settings");
    expect(html).toContain("existing conversations, or saved model selections");
    expect(html).toContain('aria-pressed="true"');
  });

  test("does not flash an actionable off state before hydration", () => {
    expect(renderSetting(null)).toBe("");
  });

  test("disables during writes and renders accessible feedback", () => {
    expect(renderSetting(true, true)).toContain('disabled=""');
    expect(renderSetting(true, false, { tone: "ok", message: "Saved" })).toContain('role="status"');
    expect(renderSetting(true, false, { tone: "err", message: "Failed" })).toContain('role="alert"');
  });
});
