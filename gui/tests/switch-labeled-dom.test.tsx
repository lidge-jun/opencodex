import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Switch } from "../src/ui";

/**
 * WP1 rendered-DOM contract
 * (devlog/_fin/260830_models_provider_header/020_control_affordances.md).
 *
 * The sibling .ts file pins source invariants. This file proves the property the
 * audit said a substring check cannot reach: the visible label ACTIVATES the
 * switch. An earlier revision rendered the label as an `aria-hidden` sibling span,
 * which read correctly and looked correct but left the hit target as the 34x20
 * knob, so clicking the words did nothing.
 */

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let root: Root | null = null;
let host: HTMLElement;

function mount(node: React.ReactElement) {
  win = new Window({ url: "http://localhost/" });
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  // Plain assignment fails in a whole-suite run: an earlier DOM test leaves
  // `document` installed as a non-writable global, so only defineProperty works.
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  host = win.document.createElement("div") as never as HTMLElement;
  win.document.body.appendChild(host as never);
  act(() => { root = createRoot(host); root.render(node); });
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  for (const k of globals) {
    Object.defineProperty(globalThis, k, { configurable: true, value: previous?.[k] });
  }
});

test("clicking the visible label toggles the switch", () => {
  let clicks = 0;
  const el = mount(<Switch on={false} onClick={() => { clicks += 1; }} label="Use default aliases" showLabel />);

  const text = el.querySelector(".switch-labeled-text");
  expect(text?.textContent).toBe("Use default aliases");

  // The words must be INSIDE the button, otherwise they are decoration.
  const button = el.querySelector("button.switch");
  expect(button?.contains(text as never)).toBe(true);

  act(() => { (text as never as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as never); });
  expect(clicks).toBe(1);
});

test("a labeled switch is named by its visible words, and exactly once", () => {
  const el = mount(<Switch on onClick={() => {}} label="Default window / cap" showLabel />);
  const button = el.querySelector("button.switch")!;

  // aria-label would OVERRIDE the visible text and break Label-in-Name.
  expect(button.getAttribute("aria-label")).toBeNull();
  // aria-hidden on the text would leave the button with no name at all.
  expect(el.querySelector(".switch-labeled-text")?.getAttribute("aria-hidden")).toBeNull();
  expect(button.textContent).toContain("Default window / cap");
  expect(button.getAttribute("aria-pressed")).toBe("true");
});

test("an unlabeled switch keeps aria-label and gains no redundant title", () => {
  const el = mount(<Switch on={false} onClick={() => {}} label="Keep native" />);
  const button = el.querySelector("button.switch")!;

  expect(button.getAttribute("aria-label")).toBe("Keep native");
  // HTML-AAM maps title to the accessible DESCRIPTION when aria-describedby is
  // absent. Copying the name into it announces the control twice.
  expect(button.getAttribute("title")).toBeNull();
  expect(button.querySelector(".switch-labeled-text")).toBeNull();
});

test("title stays opt-in and does not displace the accessible name", () => {
  const el = mount(<Switch on={false} onClick={() => {}} label="Shadow call" title="Explains the shadow lane" />);
  const button = el.querySelector("button.switch")!;
  expect(button.getAttribute("title")).toBe("Explains the shadow lane");
  expect(button.getAttribute("aria-label")).toBe("Shadow call");
});
