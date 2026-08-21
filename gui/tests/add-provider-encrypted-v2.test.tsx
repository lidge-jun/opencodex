import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AddProviderModal from "../src/components/AddProviderModal";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let postedBodies: unknown[];
let presetRows: unknown[] = [];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  originalFetch = globalThis.fetch;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  postedBodies = [];
  presetRows = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: presetRows });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      if (url.pathname === "/api/providers" && init?.method === "POST") {
        postedBodies.push(JSON.parse(String(init.body)));
        return Response.json({ ok: true });
      }
      return Response.json({});
    },
  });

  host = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await testWindow.happyDOM?.close?.();
});

async function mountModal(onAdded: (name: string) => void = () => {}): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialCustom onClose={() => {}} onAdded={onAdded} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}

async function mountCatalogModal(initialTier: "accounts" | "free" | "paid" = "paid"): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier={initialTier} onClose={() => {}} onAdded={() => {}} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}

function adapterSelect(): HTMLSelectElement {
  const select = host.querySelector<HTMLSelectElement>("select.input");
  expect(select).toBeTruthy();
  return select!;
}

function endpointSelect(): HTMLSelectElement {
  const selects = host.querySelectorAll<HTMLSelectElement>("select.input");
  expect(selects.length).toBeGreaterThan(1);
  return selects[1]!;
}

async function chooseAdapter(value: string): Promise<void> {
  const select = adapterSelect();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

function encryptedTaskCheckbox(): HTMLInputElement | null {
  const label = Array.from(host.querySelectorAll<HTMLLabelElement>("label")).find(candidate =>
    candidate.textContent?.includes("Pass through encrypted V2 agent tasks"),
  );
  return label?.querySelector<HTMLInputElement>("input[type='checkbox']") ?? null;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
}

test("custom provider creation confirms and posts encrypted V2 passthrough only for Responses adapters", async () => {
  const added: string[] = [];
  await mountModal(name => added.push(name));

  expect(adapterSelect().value).toBe("openai-chat");
  expect(encryptedTaskCheckbox()).toBeNull();

  await chooseAdapter("openai-responses");
  const checkbox = encryptedTaskCheckbox();
  expect(checkbox).toBeTruthy();
  expect(checkbox!.checked).toBe(false);

  let confirmCalls = 0;
  testWindow.confirm = () => { confirmCalls += 1; return true; };
  await act(async () => { checkbox!.click(); });
  expect(confirmCalls).toBe(1);
  expect(checkbox!.checked).toBe(true);

  const textInputs = host.querySelectorAll<HTMLInputElement>("input.input:not([type='password'])");
  await act(async () => {
    setInputValue(textInputs[0]!, "trusted-responses");
    setInputValue(textInputs[1]!, "https://responses.example.test/v1");
  });

  // The trust confirmation must be made for the final destination, not before it.
  expect(encryptedTaskCheckbox()!.checked).toBe(false);
  testWindow.confirm = () => true;
  await act(async () => { encryptedTaskCheckbox()!.click(); });

  const addButton = host.querySelector<HTMLButtonElement>("button.btn-primary");
  expect(addButton).toBeTruthy();
  await act(async () => {
    addButton!.click();
    await Promise.resolve();
  });

  expect(added).toEqual(["trusted-responses"]);
  expect(postedBodies).toEqual([{
    name: "trusted-responses",
    provider: {
      adapter: "openai-responses",
      baseUrl: "https://responses.example.test/v1",
      authMode: "key",
      allowEncryptedV2AgentTasks: true,
    },
  }]);
});

test("changing a confirmed custom endpoint clears the opt-in before submit", async () => {
  await mountModal();
  await chooseAdapter("openai-responses");

  const textInputs = host.querySelectorAll<HTMLInputElement>("input.input:not([type='password'])");
  await act(async () => {
    setInputValue(textInputs[0]!, "trusted-responses");
    setInputValue(textInputs[1]!, "https://responses-a.example.test/v1");
  });
  testWindow.confirm = () => true;
  await act(async () => { encryptedTaskCheckbox()!.click(); });
  expect(encryptedTaskCheckbox()!.checked).toBe(true);

  await act(async () => {
    setInputValue(textInputs[1]!, "https://responses-b.example.test/v1");
  });
  expect(encryptedTaskCheckbox()!.checked).toBe(false);

  await act(async () => {
    host.querySelector<HTMLButtonElement>("button.btn-primary")!.click();
    await Promise.resolve();
  });
  expect(postedBodies).toEqual([{
    name: "trusted-responses",
    provider: {
      adapter: "openai-responses",
      baseUrl: "https://responses-b.example.test/v1",
      authMode: "key",
    },
  }]);
});

test("changing a confirmed preset endpoint clears the opt-in before submit", async () => {
  presetRows = [{
    id: "responses-endpoints",
    label: "Responses endpoints",
    adapter: "openai-responses",
    baseUrl: "https://responses-a.example.test/v1",
    auth: "key",
    baseUrlChoices: [
      { id: "primary", label: "Primary", baseUrl: "https://responses-a.example.test/v1" },
      { id: "secondary", label: "Secondary", baseUrl: "https://responses-b.example.test/v1" },
    ],
  }];
  await mountCatalogModal();
  await act(async () => {
    const row = Array.from(host.querySelectorAll<HTMLButtonElement>("button.list-row"))
      .find(candidate => candidate.textContent?.includes("Responses endpoints"));
    expect(row).toBeTruthy();
    row!.click();
  });

  testWindow.confirm = () => true;
  await act(async () => { encryptedTaskCheckbox()!.click(); });
  expect(encryptedTaskCheckbox()!.checked).toBe(true);

  await act(async () => {
    const select = endpointSelect();
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!.set!.call(select, "secondary");
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(encryptedTaskCheckbox()!.checked).toBe(false);

  await act(async () => {
    host.querySelector<HTMLButtonElement>("button.btn-primary")!.click();
    await Promise.resolve();
  });
  expect(postedBodies).toEqual([{
    name: "responses-endpoints",
    provider: {
      adapter: "openai-responses",
      baseUrl: "https://responses-b.example.test/v1",
      authMode: "key",
    },
  }]);
});

test("changing away from Responses clears the encrypted V2 opt-in", async () => {
  await mountModal();
  await chooseAdapter("openai-responses");

  testWindow.confirm = () => true;
  await act(async () => { encryptedTaskCheckbox()!.click(); });
  expect(encryptedTaskCheckbox()!.checked).toBe(true);

  await chooseAdapter("openai-chat");
  expect(encryptedTaskCheckbox()).toBeNull();
  await chooseAdapter("openai-responses");
  expect(encryptedTaskCheckbox()?.checked).toBe(false);
});
