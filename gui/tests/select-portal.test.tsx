import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Select } from "../src/ui";

// Mounted regressions for #340 / PR #393: the portal fix must (1) render an opt-in portaled
// dropdown under document.body (outside the clipping card) with fixed positioning, and (2) leave a
// NON-portal Select (the language menu contract) as a descendant of .custom-select keeping the
// .select-dropdown-beside class so its glass fallback + mobile upward-placement CSS still apply.

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
];

async function mountAndOpen(node: React.ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  // A bounded, clipping card the Claude settings dropdowns live inside.
  const card = document.createElement("div");
  card.className = "settings-card";
  card.style.overflow = "hidden";
  document.body.append(card);
  let root!: Root;
  await act(async () => {
    root = createRoot(card);
    root.render(node);
  });
  // Open the dropdown by clicking the trigger.
  const trigger = card.querySelector<HTMLButtonElement>("button.select-trigger");
  await act(async () => { trigger?.dispatchEvent(new testWindow.MouseEvent("click", { bubbles: true }) as unknown as MouseEvent); });
  return { container: card, root };
}

test("a portal Select renders its dropdown under document.body, outside the clipping card", async () => {
  const { container, root } = await mountAndOpen(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Backend" portal />,
  );
  const listbox = document.body.querySelector<HTMLElement>('[role="listbox"]');
  expect(listbox).not.toBeNull();
  // The dropdown must NOT be nested inside the clipping card (that's the whole point of #340).
  expect(container.contains(listbox)).toBe(false);
  // Portaled dropdowns get the portal marker class and fixed positioning.
  expect(listbox?.className).toContain("select-dropdown-portal");
  await act(async () => { root.unmount(); });
});

test("a non-portal Select (language-menu contract) stays inside .custom-select and keeps .select-dropdown-beside", async () => {
  const { container, root } = await mountAndOpen(
    <Select value="a" options={OPTIONS} onChange={() => {}} label="Language" placement="right" />,
  );
  // Not portaled: nothing lands directly under body outside the mount container.
  const bodyListboxes = Array.from(document.body.querySelectorAll<HTMLElement>('[role="listbox"]'));
  expect(bodyListboxes.length).toBe(1);
  const listbox = bodyListboxes[0];
  // It remains a descendant of the .custom-select wrapper (contextual glass + mobile rules apply).
  expect(container.querySelector(".custom-select")?.contains(listbox)).toBe(true);
  expect(listbox.className).toContain("select-dropdown-beside");
  expect(listbox.className).not.toContain("select-dropdown-portal");
  await act(async () => { root.unmount(); });
});
