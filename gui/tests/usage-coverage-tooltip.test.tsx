import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { en } from "../src/i18n/en";
import { Tooltip } from "../src/ui";
import { IconInfo } from "../src/icons";

/**
 * The Usage coverage card's caveat is a Tooltip whose child is an icon plus an sr-only
 * name (060). This renders that exact shape and pins what the plan promised: the trigger
 * is a focusable button, it has the accessible name, and focusing it shows the caveat.
 */
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#usage" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  jest.useFakeTimers();
});

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount(); }); root = null; }
  jest.useRealTimers();
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

test("the coverage caveat tooltip is a focusable, named trigger that shows the caveat on focus", async () => {
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <Tooltip content={en["usage.subtitle"]} side="top" maxWidth={360}>
          <IconInfo width={13} height={13} aria-hidden="true" />
          <span className="sr-only">{en["usage.subtitleAria"]}</span>
        </Tooltip>
      </LanguageProvider>,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>("button.ocx-tooltip")!;
  expect(trigger).not.toBeNull();
  expect(trigger.tagName).toBe("BUTTON");
  expect(trigger.hasAttribute("disabled")).toBe(false);
  // Accessible name comes from the visually-hidden span, not a title attribute.
  expect(trigger.textContent).toContain(en["usage.subtitleAria"]);
  expect(trigger.getAttribute("title")).toBeNull();
  expect(container.textContent).not.toContain(en["usage.subtitle"]);

  await act(async () => {
    trigger.dispatchEvent(new testWindow.FocusEvent("focus", { bubbles: false }));
    trigger.dispatchEvent(new testWindow.FocusEvent("focusin", { bubbles: true }));
  });
  await act(async () => { jest.advanceTimersByTime(300); });
  const tipId = trigger.getAttribute("aria-describedby");
  expect(tipId).toBeTruthy();
  const tip = testWindow.document.getElementById(tipId!);
  expect(tip?.textContent).toContain(en["usage.subtitle"]);
});
