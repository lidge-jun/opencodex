import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ModelDisplayNameDialog from "../src/components/ModelDisplayNameDialog";
import { LanguageProvider } from "../src/i18n/provider";
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
