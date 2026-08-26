import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import ComboWorkspace from "../src/components/ComboWorkspace";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

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

test("an empty combo list renders the first-combo editor inline", () => {
  const html = renderToStaticMarkup(
    <LanguageProvider>
      <ComboWorkspace
        combos={[]}
        providerQuotaStates={{}}
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
    </LanguageProvider>,
  );

  expect(html).toContain("combos-workspace-root");
  expect(html).toContain('id="cwi-edit-id"');
  expect(html).toContain("Internal combo id. You can change it after creation.");
  expect(html).toContain("Create combo");
  expect(html).not.toContain('role="dialog"');
  expect(html).not.toContain("Create your first combo");
});

test("an empty combo list creates the first combo and shows confirmation", async () => {
  const { createRoot } = await import("react-dom/client");
  const saved: Array<{ id: string; isCreate: boolean }> = [];
  let createdId = "";
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ComboWorkspace
          combos={[]}
          providerQuotaStates={{ openai: "available" }}
          providers={[{ name: "openai" }]}
          models={[{ provider: "openai", id: "gpt-5" }]}
          loading={false}
          onRefresh={() => {}}
          onSave={async (item, isCreate) => {
            saved.push({ id: item.id, isCreate });
            return { ok: true };
          }}
          onRemove={async () => ({ ok: true })}
          onAdd={() => {}}
          adding={false}
          onCloseAdd={() => {}}
          onCreated={(id) => { createdId = id; }}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  const idInput = container.querySelector<HTMLInputElement>("#cwi-edit-id")!;
  const providerSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(idInput, "first");
    idInput.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(providerSelect, "openai");
    providerSelect.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(idInput.value).toBe("first");
  expect(providerSelect.value).toBe("openai");
  expect(container.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.value).toBe("gpt-5");

  const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "Create combo");
  expect(createButton).toBeDefined();

  await act(async () => {
    createButton!.click();
  });

  expect(saved).toEqual([{ id: "first", isCreate: true }]);
  expect(createdId).toBe("first");
  expect(container.textContent).toContain("Created combo/first.");

  await act(async () => {
    root.unmount();
  });
});

test("first-combo Create disables only while every usable target is known exhausted", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const render = (quotaState: "available" | "exhausted") => (
    <LanguageProvider>
      <ComboWorkspace
        combos={[]}
        providerQuotaStates={{ openai: quotaState }}
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
  );

  await act(async () => { root.render(render("exhausted")); });
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

  const providerSelect = container.querySelector<HTMLSelectElement>('select[aria-label="Provider"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!
      .set!.call(providerSelect, "openai");
    providerSelect.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });

  const createButton = container.querySelector<HTMLButtonElement>("#cwi-edit-create")!;
  expect(createButton.disabled).toBe(true);
  expect(container.textContent).toContain("All enabled targets are out of quota");

  await act(async () => { root.render(render("available")); });
  expect(container.querySelector<HTMLButtonElement>("#cwi-edit-create")!.disabled).toBe(false);
  expect(container.textContent).not.toContain("All enabled targets are out of quota");

  await act(async () => { root.unmount(); });
  container.remove();
});
