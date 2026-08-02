import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";

// lidge-jun's review of PR #581 asked for "at least one rendered language-switch smoke test
// that demonstrates the Traditional Chinese UI in the actual application surface." The
// key-parity and placeholder tests guard the data; this one guards the runtime: that the
// LanguageProvider + useT pipeline renders the revived workspace vocabulary (API, Subagents,
// Usage) in Traditional Chinese when the locale switches, instead of silently falling back
// to English.

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = Reflect.get(globalThis.navigator, "language");
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function Probe({ keys }: { keys: readonly string[] }) {
  const t = useT();
  return (
    <ul>
      {keys.map((k) => (
        <li key={k} data-key={k}>{t(k as Parameters<typeof t>[0])}</li>
      ))}
    </ul>
  );
}

const REVIVED_WORKSPACE_KEYS = [
  "nav.providers",
  "nav.subagents",
  "nav.usage",
  "nav.api",
  "api.clientConfig.title",
  "api.section.keys",
  "api.section.connect",
  "sub.sections",
] as const;

describe("zh-TW language switch renders the application surface", () => {
  test("English probe renders the English source values", () => {
    Object.defineProperty(globalThis.navigator, "language", {
      configurable: true,
      value: "en-US",
    });
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <Probe keys={REVIVED_WORKSPACE_KEYS} />
      </LanguageProvider>,
    );
    expect(html).toContain("Providers");
    expect(html).toContain("Subagents");
    expect(html).toContain("Usage");
    expect(html).toContain("Client config");
    expect(html).toContain("Keys");
  });

  test("zh-TW probe renders Traditional Chinese for the revived workspace vocabulary", () => {
    // detectInitial maps any zh-TW/zh-Hant navigator language to the "zh-TW" locale.
    Object.defineProperty(globalThis.navigator, "language", {
      configurable: true,
      value: "zh-TW",
    });
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <Probe keys={REVIVED_WORKSPACE_KEYS} />
      </LanguageProvider>,
    );
    // Revived workspace nav + section labels (the vocabulary lidge-jun asked to be translated).
    expect(html).toContain("供應商");
    expect(html).toContain("子代理");
    expect(html).toContain("用量");
    expect(html).toContain("用戶端設定");
    expect(html).toContain("金鑰");
    expect(html).toContain("連接");
    expect(html).toContain("子代理分區");
    // And it must NOT leak the English source for the keys that were actually translated.
    expect(html).not.toContain(">Providers<");
    expect(html).not.toContain(">Subagents<");
    expect(html).not.toContain(">Usage<");
    expect(html).not.toContain(">Client config<");
    expect(html).not.toContain(">Keys<");
  });
});
