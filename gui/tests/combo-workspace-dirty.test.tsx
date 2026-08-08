import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import type { ComboItem } from "../src/combo-workspace-data";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

const combos: ComboItem[] = [
  {
    id: "alpha",
    model: "combo/alpha",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: "ct-a" }],
  },
  {
    id: "beta",
    model: "combo/beta",
    alias: null,
    nativeAlias: false,
    displayName: null,
    strategy: "failover",
    stickyLimit: 1,
    defaultEffort: null,
    targets: [{ provider: "openai", model: "gpt-5", clientKey: "ct-b" }],
  },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function flushTimers() {
  await act(async () => {
    await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

function railButton(container: HTMLElement, model: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>(".combos-workspace-rail-row")]
    .find((row) => row.querySelector(".combos-workspace-rail-name")?.textContent === model);
  if (!button) throw new Error(`rail row not found: ${model}`);
  return button;
}

test("Strict Mode: edit, revert, and unsaved navigation keep dirty state coherent", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <StrictMode>
        <LanguageProvider>
          <ComboWorkspace
            combos={combos}
            providers={[{ name: "openai" }]}
            models={[{ provider: "openai", id: "gpt-5" }]}
            loading={false}
            onRefresh={() => {}}
            onSave={async () => ({ ok: true })}
            onRemove={async () => ({ ok: true })}
            onAdd={() => {}}
            adding={false}
            onCloseAdd={() => {}}
            onCreated={() => {}}
          />
        </LanguageProvider>
      </StrictMode>,
    );
  });
  await flushTimers();

  await act(async () => {
    railButton(container, "combo/alpha").click();
  });
  await flushTimers();

  const aliasInput = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  expect(aliasInput).toBeTruthy();

  await act(async () => {
    setInputValue(aliasInput, "edited-alias");
  });
  expect(aliasInput.value).toBe("edited-alias");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeTruthy();

  const keepButton = container.querySelector<HTMLButtonElement>('[data-testid="cwi-unsaved-keep"]');
  expect(keepButton).toBeTruthy();
  await act(async () => {
    keepButton!.click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector<HTMLInputElement>("#cwi-edit-alias")?.value).toBe("edited-alias");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeTruthy();

  const discardButton = container.querySelector<HTMLButtonElement>('[data-testid="cwi-unsaved-discard"]');
  expect(discardButton).toBeTruthy();
  await act(async () => {
    discardButton!.click();
  });
  await flushTimers();
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector(".combos-workspace-detail-title")?.textContent).toBe("combo/beta");

  await act(async () => {
    railButton(container, "combo/alpha").click();
  });
  await flushTimers();

  const aliasAgain = container.querySelector<HTMLInputElement>("#cwi-edit-alias")!;
  await act(async () => {
    setInputValue(aliasAgain, "temp");
  });
  await act(async () => {
    setInputValue(aliasAgain, "");
  });
  expect(aliasAgain.value).toBe("");

  await act(async () => {
    railButton(container, "combo/beta").click();
  });
  expect(container.querySelector("#cwi-unsaved-title")).toBeNull();
  expect(container.querySelector(".combos-workspace-detail-title")?.textContent).toBe("combo/beta");

  await act(async () => {
    root.unmount();
  });
  container.remove();
});
