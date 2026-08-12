import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * The Add Provider modal collects a name, base URL, and API key before the
 * user saves anything. Dismissing it on a backdrop click — or on a text
 * selection drag that is released outside the card — unmounts the modal and
 * wipes all of that input. The backdrop must therefore never close the
 * modal; only the × button, Escape, and a successful add may.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let closeCalls: number;

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
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

  closeCalls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: [] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: [] });
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
        <AddProviderModal
          apiBase=""
          existingNames={[]}
          initialCustom
          onClose={() => { closeCalls += 1; }}
          onAdded={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function overlay(): HTMLElement {
  const el = host.querySelector<HTMLElement>(".modal-overlay");
  expect(el).toBeTruthy();
  return el!;
}

function nameInput(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(".modal-card input.input");
  expect(el).toBeTruthy();
  return el!;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

function click(target: HTMLElement) {
  target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

test("clicking the backdrop neither closes the modal nor discards entered form data", async () => {
  await mountModal();

  await act(async () => { setInputValue(nameInput(), "my-provider"); });
  expect(nameInput().value).toBe("my-provider");

  await act(async () => { click(overlay()); });

  expect(closeCalls).toBe(0);
  expect(host.querySelector(".modal-overlay")).toBeTruthy();
  expect(nameInput().value).toBe("my-provider");
});

test("a text-selection drag released on the backdrop does not close the modal", async () => {
  await mountModal();

  await act(async () => { setInputValue(nameInput(), "sk-live-key-material"); });

  // Press inside the input (starting a selection drag), release on the overlay.
  await act(async () => {
    nameInput().dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    overlay().dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true }));
    click(overlay());
  });

  expect(closeCalls).toBe(0);
  expect(host.querySelector(".modal-overlay")).toBeTruthy();
  expect(nameInput().value).toBe("sk-live-key-material");
});

test("the close button still closes the modal", async () => {
  await mountModal();

  const closeButton = host.querySelector<HTMLElement>(".modal-head button[aria-label='Close']");
  expect(closeButton).toBeTruthy();
  await act(async () => { click(closeButton!); });

  expect(closeCalls).toBe(1);
});

test("Escape still closes the modal", async () => {
  await mountModal();

  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape" }));
  });

  expect(closeCalls).toBe(1);
});
