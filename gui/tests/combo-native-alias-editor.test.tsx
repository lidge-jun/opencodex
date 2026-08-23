import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ComboItem } from "../src/combo-workspace-data";
import { DetailPanel } from "../src/components/combo-workspace-detail-panel";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobalDescriptors: Record<
  (typeof globals)[number],
  PropertyDescriptor | undefined
>;
let testWindow: Window;

beforeEach(() => {
  previousGlobalDescriptors = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobalDescriptors;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    const descriptor = previousGlobalDescriptors[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function flushTimers() {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

const target = [{ provider: "openai", model: "gpt-5", clientKey: "ct-native" }];
const providers = [{ name: "openai" }];
const models = [{ provider: "openai", id: "gpt-5" }];

async function renderPanel(baseline: ComboItem, isCreate: boolean, onSave: (item: ComboItem) => void) {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <DetailPanel
          baseline={baseline}
          isCreate={isCreate}
          otherIds={[]}
          otherAliases={[]}
          providerMap={{ openai: {} }}
          providerQuotaStates={{ openai: "available" }}
          providers={providers}
          models={models}
          onSaved={() => {}}
          onSave={async item => { onSave(item); return { ok: true }; }}
          onDirtyChange={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await flushTimers();
  return { container, root };
}

test("create exposes and saves nativeAlias plus displayName", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "combo/nova",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, true, item => { saved = item; });
  const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  const nativeAlias = container.querySelector<HTMLInputElement>("#cwi-edit-native-alias")!;
  const displayName = container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!;
  expect(nativeAlias).toBeTruthy();
  expect(displayName).toBeTruthy();
  await act(async () => {
    setInputValue(alias, "gpt-5.6-sol");
    nativeAlias.click();
  });
  const displayNameAfterToggle = container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!;
  await act(async () => { setInputValue(displayNameAfterToggle, "Nova Sol"); });
  const create = container.querySelector<HTMLButtonElement>("#cwi-edit-create");
  expect(create).toBeTruthy();
  await act(async () => { create!.click(); });
  expect(saved).toMatchObject({ alias: "gpt-5.6-sol", nativeAlias: true, displayName: "Nova Sol" });
  await act(async () => root.unmount());
  container.remove();
});

test("edit renders existing nativeAlias state and persists display-name changes", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "gpt-5.6-sol",
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "Nova Sol",
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, false, item => { saved = item; });
  const nativeAlias = container.querySelector<HTMLInputElement>("#cwi-edit-native-alias")!;
  const displayName = container.querySelector<HTMLInputElement>("#cwi-edit-display-name")!;
  expect(nativeAlias.checked).toBe(true);
  expect(displayName.value).toBe("Nova Sol");
  await act(async () => { setInputValue(displayName, "Nova Sol 2"); });
  const save = container.querySelector<HTMLButtonElement>("#cwi-edit-save");
  expect(save).toBeTruthy();
  await act(async () => { save!.click(); });
  expect(saved).toMatchObject({ nativeAlias: true, displayName: "Nova Sol 2" });
  await act(async () => root.unmount());
  container.remove();
});


test("edit clears native-alias metadata when alias leaves native family", async () => {
  const baseline: ComboItem = {
    id: "nova",
    model: "gpt-5.6-sol",
    alias: "gpt-5.6-sol",
    nativeAlias: true,
    displayName: "Nova Sol",
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: target,
  };
  let saved: ComboItem | undefined;
  const { container, root } = await renderPanel(baseline, false, item => { saved = item; });
  const alias = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  await act(async () => { setInputValue(alias, "vendor/custom"); });
  const save = container.querySelector<HTMLButtonElement>("#cwi-edit-save");
  expect(save).toBeTruthy();
  await act(async () => { save!.click(); });
  expect(saved).toMatchObject({
    alias: "vendor/custom",
    model: "vendor/custom",
    nativeAlias: false,
    displayName: null,
  });
  await act(async () => root.unmount());
  container.remove();
});
