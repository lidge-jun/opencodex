import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { SectionTabs } from "../src/components/section-tabs";
import { sectionAnchorId } from "../src/section-anchors";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const observers: Array<{ callback: IntersectionObserverCallback; nodes: Element[] }> = [];
const OriginalIntersectionObserver = globalThis.IntersectionObserver;

function emitIntersecting(id: string) {
  for (const record of observers) {
    const target = record.nodes.find(node => node.id === id);
    if (!target) continue;
    record.callback([{
      isIntersecting: true,
      target,
      boundingClientRect: { top: 100 } as DOMRectReadOnly,
    } as IntersectionObserverEntry], {} as IntersectionObserver);
  }
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow.window },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  observers.length = 0;

  class MockIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    #callback: IntersectionObserverCallback;
    #nodes: Element[] = [];

    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback;
      observers.push({ callback: this.#callback.bind(this), nodes: this.#nodes });
    }

    observe(node: Element) {
      this.#nodes.push(node);
    }

    unobserve(node: Element) {
      this.#nodes = this.#nodes.filter(n => n !== node);
    }

    disconnect() {
      this.#nodes = [];
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: MockIntersectionObserver,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: OriginalIntersectionObserver,
  });
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function tabButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button[role='tab']"))
    .find(button => (button.textContent ?? "").includes(label));
  if (!found) throw new Error(`tab not found: ${label}`);
  return found as HTMLButtonElement;
}

test("clicking Coverage ignores intermediate scroll-spy updates until Coverage is visible", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);

  const items = [
    { id: "overview", label: "Overview" },
    { id: "models", label: "Models" },
    { id: "providers", label: "Providers" },
    { id: "coverage", label: "Coverage" },
  ];

  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <>
        <SectionTabs scope="usage" items={items} ariaLabel="Usage sections" />
        {items.map(item => (
          <div key={item.id} id={sectionAnchorId("usage", item.id)}>{item.label}</div>
        ))}
      </>,
    );
  });

  expect(tabButton(container, "Overview").className).toContain("page-tab--active");

  await act(async () => {
    tabButton(container, "Coverage").click();
  });
  expect(tabButton(container, "Coverage").className).toContain("page-tab--active");

  // Smooth scroll passes Models/Providers; without a lock the spy would steal the highlight.
  await act(async () => {
    emitIntersecting(sectionAnchorId("usage", "models"));
    emitIntersecting(sectionAnchorId("usage", "providers"));
  });
  expect(tabButton(container, "Coverage").className).toContain("page-tab--active");
  expect(tabButton(container, "Models").className).not.toContain("page-tab--active");
  expect(tabButton(container, "Providers").className).not.toContain("page-tab--active");

  await act(async () => {
    emitIntersecting(sectionAnchorId("usage", "coverage"));
  });
  expect(tabButton(container, "Coverage").className).toContain("page-tab--active");

  await act(async () => { root.unmount(); });
  container.remove();
});
