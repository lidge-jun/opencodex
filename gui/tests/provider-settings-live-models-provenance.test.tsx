import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
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
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function provider(liveModels?: boolean): WorkspaceItem {
  return {
    name: "custom-provider",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    note: "before",
    ...(liveModels === undefined ? {} : { liveModels }),
  } as WorkspaceItem;
}

async function mountSettings(item: WorkspaceItem): Promise<{
  root: Root;
  container: HTMLElement;
  patches: ProviderUpdatePatch[];
}> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={item}
          onUpdateProvider={async (_name, patch) => {
            patches.push(patch);
            return { ok: true };
          }}
        />
      </LanguageProvider>,
    );
  });
  return { root, container, patches };
}

async function save(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

test("an unrelated settings save does not materialize an omitted liveModels value", async () => {
  const { root, container, patches } = await mountSettings(provider());
  const note = container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!
      .set!.call(note, "after");
    note.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await save(container);

  expect(patches).toHaveLength(1);
  expect(Object.hasOwn(patches[0]!, "liveModels")).toBe(false);
  expect(Object.hasOwn(patches[0]!, "requestPacing")).toBe(false);
  await act(async () => { root.unmount(); });
});

test("changing an omitted effective true to false sends an explicit liveModels choice", async () => {
  const { root, container, patches } = await mountSettings(provider());
  const toggles = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  await act(async () => { toggles[1]!.click(); });
  await save(container);

  expect(patches[0]?.liveModels).toBe(false);
  await act(async () => { root.unmount(); });
});

test("changing an explicit false to true sends an explicit liveModels choice", async () => {
  const { root, container, patches } = await mountSettings(provider(false));
  const toggles = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  await act(async () => { toggles[1]!.click(); });
  await save(container);

  expect(patches[0]?.liveModels).toBe(true);
  await act(async () => { root.unmount(); });
});

test("canonical ClinePass shows the static catalog as disabled even with stale liveModels true", async () => {
  const { root, container } = await mountSettings({
    name: "cline-pass",
    adapter: "openai-chat",
    baseUrl: "https://api.cline.bot/api/v1",
    authMode: "key",
    liveModels: true,
  } as WorkspaceItem);
  const toggles = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  expect(toggles[1]?.disabled).toBe(true);
  expect(toggles[1]?.checked).toBe(false);
  await act(async () => { root.unmount(); });
});

test("same-named custom MiMo provider keeps live discovery editable", async () => {
  const { root, container } = await mountSettings({
    name: "mimo-free",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
    liveModels: true,
  } as WorkspaceItem);
  const toggles = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  expect(toggles[1]?.disabled).toBe(false);
  expect(toggles[1]?.checked).toBe(true);
  await act(async () => { root.unmount(); });
});

test("key-optional auth fallback remains local for unrelated providers", async () => {
  const { root, container } = await mountSettings({
    name: "custom-provider",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    keyOptional: true,
  } as WorkspaceItem);
  const selects = container.querySelectorAll<HTMLSelectElement>("select.input");

  expect(selects[1]?.value).toBe("local");
  await act(async () => { root.unmount(); });
});
