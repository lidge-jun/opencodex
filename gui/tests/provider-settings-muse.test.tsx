import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import { buildProviderPayload, buildProviderPostBody } from "../src/provider-payload";
import type { ProviderPayloadForm } from "../src/provider-payload";
import { AddProviderFormPane } from "../src/components/add-provider-form-pane";
import { chooseOption, selectTrigger } from "./helpers/custom-select";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>;
let win: Window;
let root: Root | undefined;
beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)]));
  win = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  for (const [key, value] of Object.entries({ document: win.document, window: win, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  win.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: previous[key] });
});

const provider = (value?: boolean): WorkspaceItem => ({
  name: "muse-code", adapter: "muse-msp", baseUrl: "https://api.meta.ai/v1", authMode: "key", note: "before",
  ...(value === undefined ? {} : { museProjectDeveloperPrompt: value }),
});
async function mount(item = provider()) {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const render = async (next: WorkspaceItem) => act(async () => {
    root ??= createRoot(container);
    root.render(<LanguageProvider><ProviderSettings item={next} onUpdateProvider={async (_name, patch) => { patches.push(patch); return { ok: true }; }} /></LanguageProvider>);
  });
  await render(item);
  return { container, patches, render };
}
function museControl(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[name="museProjectDeveloperPrompt"]');
}
async function click(container: HTMLElement, selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).toBeTruthy();
  await act(async () => { button!.click(); });
}
async function editNote(container: HTMLElement) {
  const note = container.querySelector<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")!.set!.call(note, "changed");
    note.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

test("Muse projection is explicit, reversible, and saved through provider settings", async () => {
  const { container, patches, render } = await mount();
  expect(museControl(container)?.checked).toBe(false);
  expect(container.textContent).toContain("Muse merges client developer instructions");
  await act(async () => { museControl(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]?.museProjectDeveloperPrompt).toBe(true);
  await render(provider(true));
  expect(museControl(container)?.checked).toBe(true);
  await act(async () => { museControl(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[1]?.museProjectDeveloperPrompt).toBe(false);
});

test("discard restores the saved choice and unrelated saves do not create it", async () => {
  const { container, patches } = await mount();
  await act(async () => { museControl(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-ghost");
  expect(museControl(container)?.checked).toBe(false);
  await editNote(container); await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]).not.toHaveProperty("museProjectDeveloperPrompt");
});

test("other adapters do not show the Muse projection control", async () => {
  const { container } = await mount({ ...provider(), name: "other", adapter: "openai-responses" });
  expect(museControl(container)).toBeNull();
});
