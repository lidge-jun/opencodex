import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers/workspace" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => true });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

function item(name = "google-antigravity", tlsProfile?: string, tlsProfileStatus = "disabled"): WorkspaceItem {
  return {
    name,
    adapter: name === "google-antigravity" ? "google" : "openai-chat",
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    authMode: name === "google-antigravity" ? "oauth" : "key",
    tlsProfile,
    tlsProfileStatus,
  } as unknown as WorkspaceItem;
}

async function mountSettings(
  provider: WorkspaceItem,
  onUpdateProvider: (name: string, patch: ProviderUpdatePatch) => Promise<{ ok: boolean; error?: string }>,
): Promise<{ root: Root; container: HTMLElement; patches: ProviderUpdatePatch[] }> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={provider}
          onUpdateProvider={async (name, patch) => {
            patches.push(patch);
            return onUpdateProvider(name, patch);
          }}
        />
      </LanguageProvider>,
    );
  });
  return { root, container, patches };
}

async function saveTls(container: HTMLElement): Promise<void> {
  const toggle = container.querySelector<HTMLInputElement>("[data-testid='antigravity-tls-profile']");
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });
  const save = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(save).toBeTruthy();
  await act(async () => { save!.click(); await Promise.resolve(); });
}

test("Antigravity TLS profile is opt-in and requires confirmation before save", async () => {
  const { root, container, patches } = await mountSettings(item(), async () => ({ ok: true }));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Unofficial");
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => false });
  await saveTls(container);
  expect(patches).toHaveLength(0);
  expect(container.querySelector<HTMLInputElement>("[data-testid='antigravity-tls-profile']")?.checked).toBe(false);
  await act(async () => { root.unmount(); });
});

test("confirmed Antigravity TLS profile save sends the fixed profile and shows status", async () => {
  const { root, container, patches } = await mountSettings(item(undefined, undefined, "fallback"), async () => ({ ok: true }));
  expect(container.querySelector("[data-testid='antigravity-tls-status']")?.textContent).toContain("Fallback");
  await saveTls(container);
  expect(patches[0]?.tlsProfile).toBe("antigravity-browser");
  await act(async () => { root.unmount(); });
});

test("combined pacing and TLS save sends both fields after one confirmation", async () => {
  const { root, container, patches } = await mountSettings(item(), async () => ({ ok: true }));
  const rpm = container.querySelector<HTMLInputElement>(".pwi-pacing-grid input[type='number']");
  expect(rpm).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(rpm, "31");
    rpm!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    container.querySelector<HTMLInputElement>("[data-testid='antigravity-tls-profile']")!.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click();
    await Promise.resolve();
  });
  expect(patches).toHaveLength(1);
  expect(patches[0]?.requestPacing).toBeDefined();
  expect(patches[0]?.tlsProfile).toBe("antigravity-browser");
  await act(async () => { root.unmount(); });
});

test("cancelled combined pacing and TLS save sends neither field", async () => {
  const { root, container, patches } = await mountSettings(item(), async () => ({ ok: true }));
  Object.defineProperty(testWindow, "confirm", { configurable: true, value: () => false });
  const rpm = container.querySelector<HTMLInputElement>(".pwi-pacing-grid input[type='number']");
  expect(rpm).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(rpm, "31");
    rpm!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
    container.querySelector<HTMLInputElement>("[data-testid='antigravity-tls-profile']")!.click();
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary")!.click();
    await Promise.resolve();
  });
  expect(patches).toHaveLength(0);
  await act(async () => { root.unmount(); });
});

test("other providers do not render the Antigravity TLS profile control", async () => {
  const { root, container, patches } = await mountSettings(item("openrouter"), async () => ({ ok: true }));
  expect(container.querySelector("[data-testid='antigravity-tls-profile']")).toBeNull();
  expect(patches).toHaveLength(0);
  await act(async () => { root.unmount(); });
});
