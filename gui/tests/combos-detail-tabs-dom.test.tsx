/**
 * The combo detail tablist, mounted.
 *
 * `combos-detail-segmented.test.ts` pins the markup and stylesheet as text, which is
 * proportionate for a styling change but blind to two things that actually broke here:
 * a tab whose `aria-controls` pointed at an element that did not exist, and an author
 * `display: flex` overriding the UA's `[hidden] { display: none }` so a hidden panel
 * rendered anyway. Both need a DOM.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import { LanguageProvider } from "../src/i18n/provider";
import { emptyDraft } from "../src/combo-workspace-data";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function mountDetail(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DetailPanel
          baseline={emptyDraft("probe")}
          isCreate
          otherIds={[]}
          otherAliases={[]}
          providerMap={{}}
          providers={[]}
          models={[]}
          onSave={async () => ({ ok: true })}
          onDirtyChange={() => {}}
        />
      </LanguageProvider>,
    );
  });
  /*
   * DetailPanel resets its tab to `config` from a zero-delay timer keyed on the
   * baseline. Let that settle before the test drives anything, or the assertion races
   * a reset it did not ask for.
   */
  await act(async () => { await new Promise(r => setTimeout(r, 10)); });
  return { container, root };
}

const tabs = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')] as HTMLButtonElement[];
const panels = (c: HTMLElement) => [...c.querySelectorAll('[role="tabpanel"]')] as HTMLElement[];

test("both tabs control an element that exists", () => {
  return mountDetail().then(async ({ container, root }) => {
    try {
      const controls = tabs(container).map(t => t.getAttribute("aria-controls")!);
      expect(controls).toHaveLength(2);
      for (const id of controls) expect(container.querySelector(`#${id}`)).toBeTruthy();
      // Each panel names the tab that owns it, not just whichever is active.
      for (const p of panels(container)) {
        expect(container.querySelector(`#${p.getAttribute("aria-labelledby")}`)).toBeTruthy();
      }
    } finally {
      await act(async () => root.unmount());
    }
  });
});

test("exactly one panel is exposed at a time", async () => {
  const { container, root } = await mountDetail();
  try {
    const visible = () => panels(container).filter(p => !p.hasAttribute("hidden"));
    expect(visible()).toHaveLength(1);
    expect(visible()[0]!.id).toBe("cws-detail-panel-config");

    await act(async () => { (container.querySelector("#cws-detail-tab-about") as HTMLButtonElement).click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(visible()).toHaveLength(1);
    expect(visible()[0]!.id).toBe("cws-detail-panel-about");
  } finally {
    await act(async () => root.unmount());
  }
});

test("roving tabindex keeps the tablist to one tab stop", async () => {
  const { container, root } = await mountDetail();
  try {
    expect(tabs(container).filter(t => t.tabIndex === 0)).toHaveLength(1);
    await act(async () => { (container.querySelector("#cws-detail-tab-about") as HTMLButtonElement).click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    const inOrder = tabs(container).filter(t => t.tabIndex === 0);
    expect(inOrder).toHaveLength(1);
    expect(inOrder[0]!.id).toBe("cws-detail-tab-about");
  } finally {
    await act(async () => root.unmount());
  }
});

test("the About panel is focusable, since it holds nothing focusable itself", async () => {
  const { container, root } = await mountDetail();
  try {
    const about = container.querySelector("#cws-detail-panel-about") as HTMLElement;
    expect(about.tabIndex).toBe(0);
  } finally {
    await act(async () => root.unmount());
  }
});

/*
 * The cascade bug: author `display: flex` beat `[hidden] { display: none }`, so both
 * panels painted at once. The stylesheet is the only place this contract lives.
 */
test("the panel rule is scoped so a hidden panel cannot paint", async () => {
  const css = await Bun.file(new URL("../src/styles-combos-workspace.css", import.meta.url)).text();
  expect(css).toContain(".combos-workspace-tab-content:not([hidden])");
  expect(css).not.toMatch(/\.combos-workspace-tab-content\s*\{/);
});
