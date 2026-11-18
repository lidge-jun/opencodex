import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { acceptActionDialog, actionDialogOpen, dismissActionDialog } from "./helpers/action-dialog";
import { chooseOption, selectValue } from "./helpers/custom-select";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT",
  "confirm", "alert", "prompt"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
/** Platform dialogs reached, which must stay empty: the app's webview draws none of them. */
let touched: string[];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  touched = [];
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
  });
  for (const name of ["confirm", "alert", "prompt"] as const) {
    const trap = () => { touched.push(name); throw new Error(`${name}() must not be reached`); };
    Object.defineProperty(globalThis, name, { configurable: true, value: trap });
    Object.defineProperty(testWindow, name, { configurable: true, value: trap });
  }
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  expect(touched).toEqual([]);
});

const dialogDocument = () => testWindow.document as unknown as Document;

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
  accountModeFocusToken = 0,
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
        accountModeFocusToken={accountModeFocusToken}
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

/** The account-mode picker: the app's Select trigger whose value is a mode. */
function modeSelect(container: HTMLElement): HTMLButtonElement {
  const select = [...container.querySelectorAll<HTMLButtonElement>("[role=combobox]")]
    .find(s => selectValue(s) === "pool" || selectValue(s) === "direct");
  expect(select).toBeTruthy();
  return select!;
}

/**
 * Picks a mode and answers the in-page consent dialog. The gate used to be `confirm()`,
 * which this file stubbed — and which the desktop webview answers false without drawing,
 * so the control could not be used there at all.
 */
async function chooseMode(select: HTMLButtonElement, value: string, answer: "accept" | "dismiss" = "accept"): Promise<void> {
  await chooseOption(select, value);
  expect(actionDialogOpen(dialogDocument())).toBe(true);
  await act(async () => {
    if (answer === "accept") acceptActionDialog(dialogDocument());
    else dismissActionDialog(dialogDocument());
    await Promise.resolve();
  });
}

test("a confirmed mode change sends the exact standalone codexAccountMode patch", async () => {
  const { root, container, patches } = await mountSettings(openAiItem("pool"));
  const select = modeSelect(container);

  await chooseMode(select, "direct");

  expect(patches).toEqual([{ codexAccountMode: "direct" }]);
  expect(selectValue(select)).toBe("direct");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Account mode saved.");
  await act(async () => { root.unmount(); });
});

test("a dismissed consent dialog sends no patch and snaps the select back", async () => {
  const { root, container, patches } = await mountSettings(openAiItem("pool"));
  const select = modeSelect(container);

  await chooseMode(select, "direct", "dismiss");

  expect(patches).toHaveLength(0);
  expect(selectValue(select)).toBe("pool");
  await act(async () => { root.unmount(); });
});

test("a failed mode patch keeps the applied mode and announces the error", async () => {
  const { root, container } = await mountSettings(openAiItem("pool"), async () => ({ ok: false, error: "mode rejected" }));
  const select = modeSelect(container);

  await chooseMode(select, "direct");

  expect(selectValue(select)).toBe("pool");
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
  expect(selectValue(modeSelect(container))).toBe("direct");
  await act(async () => { root.unmount(); });
});

test("an account-mode deep link focuses the mode control when Settings mounts (#8501)", async () => {
  const { root, container } = await mountSettings(openAiItem("direct"), undefined, 1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).toBe(modeSelect(container));
  await act(async () => { root.unmount(); });
});

test("without a deep link the mode control does not steal focus", async () => {
  const { root, container } = await mountSettings(openAiItem("direct"));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(document.activeElement).not.toBe(modeSelect(container));
  await act(async () => { root.unmount(); });
});
