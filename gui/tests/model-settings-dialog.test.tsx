import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import type { ModelRow } from "../src/pages/models-shared";

/**
 * The per-model settings dialog, driven through the Models page so the row button, the dialog and
 * the request it sends are exercised as one path.
 *
 * The two properties worth pinning are both about what the form SHOWS versus what it WRITES: the
 * modality boxes pre-fill from the stored declaration rather than the catalog value, and a save
 * submits only the axis the operator touched. Either one inverted makes the row look unchanged
 * after a successful write, which is the failure this dialog was written to fix.
 */
type Mutation = Record<string, unknown>;

describe("Models per-model settings dialog", () => {
  const globals = [
    "document", "window", "navigator", "localStorage", "sessionStorage",
    "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval",
  ] as const;
  let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
  let testWindow: Window;
  let container: HTMLElement;
  let root: Root | null;
  let rows: ModelRow[];
  let mutations: Mutation[];
  let settingsResponse: ((body: Mutation) => Response) | null;
  let modelsFail: boolean;

  beforeEach(() => {
    clearClientResourceStoresForTests();
    previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
    testWindow = new Window({ url: "http://localhost/#models" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
      localStorage: { configurable: true, value: testWindow.localStorage },
      sessionStorage: { configurable: true, value: testWindow.sessionStorage },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
      setInterval: { configurable: true, value: () => 1 },
      clearInterval: { configurable: true, value: () => {} },
    });
    rows = [
      {
        provider: "vendor-demo",
        id: "chat-large",
        namespaced: "vendor-demo/chat-large",
        disabled: false,
        contextWindow: 200_000,
        // What the provider published, versus what the operator stored. The dialog must show the
        // second one; showing the first is how a save came back as "nothing changed".
        inputModalities: ["text", "image"],
        inputModalitiesDeclared: ["text"],
        reasoningEfforts: ["low", "medium", "high"],
        defaultReasoningEffort: "medium",
        reasoningOverridden: false,
      },
      { provider: "vendor-demo", id: "vendor/custom", namespaced: "vendor-demo/vendor/custom", disabled: false, custom: true, customId: "custom-1" },
      { provider: "openai", id: "gpt-5.5", namespaced: "openai/gpt-5.5", disabled: false, native: true },
      { provider: "combo", id: "balanced", namespaced: "combo/balanced", disabled: false },
    ];
    const providers = [
      { name: "vendor-demo", liveModels: false, models: ["chat-large", "vendor/custom"] },
      { name: "openai", liveModels: false, models: ["gpt-5.5"] },
    ];
    mutations = [];
    settingsResponse = null;
    modelsFail = false;
    testWindow.localStorage.setItem("ocx-lang", "en");
    testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
    testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
      models: rows, providers, selectedModels: {}, disabled: [], contextCaps: {}, contextCapValue: 350_000,
    }));
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/model-settings")) {
        const body = JSON.parse(String(init?.body)) as Mutation;
        mutations.push(body);
        if (settingsResponse) return settingsResponse(body);
        return Response.json({ ok: true, provider: body.provider, modelId: body.modelId, changed: true,
          saved: true, hasOverrides: true, catalogRefresh: { status: "committed" } });
      }
      if (url.endsWith("/api/models")) return modelsFail ? new Response(null, { status: 500 }) : Response.json(rows);
      if (url.endsWith("/api/providers")) return Response.json(providers);
      if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
      if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
      if (url.endsWith("/api/aliases")) return Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
      if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    container = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(container as never);
    root = null;
  });

  afterEach(async () => {
    clearClientResourceStoresForTests();
    if (root) await act(async () => root!.unmount());
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function flush() {
    await act(async () => { await new Promise(resolve => testWindow.setTimeout(resolve, 0)); });
  }

  async function mount() {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
    });
    await flush();
  }

  function trigger(model = "vendor-demo/chat-large"): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(`[aria-label="Edit model — ${model}"]`);
  }

  function dialog(): HTMLElement | null {
    return container.querySelector<HTMLElement>("dialog");
  }

  function dialogButton(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find(node => node.textContent === label);
  }

  function checkboxes(): HTMLInputElement[] {
    return [...container.querySelectorAll<HTMLInputElement>("dialog input[type=checkbox]")];
  }

  async function open(model?: string) {
    await act(async () => trigger(model)!.click());
    await flush();
  }

  async function click(label: string) {
    await act(async () => dialogButton(label)!.click());
    await flush();
  }

  test("only a routed row offers the editor", async () => {
    await mount();
    expect(container.querySelectorAll('[aria-label^="Edit model — "]')).toHaveLength(1);
    expect(trigger("vendor-demo/vendor/custom")).toBeNull();
    expect(trigger("openai/gpt-5.5")).toBeNull();
    expect(trigger("combo/balanced")).toBeNull();
  });

  test("the dialog shows the stored declaration, not the catalog value", async () => {
    await mount();
    await open();
    const boxes = checkboxes();
    // text, image, audio, then the reasoning override — image stays unticked even though the
    // catalog advertises it, because the declaration is what this form writes.
    expect(boxes.slice(0, 3).map(box => box.checked)).toEqual([true, false, false]);
    expect(boxes[3]!.checked).toBe(false);
    expect(dialog()!.textContent).toContain("vendor-demo/chat-large");
    // A declaration exists, so the "following the upstream declaration" hint must stay away:
    // it describes the undeclared state, and showing it here would contradict the ticked box.
    expect(dialog()!.textContent).not.toContain("upstream declaration");
  });

  test("an undeclared model ticks nothing and names what it is following instead", async () => {
    delete rows[0]!.inputModalitiesDeclared;
    await mount();
    await open();
    expect(checkboxes().slice(0, 3).map(box => box.checked)).toEqual([false, false, false]);
    expect(dialog()!.textContent).toContain("text, image");
    expect(dialog()!.textContent).toContain("currently 200000");
  });

  test("the first modality tick on an undeclared model starts from what it follows", async () => {
    delete rows[0]!.inputModalitiesDeclared;
    rows[0]!.inputModalities = ["text"];
    await mount();
    await open();
    await act(async () => checkboxes()[1]!.click());
    expect(checkboxes().slice(0, 3).map(box => box.checked)).toEqual([true, true, false]);
    await click("Apply");
    expect(mutations).toEqual([{ provider: "vendor-demo", modelId: "chat-large", inputModalities: ["text", "image"] }]);
  });

  test("the context menu opens inside the modal so its options can be clicked", async () => {
    await mount();
    await open();
    const combo = dialog()!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    await act(async () => combo.click());
    // A menu portaled to <body> sits under the modal's top layer and the backdrop takes its clicks.
    expect(dialog()!.querySelector('[role="listbox"]')).not.toBeNull();
    const custom = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(node => node.textContent?.startsWith("Custom"));
    await act(async () => custom!.click());
    expect(dialog()!.querySelector('input[aria-label="Context window"]')).not.toBeNull();
  });

  test("the context draft comes from the stored declaration", async () => {
    rows[0]!.contextWindowDeclared = 128000;
    await mount();
    await open();
    expect(dialog()!.textContent).not.toContain("currently 200000");
    expect(dialog()!.textContent).toContain("128k");
  });

  test("an unknown save outcome keeps read-only recovery and allows Escape", async () => {
    await mount();
    settingsResponse = () => new Response(null, { status: 500 });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    expect(dialog()!.textContent).toContain("could not confirm whether the settings were saved");
    expect(dialogButton("Reload")).toBeDefined();
    expect(testWindow.document.activeElement).toBe(dialogButton("Reload"));
    expect(dialogButton("Apply")!.disabled).toBe(true);
    expect(dialogButton("Restore")!.disabled).toBe(true);
    expect(dialogButton("Close")!.disabled).toBe(false);
    expect(mutations).toHaveLength(1);
    await act(async () => dialog()!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true })));
    expect(dialog()).toBeNull();
  });

  test("the backdrop closes terminal recovery", async () => {
    await mount();
    settingsResponse = () => new Response(null, { status: 500 });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    await act(async () => container.querySelector<HTMLButtonElement>("dialog .modal-backdrop-dismiss")!.click());
    expect(dialog()).toBeNull();
  });

  test("reload after an unknown outcome reads the list without another mutation", async () => {
    await mount();
    settingsResponse = () => new Response(null, { status: 500 });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    await click("Reload");
    expect(mutations).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Reopen vendor-demo/chat-large");
  });

  test("a confirmed save followed by a failed local reload remains read-only", async () => {
    await mount();
    await open();
    await act(async () => checkboxes()[1]!.click());
    modelsFail = true;
    await click("Apply");
    expect(dialog()!.textContent).toContain("Saved. The model list did not reload");
    expect(dialogButton("Apply")!.disabled).toBe(true);
    await click("Reload");
    expect(dialog()).not.toBeNull();
    expect(mutations).toHaveLength(1);
    modelsFail = false;
    await click("Reload");
    expect(dialog()).toBeNull();
  });

  test("closing returns focus to the opening row control", async () => {
    await mount();
    const opener = trigger()!;
    await act(async () => opener.focus());
    await open();
    await click("Close");
    expect(testWindow.document.activeElement).toBe(opener);
  });

  test("confirmed save whose list reload fails enters read-only stale state", async () => {
    await mount();
    await open();
    modelsFail = true;
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    expect(dialog()!.textContent).toContain("Saved. The model list did not reload");
    expect(dialogButton("Reload")).toBeDefined();
    expect(dialogButton("Apply")!.disabled).toBe(true);
    expect(dialogButton("Restore")!.disabled).toBe(true);
    expect(dialogButton("Cancel")!.disabled).toBe(false);
    expect(mutations).toHaveLength(1);
    modelsFail = false;
    await click("Reload");
    expect(mutations).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Reopen vendor-demo/chat-large");
  });

  test("a rejected save stays editable with translated copy", async () => {
    await mount();
    settingsResponse = () => Response.json({ error: "raw server detail" }, { status: 400 });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    // A 4xx means nothing was written: the form stays editable and shows translated copy only.
    expect(dialog()!.textContent).toContain("rejected these settings");
    expect(dialog()!.textContent).not.toContain("raw server detail");
    expect(dialogButton("Apply")!.disabled).toBe(false);
    expect(dialogButton("Reload")).toBeUndefined();
  });

  test("a Codex catalog refresh failure is only a warning after the save", async () => {
    await mount();
    settingsResponse = body => Response.json({ ok: true, provider: body.provider, modelId: body.modelId,
      changed: true, saved: true, hasOverrides: true,
      catalogRefresh: { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: false } });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    expect(dialog()).toBeNull();
    expect(mutations).toHaveLength(1);
    expect(container.textContent).toContain("Codex model catalog did not refresh");
  });

  test("a catalog skip the operator cannot act on is a clean save", async () => {
    await mount();
    settingsResponse = body => Response.json({ ok: true, provider: body.provider, modelId: body.modelId,
      changed: true, saved: true, hasOverrides: true,
      catalogRefresh: { status: "skipped", reason: "catalog-unavailable", retryable: false } });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Model settings saved for vendor-demo/chat-large");
    expect(container.textContent).not.toContain("did not refresh");
  });

  test("a save submits only the axis the operator touched", async () => {
    await mount();
    await open();
    const image = checkboxes()[1]!;
    await act(async () => image.click());
    await click("Apply");
    expect(mutations).toEqual([{ provider: "vendor-demo", modelId: "chat-large", inputModalities: ["text", "image"] }]);
    expect(dialog()).toBeNull();
  });

  test("a no-op receipt with retained overrides uses neutral feedback", async () => {
    await mount();
    settingsResponse = body => Response.json({ ok: true, provider: body.provider, modelId: body.modelId,
      changed: false, saved: false, hasOverrides: true, catalogRefresh: { status: "skipped" } });
    await open();
    await act(async () => checkboxes()[1]!.click());
    await click("Apply");
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("No settings changed");
    expect(container.textContent).not.toContain("carries no overrides");
  });

  test("restore clears every axis, and says so when there was nothing to clear", async () => {
    await mount();
    settingsResponse = body => Response.json({ ok: true, provider: body.provider, modelId: body.modelId,
      changed: false, saved: false, hasOverrides: false, catalogRefresh: { status: "skipped" } });
    await open();
    await click("Restore");
    // The confirmation is a second dialog on the body, so answer the one it just appended.
    const confirm = [...testWindow.document.querySelectorAll("dialog")].at(-1)!;
    const accept = [...confirm.querySelectorAll("button")].find(node => node.textContent === "Restore")!;
    await act(async () => accept.click());
    await flush();
    expect(mutations).toEqual([{
      provider: "vendor-demo",
      modelId: "chat-large",
      contextWindow: null,
      inputModalities: null,
      reasoningEfforts: null,
      defaultReasoningEffort: null,
    }]);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("carries no overrides");
  });
});
