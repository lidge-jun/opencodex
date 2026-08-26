import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ModelDisplayNameDialog from "../src/components/ModelDisplayNameDialog";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Models from "../src/pages/Models";
import type { ModelRow } from "../src/pages/models-shared";
import { modelDisplayNameValidationKey } from "../src/pages/models-shared";

describe("discovered model display name validation", () => {
  test("accepts a safe label at both ordinary and maximum length", () => {
    expect(modelDisplayNameValidationKey("Grok 4.6")).toBeNull();
    expect(modelDisplayNameValidationKey("A".repeat(128))).toBeNull();
  });

  test("rejects values that the management API cannot persist", () => {
    expect(modelDisplayNameValidationKey("   ")).toBe("models.displayNameRequired");
    expect(modelDisplayNameValidationKey("Grok/4.6")).toBe("models.displayNameNoSlash");
    expect(modelDisplayNameValidationKey("Grok\n4.6")).toBe("models.displayNameNoControl");
    expect(modelDisplayNameValidationKey("A".repeat(129))).toBe("models.displayNameTooLong");
  });
});

describe("Models dashboard discovered display name integration", () => {
  const globals = [
    "document", "window", "navigator", "localStorage", "sessionStorage",
    "IS_REACT_ACT_ENVIRONMENT", "fetch", "setInterval", "clearInterval",
  ] as const;
  let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
  let testWindow: Window;
  let container: HTMLElement;
  let root: Root | null;
  let mutationBodies: Array<{ modelId: string; displayName: string | null }>;
  let mutationFailure: string | null;
  let modelFetches: number;
  let currentModels: ModelRow[];

  const routedModel = (): ModelRow => ({
    provider: "xai-demo",
    id: "grok-4.6",
    namespaced: "xai-demo/grok-4.6",
    disabled: false,
    displayName: "Grok 4.6",
    displayNameOverride: "Grok 4.6",
    displayNameSource: "operator",
  });

  beforeEach(() => {
    clearClientResourceStoresForTests();
    previousGlobals = Object.fromEntries(
      globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    ) as typeof previousGlobals;
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
    currentModels = [
      routedModel(),
      { provider: "openai", id: "gpt-5.5", namespaced: "openai/gpt-5.5", disabled: false, native: true },
      {
        provider: "xai-demo", id: "custom-one", namespaced: "xai-demo/custom-one",
        disabled: false, custom: true, customId: "custom-1", displayName: "Custom One",
      },
    ];
    mutationBodies = [];
    mutationFailure = null;
    modelFetches = 0;
    testWindow.localStorage.setItem("ocx-models-collapsed:v2", JSON.stringify([]));
    testWindow.sessionStorage.setItem("ocx.models.catalog.v1:http://localhost", JSON.stringify({
      models: currentModels,
      providers: [
        { name: "xai-demo", liveModels: false, models: ["grok-4.6", "custom-one"] },
        { name: "openai", liveModels: false, models: ["gpt-5.5"] },
      ],
      selectedModels: {},
      disabled: [],
      contextCaps: {},
      contextCapValue: 350_000,
    }));

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/models")) {
        modelFetches += 1;
        return Response.json(currentModels);
      }
      if (url.endsWith("/api/providers")) return Response.json([
        { name: "xai-demo", liveModels: false, models: ["grok-4.6", "custom-one"] },
        { name: "openai", liveModels: false, models: ["gpt-5.5"] },
      ]);
      if (url.endsWith("/api/selected-models")) return Response.json({ selected: {} });
      if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
      if (url.endsWith("/api/aliases")) return Response.json({ providers: {}, models: {}, defaults: { global: false, providers: {} } });
      if (url.endsWith("/api/combos")) return Response.json({ combos: [] });
      if (url.endsWith("/api/shadow-call-settings")) return Response.json({ enabled: false, model: "" });
      if (url.endsWith("/api/v2")) return Response.json({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "default" });
      if (url.includes("/api/providers/xai-demo/model-display-names") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { modelId: string; displayName: string | null };
        mutationBodies.push(body);
        if (mutationFailure) return Response.json({ error: mutationFailure }, { status: 500 });
        currentModels = currentModels.map(row => row.namespaced !== "xai-demo/grok-4.6" ? row : {
          ...row,
          displayName: body.displayName ?? "xai-demo/grok-4.6",
          displayNameOverride: body.displayName ?? undefined,
          displayNameSource: body.displayName ? "operator" : "fallback",
        });
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    container = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(container as never);
    root = null;
  });

  afterEach(async () => {
    clearClientResourceStoresForTests();
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function flush() {
    await act(async () => {
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
  }

  async function mountModels() {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(<LanguageProvider><Models apiBase="http://localhost" /></LanguageProvider>);
    });
    await flush();
  }

  function nameTrigger(): HTMLButtonElement {
    return container.querySelector<HTMLButtonElement>(
      '[aria-label="Edit friendly name for xai-demo/grok-4.6"]',
    )!;
  }

  function dialogInput(): HTMLInputElement {
    return container.querySelector<HTMLDialogElement>("dialog")!
      .querySelector<HTMLInputElement>("input")!;
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  }

  function dialogButton(label: string): HTMLButtonElement {
    return [...container.querySelectorAll<HTMLDialogElement>("dialog button")]
      .find(button => button.textContent === label)!;
  }

  test("only discovered rows expose Name while showing friendly and exact identities", async () => {
    await mountModels();

    expect(nameTrigger()).not.toBeNull();
    expect(container.querySelectorAll('[aria-label^="Edit friendly name for "]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Edit friendly name for openai/gpt-5.5"]')).toBeNull();
    expect(container.querySelector('[aria-label="Edit friendly name for xai-demo/custom-one"]')).toBeNull();
    expect(container.textContent).toContain("Grok 4.6");
    expect(container.textContent).toContain("xai-demo/grok-4.6");
    expect(container.textContent).toContain("Custom One");
  });

  test("save and reset send exact payloads, reload the catalog, and restore trigger focus", async () => {
    await mountModels();
    const trigger = nameTrigger();
    const fetchesBeforeSave = modelFetches;

    await act(async () => trigger.click());
    await act(async () => {
      setInputValue(dialogInput(), "  Grok Fast  ");
      dialogButton("Save").click();
    });
    await flush();

    expect(mutationBodies).toEqual([{ modelId: "grok-4.6", displayName: "Grok Fast" }]);
    expect(modelFetches).toBeGreaterThan(fetchesBeforeSave);
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.textContent).toContain("Grok Fast");
    expect(testWindow.document.activeElement).toBe(trigger);

    await act(async () => nameTrigger().click());
    await act(async () => dialogButton("Reset name").click());
    await flush();

    expect(mutationBodies[1]).toEqual({ modelId: "grok-4.6", displayName: null });
    expect(container.querySelector("dialog")).toBeNull();
    expect(container.textContent).toContain("xai-demo/grok-4.6");
  });

  test("a server failure keeps the dialog and edited draft available for retry", async () => {
    mutationFailure = "Catalog refresh failed";
    await mountModels();
    await act(async () => nameTrigger().click());
    await act(async () => {
      setInputValue(dialogInput(), "Retry Name");
      dialogButton("Save").click();
    });
    await flush();

    expect(mutationBodies).toEqual([{ modelId: "grok-4.6", displayName: "Retry Name" }]);
    expect(container.querySelector("dialog")).not.toBeNull();
    expect(dialogInput().value).toBe("Retry Name");
    expect(container.textContent).toContain("Catalog refresh failed");
  });
});

describe("discovered model display name dialog", () => {
  const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
  let testWindow: Window;
  let container: HTMLElement;
  let root: Root | null;

  const model: ModelRow = {
    provider: "xai-demo",
    id: "grok-4.6",
    namespaced: "xai-demo/grok-4.6",
    disabled: false,
    displayName: "Grok 4.6",
    displayNameOverride: "Grok 4.6",
    displayNameSource: "operator",
  };

  beforeEach(() => {
    previousGlobals = Object.fromEntries(
      globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    ) as typeof previousGlobals;
    testWindow = new Window({ url: "http://localhost/" });
    Object.defineProperties(globalThis, {
      document: { configurable: true, value: testWindow.document },
      window: { configurable: true, value: testWindow },
      navigator: { configurable: true, value: testWindow.navigator },
      localStorage: { configurable: true, value: testWindow.localStorage },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    });
    container = testWindow.document.createElement("div");
    testWindow.document.body.appendChild(container as never);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const mounted = root;
      await act(async () => mounted.unmount());
    }
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function mountDialog(options: {
    saving?: boolean;
    requestError?: string | null;
    onSave?: (value: string) => void;
    onReset?: () => void;
    onClose?: () => void;
  } = {}) {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ModelDisplayNameDialog
            model={model}
            saving={options.saving ?? false}
            requestError={options.requestError ?? null}
            onSave={options.onSave ?? (() => {})}
            onReset={options.onReset ?? (() => {})}
            onClose={options.onClose ?? (() => {})}
          />
        </LanguageProvider>,
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  }

  test("opens with immutable identity and only the operator override in the input", async () => {
    await mountDialog();

    const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
    const input = container.querySelector<HTMLInputElement>("input")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("xai-demo/grok-4.6");
    expect(dialog.textContent).toContain("Grok 4.6");
    expect(dialog.textContent).toContain("Your name");
    expect(input.value).toBe("Grok 4.6");
    expect(testWindow.document.activeElement).toBe(input);
  });

  test("validates before save and sends the trimmed safe draft", async () => {
    const onSave = jest.fn();
    await mountDialog({ onSave });
    const input = container.querySelector<HTMLInputElement>("input")!;
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent === "Save")!;

    await act(async () => {
      setInputValue(input, "Bad/Name");
      save.click();
    });
    expect(container.textContent).toContain("Friendly name cannot contain /.");
    expect(onSave).not.toHaveBeenCalled();

    await act(async () => {
      setInputValue(input, "  Grok Fast  ");
      save.click();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("Grok Fast");
  });

  test("keeps request errors visible and locks every closing action while saving", async () => {
    const onClose = jest.fn();
    const onReset = jest.fn();
    await mountDialog({ saving: true, requestError: "Catalog refresh failed", onClose, onReset });

    expect(container.textContent).toContain("Catalog refresh failed");
    const actionButtons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(actionButtons.filter(button => button.tabIndex !== -1).every(button => button.disabled)).toBe(true);

    const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
    await act(async () => {
      dialog.dispatchEvent(new testWindow.Event("cancel", { bubbles: false, cancelable: true }));
      container.querySelector<HTMLButtonElement>(".modal-backdrop-dismiss")!.click();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});
