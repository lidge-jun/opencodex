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
  setConfirm(true);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function setConfirm(result: boolean): void {
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => result });
}

function openAiItem(mode: "pool" | "direct" = "pool"): WorkspaceItem {
  return {
    name: "openai",
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
    codexAccountMode: mode,
  } as WorkspaceItem;
}

async function mountSettings(
  item: WorkspaceItem,
  onUpdateProvider?: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>,
): Promise<{
  root: Root;
  container: HTMLElement;
  patches: ProviderUpdatePatch[];
  rerender: (item: WorkspaceItem) => Promise<void>;
}> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  const renderItem = (it: WorkspaceItem) => (
    <LanguageProvider>
      <ProviderSettings
        item={it}
        onUpdateProvider={async (name, patch) => {
          patches.push(patch);
          return onUpdateProvider ? onUpdateProvider(name, patch) : { ok: true };
        }}
      />
    </LanguageProvider>
  );
  await act(async () => {
    root = createRoot(container);
    root.render(renderItem(item));
  });
  return {
    root,
    container,
    patches,
    rerender: (it: WorkspaceItem) => act(async () => { root.render(renderItem(it)); }),
  };
}

function modeSelect(container: HTMLElement): HTMLSelectElement {
  const select = [...container.querySelectorAll<HTMLSelectElement>("select")]
    .find(s => s.value === "pool" || s.value === "direct");
  expect(select).toBeTruthy();
  return select!;
}

async function chooseMode(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

test("a confirmed mode change sends the exact standalone codexAccountMode patch", async () => {
  const { root, container, patches } = await mountSettings(openAiItem("pool"));
  const select = modeSelect(container);

  await chooseMode(select, "direct");

  expect(patches).toEqual([{ codexAccountMode: "direct" }]);
  expect(select.value).toBe("direct");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Account mode saved.");
  await act(async () => { root.unmount(); });
});

test("a cancelled confirmation sends no patch and snaps the select back", async () => {
  const { root, container, patches } = await mountSettings(openAiItem("pool"));
  const select = modeSelect(container);
  setConfirm(false);

  await chooseMode(select, "direct");

  expect(patches).toHaveLength(0);
  expect(select.value).toBe("pool");
  await act(async () => { root.unmount(); });
});

test("a failed mode patch keeps the applied mode and announces the error", async () => {
  const { root, container } = await mountSettings(openAiItem("pool"), async () => ({ ok: false, error: "mode rejected" }));
  const select = modeSelect(container);

  await chooseMode(select, "direct");

  expect(select.value).toBe("pool");
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("mode rejected");
  await act(async () => { root.unmount(); });
});

test("the mode select is disabled while its own PATCH is in flight", async () => {
  let resolvePatch!: (result: { ok: boolean }) => void;
  const pending = new Promise<{ ok: boolean }>(resolve => {
    resolvePatch = resolve;
  });
  const { root, container } = await mountSettings(openAiItem(), async () => pending);
  const select = modeSelect(container);

  await chooseMode(select, "direct");
  expect(select.disabled).toBe(true);

  await act(async () => {
    resolvePatch({ ok: true });
    await pending;
  });
  expect(select.disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("the mode select is disabled while an ordinary settings save is in flight", async () => {
  let resolveSave!: (result: { ok: boolean; error?: string }) => void;
  const pending = new Promise<{ ok: boolean; error?: string }>(resolve => {
    resolveSave = resolve;
  });
  const { root, container } = await mountSettings(openAiItem(), async () => pending);
  const note = container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!
      .set!.call(note, "changed");
    note.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  const saveButton = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!;
  expect(saveButton).toBeTruthy();
  await act(async () => {
    saveButton!.click();
    await Promise.resolve();
  });

  expect(modeSelect(container).disabled).toBe(true);
  await act(async () => {
    resolveSave({ ok: true });
    await pending;
  });
  expect(modeSelect(container).disabled).toBe(false);
  await act(async () => { root.unmount(); });
});

test("a mode-change config refresh does not wipe an unsaved draft", async () => {
  const { root, container, rerender } = await mountSettings(openAiItem("pool"));
  const note = container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!
      .set!.call(note, "draft");
    note.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeTruthy();

  // Simulate the config refresh that follows a successful mode PATCH.
  await rerender(openAiItem("direct"));

  expect(container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!.value).toBe("draft");
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeTruthy();
  expect(modeSelect(container).value).toBe("direct");
  await act(async () => { root.unmount(); });
});
