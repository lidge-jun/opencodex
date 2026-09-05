import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

const AZURE_PRESET = {
  id: "azure-openai",
  label: "Azure OpenAI",
  adapter: "azure-openai",
  baseUrl: "https://{resource}.openai.azure.com/openai",
  auth: "key" as const,
  keyOptional: true,
  freeTier: false,
  dashboardUrl: "https://portal.azure.com",
};

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(k => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: [AZURE_PRESET] });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountModal() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={() => {}} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
}

test("Azure keeps optional API-key setup separate from free-tier guidance", async () => {
  await mountModal();

  const azureRow = host.querySelector<HTMLElement>(".provider-catalog .list-row");
  expect(azureRow).toBeTruthy();
  await act(async () => { azureRow!.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); });

  expect(host.querySelector("input[type='password']")).toBeTruthy();
  expect(host.textContent).toContain("Azure OpenAI setup");
  expect(host.textContent).toContain("Microsoft Entra ID");
  expect(host.textContent).not.toContain("Free tier");
});
