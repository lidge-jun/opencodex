import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { ShadowCallSourceToggles } from "../src/pages/shadow-call-source-toggles";
import type { ShadowCallSourceOption } from "../src/pages/shadow-call-source";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;

const options: ShadowCallSourceOption[] = [
  { id: "gpt-6-luna", role: "helper", defaultIntercepted: true },
  { id: "gpt-5.6-luna", role: "helper", defaultIntercepted: true },
  { id: "gpt-5.6-terra", role: "memory", defaultIntercepted: false },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  root = null;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
  }
  root = null;
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function render(sourceModels: string[], disabled = false) {
  const changes: string[][] = [];
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ShadowCallSourceToggles
          options={options}
          sourceModels={sourceModels}
          disabled={disabled}
          onChange={next => changes.push(next)}
        />
      </LanguageProvider>,
    );
  });
  return changes;
}

function sourceSwitch(id: string, role: string): HTMLButtonElement {
  const button = host.querySelector(`button[aria-label="${id} (${role})"]`);
  if (!button) throw new Error(`missing switch for ${id}`);
  return button as HTMLButtonElement;
}

test("clicking an inactive source adds its exact prefix", async () => {
  const changes = await render(["gpt-6-luna", "gpt-5.6-luna"]);
  act(() => sourceSwitch("gpt-5.6-terra", "Memory").click());
  expect(changes).toEqual([["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra"]]);
});

test("the last active source is disabled", async () => {
  const changes = await render(["gpt-5.6-terra"]);
  const button = sourceSwitch("gpt-5.6-terra", "Memory");
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain("Must stay on");
  act(() => button.click());
  expect(changes).toEqual([]);
});

test("the main switch disables every source toggle", async () => {
  await render(["gpt-6-luna", "gpt-5.6-luna"], true);
  expect(sourceSwitch("gpt-6-luna", "Helper").disabled).toBe(true);
  expect(sourceSwitch("gpt-5.6-terra", "Memory").disabled).toBe(true);
});

test("a broader custom prefix keeps covered toggles disabled with an explanation", async () => {
  await render(["gpt-5.6"]);
  const button = sourceSwitch("gpt-5.6-terra", "Memory");
  expect(button.disabled).toBe(true);
  expect(button.title).toContain("gpt-5.6");
  expect(host.textContent).toContain("Covered by gpt-5.6");
});
