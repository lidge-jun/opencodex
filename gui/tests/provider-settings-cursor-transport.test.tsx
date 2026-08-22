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
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

function cursor(upstreamHttpVersion?: WorkspaceItem["upstreamHttpVersion"]): WorkspaceItem {
  return {
    name: "cursor",
    adapter: "cursor",
    baseUrl: "https://api2.cursor.sh",
    authMode: "oauth",
    note: "before",
    ...(upstreamHttpVersion === undefined ? {} : { upstreamHttpVersion }),
  };
}

async function mountSettings(item: WorkspaceItem): Promise<{
  root: Root;
  container: HTMLElement;
  patches: ProviderUpdatePatch[];
}> {
  const patches: ProviderUpdatePatch[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderSettings
          item={item}
          onUpdateProvider={async (_name, patch) => {
            patches.push(patch);
            return { ok: true };
          }}
        />
      </LanguageProvider>,
    );
  });
  return { root, container, patches };
}

function transportSelect(container: HTMLElement): HTMLSelectElement | null {
  return Array.from(container.querySelectorAll<HTMLSelectElement>("select.input"))
    .find(select => Array.from(select.options).some(option => option.value === "http1.1")) ?? null;
}

async function choose(select: HTMLSelectElement, value: "http2" | "http1.1"): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
}

async function save(container: HTMLElement): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(".pwi-settings-sticky-bar .btn-primary");
  expect(button).toBeTruthy();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

test("Cursor settings expose HTTP/2 as the default without materializing a config pin", async () => {
  const { root, container, patches } = await mountSettings(cursor());
  const select = transportSelect(container);

  expect(select?.value).toBe("http2");
  expect(select?.options[0]?.textContent).toContain("default");
  expect(container.textContent).toContain("proxy cannot reliably carry");
  expect(container.querySelector(".pwi-settings-sticky-bar")).toBeNull();
  expect(patches).toEqual([]);
  await act(async () => { root.unmount(); });
});

test("the Cursor transport control is hidden for non-Cursor adapters", async () => {
  const { root, container } = await mountSettings({
    name: "custom",
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    authMode: "key",
  });

  expect(transportSelect(container)).toBeNull();
  await act(async () => { root.unmount(); });
});

test("selecting HTTP/1.1 persists the compatibility transport", async () => {
  const { root, container, patches } = await mountSettings(cursor());
  await choose(transportSelect(container)!, "http1.1");
  await save(container);

  expect(patches).toHaveLength(1);
  expect(patches[0]?.upstreamHttpVersion).toBe("http1.1");
  await act(async () => { root.unmount(); });
});

test("selecting the default HTTP/2 clears an existing HTTP/1.1 pin", async () => {
  const { root, container, patches } = await mountSettings(cursor("h1"));
  const select = transportSelect(container)!;
  expect(select.value).toBe("http1.1");

  await choose(select, "http2");
  await save(container);

  expect(patches).toHaveLength(1);
  expect(patches[0]?.upstreamHttpVersion).toBeNull();
  await act(async () => { root.unmount(); });
});

test("an unrelated Cursor settings save leaves the omitted HTTP/2 default omitted", async () => {
  const { root, container, patches } = await mountSettings(cursor());
  const note = container.querySelector<HTMLTextAreaElement>(".pwi-settings-textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!.call(note, "after");
    note.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await save(container);

  expect(patches).toHaveLength(1);
  expect(Object.hasOwn(patches[0]!, "upstreamHttpVersion")).toBe(false);
  await act(async () => { root.unmount(); });
});
