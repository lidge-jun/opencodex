import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { GuardrailsTabStrip } from "../src/pages/guardrails/guardrails-tab-strip";
import {
  GUARDRAILS_TABS,
  guardrailsPanelDomId,
  guardrailsTabHash,
  readGuardrailsTab,
  selectGuardrailsTab,
  type GuardrailsTab,
} from "../src/pages/guardrails/guardrails-tab";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#guardrails" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function mountTabs(initial: GuardrailsTab = "overview") {
  const { createRoot } = await import("react-dom/client");
  function Harness() {
    const [tab, setTab] = useState(initial);
    const select = (next: GuardrailsTab) => {
      setTab(next);
      selectGuardrailsTab(next);
    };
    return (
      <LanguageProvider>
        <GuardrailsTabStrip tab={tab} onSelect={select} />
        {GUARDRAILS_TABS.map(candidate => (
          <section
            key={candidate}
            id={guardrailsPanelDomId(candidate)}
            role="tabpanel"
            hidden={tab !== candidate}
          />
        ))}
      </LanguageProvider>
    );
  }
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness />);
  });
}

function tabs(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

async function press(target: HTMLElement, key: string) {
  await act(async () => {
    target.dispatchEvent(new testWindow.KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
  });
}

test("hash helpers round-trip every tab and fall back safely", () => {
  expect(guardrailsTabHash("overview")).toBe("guardrails");
  for (const tab of GUARDRAILS_TABS) {
    expect(readGuardrailsTab(`#${guardrailsTabHash(tab)}`)).toBe(tab);
  }
  expect(readGuardrailsTab("#guardrails/unknown")).toBe("overview");
  expect(readGuardrailsTab("#models")).toBe("overview");
});

test("tablist exposes five controlled panels and one tab stop", async () => {
  await mountTabs();
  expect(tabs()).toHaveLength(5);
  expect(tabs().filter(tab => tab.tabIndex === 0)).toHaveLength(1);
  for (const tab of tabs()) {
    const panelId = tab.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(host.querySelector(`#${panelId}`)).not.toBeNull();
  }
  expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1);
});

test("Arrow keys, Home, and End move selection and focus with wraparound", async () => {
  await mountTabs();
  const overview = tabs()[0]!;
  overview.focus();

  await press(overview, "ArrowLeft");
  expect(document.activeElement?.id).toBe("guardrails-tab-settings");
  expect(readGuardrailsTab()).toBe("settings");

  await press(document.activeElement as HTMLElement, "ArrowRight");
  expect(document.activeElement?.id).toBe("guardrails-tab-overview");

  await press(document.activeElement as HTMLElement, "End");
  expect(document.activeElement?.id).toBe("guardrails-tab-settings");

  await press(document.activeElement as HTMLElement, "Home");
  expect(document.activeElement?.id).toBe("guardrails-tab-overview");
  expect(tabs().filter(tab => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);
});

test("tab selection creates usable Back and Forward history", async () => {
  selectGuardrailsTab("rules");
  selectGuardrailsTab("tester");
  expect(readGuardrailsTab()).toBe("tester");

  await act(async () => {
    testWindow.history.back();
    await new Promise(resolve => setTimeout(resolve, 15));
  });
  expect(readGuardrailsTab()).toBe("rules");

  await act(async () => {
    testWindow.history.forward();
    await new Promise(resolve => setTimeout(resolve, 15));
  });
  expect(readGuardrailsTab()).toBe("tester");
});
