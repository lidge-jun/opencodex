import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { useProviderSettingsDeepLink } from "../src/pages/providers-deep-link";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers?provider=beta" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

type Snapshot = { selected: string | null; token: number; provider: string | null };

async function mount(names: string[] | null) {
  const seen: Snapshot[] = [];
  let choose!: (name: string | null) => void;
  function Harness({ providerNames }: { providerNames: string[] | null }) {
    const [selected, setSelected] = useState<string | null>(null);
    choose = setSelected;
    const focus = useProviderSettingsDeepLink(providerNames, selected, setSelected);
    seen.push({ selected, ...focus });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<Harness providerNames={names} />);
  });
  return {
    last: () => seen[seen.length - 1]!,
    rerender: (next: string[] | null) => act(async () => { root.render(<Harness providerNames={next} />); }),
    choose: (name: string | null) => act(async () => { choose(name); }),
    unmount: () => act(async () => { root.unmount(); }),
  };
}

async function hash(next: string) {
  await act(async () => {
    testWindow.location.hash = next;
    testWindow.dispatchEvent(new testWindow.HashChangeEvent("hashchange"));
  });
}

test("a provider link selects that provider and focuses its settings", async () => {
  const view = await mount(["alpha", "beta"]);
  expect(view.last()).toMatchObject({ selected: "beta", provider: "beta" });
  expect(view.last().token).toBeGreaterThan(0);
  await view.unmount();
});

test("a link waits for the provider list and ignores a name that never appears", async () => {
  const view = await mount(null);
  expect(view.last()).toMatchObject({ selected: null, token: 0 });
  await view.rerender(["alpha"]);
  expect(view.last()).toMatchObject({ selected: null, token: 0 });
  await view.rerender(["alpha", "beta"]);
  expect(view.last()).toMatchObject({ selected: "beta", provider: "beta" });
  await view.unmount();
});

test("Back/Forward to another provider link re-applies it", async () => {
  const view = await mount(["alpha", "beta"]);
  const first = view.last().token;
  await hash("providers?provider=alpha");
  expect(view.last()).toMatchObject({ selected: "alpha", provider: "alpha" });
  expect(view.last().token).toBeGreaterThan(first);
  await hash("providers?provider=beta");
  expect(view.last()).toMatchObject({ selected: "beta", provider: "beta" });
  await view.unmount();
});

test("choosing another provider drops the link so a refresh does not reopen it", async () => {
  const view = await mount(["alpha", "beta"]);
  await view.choose("alpha");
  expect(testWindow.location.hash).toBe("#providers");
  await view.unmount();
});
