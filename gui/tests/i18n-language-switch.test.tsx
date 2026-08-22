import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider, useI18n } from "../src/i18n";
import { LOCALES, localeDisplayName } from "../src/i18n/shared";
import { Select } from "../src/ui";

// lidge-jun's review asked for a rendered language-switch smoke test demonstrating the
// Traditional Chinese UI in the actual application surface. Two independent SSR renders (en,
// then zh-TW) can pass even if the language selector itself is broken. This test mounts a real
// GUI surface — the sidebar nav rows plus the language <Select> from the sidebar footer — into
// one live root, starts in English, selects 繁體中文 through the actual selector UI, and asserts
// the *same* DOM flips to Traditional Chinese, that the choice persists to localStorage, and
// that document.documentElement.lang tracks the locale.

const NAV_TKEYS = [
  "nav.dashboard",
  "nav.providers",
  "nav.models",
  "nav.subagents",
  "nav.usage",
  "nav.storage",
  "nav.integrations",
] as const;

function NavRows() {
  const t = useI18n().t;
  return (
    <nav>
      {NAV_TKEYS.map((k) => (
        <span key={k} data-nav={k} className="nav-row">
          {t(k)}
        </span>
      ))}
    </nav>
  );
}

/** Mirror App.tsx's sidebar footer: nav rows + language <Select> wiring to setLocale. */
function LanguageSurface() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="sidebar-foot">
      <NavRows />
      <Select
        value={locale}
        options={LOCALES.map((l) => ({ value: l.code, label: localeDisplayName(l.code) }))}
        onChange={(v) => setLocale(v as typeof locale)}
        label={t("lang.label")}
        placement="right"
        portal={false}
      />
    </div>
  );
}

const domGlobals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
type DomGlobal = (typeof domGlobals)[number];
let previousDom: Record<DomGlobal, PropertyDescriptor | undefined>;
let previousNavigator: object | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindowLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;
let mountedRoot: Root | null;
let domIsSetup = false;

function restoreOwnProperty(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function setupDom(): void {
  previousDom = Object.fromEntries(
    domGlobals.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  ) as typeof previousDom;

  const navigatorValue = Reflect.get(globalThis, "navigator");
  previousNavigator = typeof navigatorValue === "object" && navigatorValue !== null ? navigatorValue : undefined;
  previousLanguageDescriptor = previousNavigator
    ? Object.getOwnPropertyDescriptor(previousNavigator, "language")
    : undefined;

  testWindow = new Window({ url: "http://localhost/" });
  testWindowLanguageDescriptor = Object.getOwnPropertyDescriptor(testWindow.navigator, "language");
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoot = null;
  domIsSetup = true;
}

async function teardownDom(): Promise<void> {
  if (!domIsSetup) return;

  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
    mountedRoot = null;
  }

  restoreOwnProperty(testWindow.navigator, "language", testWindowLanguageDescriptor);
  for (const k of domGlobals) restoreOwnProperty(globalThis, k, previousDom[k]);
  if (previousNavigator) restoreOwnProperty(previousNavigator, "language", previousLanguageDescriptor);

  domIsSetup = false;
  await testWindow.happyDOM?.close?.();
}

beforeEach(() => {
  setupDom();
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
});

afterEach(async () => {
  await teardownDom();
});

async function mountSurface(): Promise<void> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    mountedRoot = createRoot(host);
    mountedRoot.render(
      <LanguageProvider>
        <LanguageSurface />
      </LanguageProvider>,
    );
  });
}

function navLabels(): string[] {
  return [...testWindow.document.querySelectorAll<HTMLElement>("[data-nav]")].map((n) => n.textContent ?? "");
}

async function openSelect(): Promise<void> {
  const trigger = testWindow.document.querySelector<HTMLButtonElement>('[aria-haspopup]');
  if (!trigger) throw new Error("language select trigger missing");
  await act(async () => trigger.click());
}

function optionLabels(): string[] {
  return [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.textContent ?? "");
}

async function choose(labels: string[]): Promise<void> {
  await openSelect();
  const option = [...testWindow.document.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((o) => labels.includes(o.textContent ?? ""));
  if (!option) throw new Error(`option ${labels.join("/")} missing; got ${optionLabels().join(",")}`);
  await act(async () => option.click());
}

describe("zh-TW language switch on the real GUI surface", () => {
  test("same mounted root starts English and flips to Traditional Chinese", async () => {
    await mountSurface();
    expect(navLabels()).toContain("Dashboard");
    expect(navLabels()).toContain("Providers");
    expect(navLabels()).toContain("Subagents");
    expect(navLabels()).toContain("Usage");
    expect(navLabels()).toContain("Integrations");

    await choose(["繁體中文"]);

    expect(navLabels()).toContain("儀表板");
    expect(navLabels()).toContain("供應商");
    expect(navLabels()).toContain("子代理");
    expect(navLabels()).toContain("用量");
    expect(navLabels()).toContain("整合");
    expect(navLabels()).not.toContain("Providers");
    expect(navLabels()).not.toContain("Subagents");
    expect(navLabels()).not.toContain("Integrations");

    expect(localStorage.getItem("ocx-lang")).toBe("zh-TW");
    expect(testWindow.document.documentElement.lang).toBe("zh-TW");
  });

  test("switching to Simplified Chinese afterwards keeps the picker functional", async () => {
    await mountSurface();
    await choose(["繁體中文"]);
    await choose(["中文"]);
    expect(navLabels()).toContain("仪表盘");
    expect(navLabels()).toContain("子代理");
    expect(localStorage.getItem("ocx-lang")).toBe("zh");
  });

  test("teardown restores the original global property descriptors", async () => {
    const expectedDom = Object.fromEntries(domGlobals.map((k) => [k, previousDom[k]])) as typeof previousDom;
    const originalNavigator = previousNavigator;
    const expectedLanguageDescriptor = previousLanguageDescriptor;
    const smokeNavigator = testWindow.navigator;
    const expectedSmokeLanguageDescriptor = testWindowLanguageDescriptor;

    await teardownDom();

    for (const k of domGlobals) {
      expect(Object.getOwnPropertyDescriptor(globalThis, k)).toEqual(expectedDom[k]);
    }
    if (originalNavigator) {
      expect(Object.getOwnPropertyDescriptor(originalNavigator, "language")).toEqual(expectedLanguageDescriptor);
    }
    expect(Object.getOwnPropertyDescriptor(smokeNavigator, "language")).toEqual(expectedSmokeLanguageDescriptor);
  });
});

describe("French language switch on the real GUI surface", () => {
  test("switches to French, persists it, switches back, and restores globals", async () => {
    const expectedDom = Object.fromEntries(domGlobals.map((k) => [k, previousDom[k]])) as typeof previousDom;
    const originalNavigator = previousNavigator;
    const expectedLanguageDescriptor = previousLanguageDescriptor;
    const smokeNavigator = testWindow.navigator;
    const expectedSmokeLanguageDescriptor = testWindowLanguageDescriptor;

    await mountSurface();
    expect(navLabels()).toContain("Dashboard");

    await choose(["Français"]);

    expect(navLabels()).toEqual([
      "Tableau de bord",
      "Fournisseurs",
      "Modèles",
      "Sous-agents",
      "Utilisation",
      "Stockage",
      "Intégrations",
    ]);
    expect(localStorage.getItem("ocx-lang")).toBe("fr");
    expect(testWindow.document.documentElement.lang).toBe("fr");

    await choose(["English"]);

    expect(navLabels()).toContain("Dashboard");
    expect(navLabels()).toContain("Providers");
    expect(localStorage.getItem("ocx-lang")).toBe("en");
    expect(testWindow.document.documentElement.lang).toBe("en");

    await teardownDom();

    for (const k of domGlobals) {
      expect(Object.getOwnPropertyDescriptor(globalThis, k)).toEqual(expectedDom[k]);
    }
    if (originalNavigator) {
      expect(Object.getOwnPropertyDescriptor(originalNavigator, "language")).toEqual(expectedLanguageDescriptor);
    }
    expect(Object.getOwnPropertyDescriptor(smokeNavigator, "language")).toEqual(expectedSmokeLanguageDescriptor);
  });
});
