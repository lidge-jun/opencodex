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
    expect(html).toContain("Choose account in model picker");
    expect(html).toContain("GPT models use the Pool or Direct account mode above.");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("Bare + accounts");
    expect(html).not.toContain("Picker layout");
  });

  test("explains strict binding and compatibility when enabled", () => {
    const html = renderSetting(true);
    expect(html).toContain("locks the thread to that account and never falls back");
    expect(html).toContain("does not change the active Pool account");
    expect(html).toContain("existing threads and saved settings still work");
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
