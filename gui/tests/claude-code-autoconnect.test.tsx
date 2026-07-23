import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { reconcileAutoConnectState } from "../src/pages/claude-autoconnect";
import { AutoConnectSetting } from "../src/pages/ClaudeCode";

// Bun defines `navigator` but not `navigator.language`; gui/src/i18n/shared.ts
// reads it during locale detection, so pin it deterministically for SSR.
let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function renderAutoConnect(supported: boolean, checked: boolean): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <AutoConnectSetting supported={supported} checked={checked} onChange={() => {}} />
    </LanguageProvider>,
  );
}

test("Auto-connect reconciliation preserves a supported stored true", () => {
  expect(reconcileAutoConnectState({ autoConnectSupported: true, systemEnv: true })).toEqual({
    autoConnectSupported: true,
    systemEnv: true,
  });
});

test("Auto-connect reconciliation forces an unsupported stored true off", () => {
  expect(reconcileAutoConnectState({ autoConnectSupported: false, systemEnv: true })).toEqual({
    autoConnectSupported: false,
    systemEnv: false,
  });
});

test("Auto-connect reconciliation fails closed when the capability field is missing", () => {
  // stale backend (pre-capability-field proxy): absent autoConnectSupported must
  // deactivate a persisted systemEnv:true instead of presenting it as active
  expect(reconcileAutoConnectState({ systemEnv: true })).toEqual({
    autoConnectSupported: false,
    systemEnv: false,
  });
});

test("Auto-connect renders enabled and checked on a supported host", () => {
  const html = renderAutoConnect(true, true);
  expect(html).toContain('checked=""');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("macOS only");
});

test("Auto-connect renders disabled, unchecked, and explained on an unsupported host", () => {
  const html = renderAutoConnect(false, false);
  expect(html).toContain('disabled=""');
  expect(html).not.toContain('checked=""');
  expect(html).toContain('aria-describedby="claude-system-env-unsupported"');
  expect(html).toContain("macOS only");
  expect(html).toContain('<code class="chip">ocx claude</code>');
});
