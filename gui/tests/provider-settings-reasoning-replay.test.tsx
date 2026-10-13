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
  name: "custom-replay", adapter: "openai-responses", baseUrl: "https://relay.example/v1", authMode: "key", note: "before",
  ...(value === undefined ? {} : { preserveResponsesReasoningContent: value }),
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
function replay(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[name="preserveResponsesReasoningContent"]');
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

test("custom Responses replay is unchecked, enabling saves true and saved true can be disabled", async () => {
  const { container, patches, render } = await mount();
  expect(replay(container)?.checked).toBe(false);
  expect(container.textContent).toContain("plaintext reasoning");
  await act(async () => { replay(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]?.preserveResponsesReasoningContent).toBe(true);
  await render(provider(true));
  expect(replay(container)?.checked).toBe(true);
  await act(async () => { replay(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[1]?.preserveResponsesReasoningContent).toBe(false);
});

test("discard and saved-value refresh reset the draft; unrelated edits leave an absent value absent", async () => {
  const { container, patches, render } = await mount();
  await act(async () => { replay(container)!.click(); });
  await click(container, ".pwi-settings-sticky-bar .btn-ghost");
  expect(replay(container)?.checked).toBe(false);
  await editNote(container);
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]).not.toHaveProperty("preserveResponsesReasoningContent");
  await render(provider(true));
  expect(replay(container)?.checked).toBe(true);
  await render(provider(false));
  expect(replay(container)?.checked).toBe(false);
});

test.each([
  { adapter: "openai-chat" }, { name: "openai", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
  { name: "custom-openai", baseUrl: "https://api.openai.com/v1" }, { name: "deepseek" }, { authMode: "oauth" },
])("ineligible provider %j has no replay control and unrelated save leaves the configured flag alone", async change => {
  const { container, patches } = await mount({ ...provider(true), ...change });
  expect(replay(container)).toBeNull();
  await editNote(container);
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]).not.toHaveProperty("preserveResponsesReasoningContent");
});

test("add payload enables only an explicit custom Responses choice; changing adapter/destination cannot leak it", () => {
  const form = { name: "custom", adapter: "openai-responses", baseUrl: "https://relay.example/v1", authMode: "key" as const, apiKey: "", defaultModel: "" };
  expect(buildProviderPayload(form)).not.toHaveProperty("preserveResponsesReasoningContent");
  const enabled = { ...form, preserveResponsesReasoningContent: true };
  expect(buildProviderPayload(enabled).preserveResponsesReasoningContent).toBe(true);
  for (const change of [{ adapter: "openai-chat" }, { baseUrl: "https://api.openai.com/v1" }, { authMode: "forward" as const }]) {
    expect(buildProviderPayload({ ...enabled, ...change })).not.toHaveProperty("preserveResponsesReasoningContent");
  }
  const seed = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" as const };
  expect(buildProviderPostBody({ id: "openai", provider: seed }, enabled).provider).toEqual(seed);
});

test("custom add form exposes an unchecked control, persists an explicit choice, and hides it after an adapter change", async () => {
  let form: ProviderPayloadForm = { name: "custom", adapter: "openai-responses", baseUrl: "https://relay.example/v1", authMode: "key", apiKey: "", defaultModel: "" };
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  const render = () => root!.render(<LanguageProvider><AddProviderFormPane
    preset={{ id: "custom", label: "Custom", adapter: "openai-responses", baseUrl: "", auth: "key" }}
    form={form} endpointChoice="custom" error="" saving={false} dup={false} isCustom isLocal={false} isReservedForward={false}
    presetDescription={() => undefined} onFormChange={next => { form = next; render(); }}
    onEndpointChoiceChange={() => undefined} onSubmit={() => undefined} onUseOauthLogin={() => undefined} onBack={() => undefined}
  /></LanguageProvider>);
  await act(async () => { render(); });
  expect(replay(container)?.checked).toBe(false);
  await act(async () => { replay(container)!.click(); });
  expect(buildProviderPayload(form).preserveResponsesReasoningContent).toBe(true);
  const adapter = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    adapter.value = "openai-chat";
    adapter.dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  expect(replay(container)).toBeNull();
  expect(buildProviderPayload(form)).not.toHaveProperty("preserveResponsesReasoningContent");
});

test("a checked settings draft hidden by a destination change is not serialized and discard restores its saved state", async () => {
  const { container, patches } = await mount();
  await act(async () => { replay(container)!.click(); });
  const baseUrl = container.querySelector<HTMLInputElement>('input.input:not([disabled])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(baseUrl, "https://api.openai.com/v1");
    baseUrl.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
  expect(!!replay(container)).toBe(false);
  await click(container, ".pwi-settings-sticky-bar .btn-primary");
  expect(patches[0]).not.toHaveProperty("preserveResponsesReasoningContent");
  await click(container, ".pwi-settings-sticky-bar .btn-ghost");
  expect(replay(container)?.checked).toBe(false);
});
