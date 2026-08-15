import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import OpenRouterModelRouting from "../src/components/provider-workspace/OpenRouterModelRouting";
import type { ProviderUpdatePatch } from "../src/components/provider-workspace/types";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | null;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
}

beforeEach(() => {
  previous = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previous;
  testWindow = new Window({ url: "http://localhost/#providers" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  testWindow.close();
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("loads exact OpenRouter endpoint tags and saves a model-only allowlist", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return Response.json({ endpoints: [{ tag: "deepinfra/turbo", providerName: "DeepInfra", supportsImplicitCaching: true }] });
  }) as typeof fetch;
  const updates: Array<{ name: string; patch: ProviderUpdatePatch }> = [];
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{ name: "openrouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1" } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["deepseek/deepseek-r1"]}
      onUpdateProvider={async (name, patch) => { updates.push({ name, patch }); return { ok: true }; }}
    /></LanguageProvider>);
  });

  const model = host.querySelector<HTMLInputElement>('input[list^="openrouter-models-"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(model, "deepseek/deepseek-r1");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  const load = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load providers"))!;
  await act(async () => { load.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests[0]).toContain("model=deepseek%2Fdeepseek-r1");

  const mode = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    mode.value = "only";
    mode.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  const endpoint = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
  await act(async () => { endpoint.click(); });
  const save = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save")!;
  await act(async () => { save.click(); await Promise.resolve(); });

  expect(updates).toEqual([{
    name: "openrouter",
    patch: { modelOpenRouterRouting: { "deepseek/deepseek-r1": { only: ["deepinfra/turbo"], allowFallbacks: true } } },
  }]);
});

test("ignores endpoint discovery that finishes after the selected model changes", async () => {
  const alpha = deferred<Response>();
  globalThis.fetch = (async input => String(input).includes("model=author%2Falpha")
    ? alpha.promise
    : Response.json({ endpoints: [{ tag: "beta/provider", providerName: "Beta" }] })) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{ name: "openrouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "author/alpha" } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["author/alpha", "author/beta"]}
    /></LanguageProvider>);
  });

  const model = host.querySelector<HTMLInputElement>('input[list^="openrouter-models-"]')!;
  const loadButton = () => [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load providers"))!;
  await act(async () => { loadButton().click(); await flush(); });
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(model, "author/beta");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await act(async () => { loadButton().click(); await flush(); });

  const mode = host.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    mode.value = "only";
    mode.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("beta/provider");

  await act(async () => {
    alpha.resolve(Response.json({ endpoints: [{ tag: "alpha/provider", providerName: "Alpha" }] }));
    await flush();
  });
  expect(host.textContent).toContain("beta/provider");
  expect(host.textContent).not.toContain("alpha/provider");
});

test("ignores a stale discovery body that finishes parsing after the selected model changes", async () => {
  const body = deferred<{ endpoints: Array<{ tag: string; providerName: string }> }>();
  globalThis.fetch = (async () => ({
    ok: true,
    json: () => body.promise,
  }) as Response) as typeof fetch;

  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{ name: "openrouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "author/alpha" } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["author/alpha", "author/beta"]}
    /></LanguageProvider>);
  });

  const load = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load providers"))!;
  await act(async () => { load.click(); await flush(); });
  const model = host.querySelector<HTMLInputElement>('input[list^="openrouter-models-"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(model, "author/beta");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await act(async () => {
    body.resolve({ endpoints: [{ tag: "alpha/provider", providerName: "Alpha" }] });
    await flush();
  });

  expect(host.textContent).not.toContain("alpha/provider");
});

test("does not show an old model save result after the selected model changes", async () => {
  const update = deferred<{ ok: boolean }>();
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{ name: "openrouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "author/alpha" } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["author/alpha", "author/beta"]}
      onUpdateProvider={async () => update.promise}
    /></LanguageProvider>);
  });

  const save = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Save")!;
  await act(async () => { save.click(); await flush(); });
  const model = host.querySelector<HTMLInputElement>('input[list^="openrouter-models-"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!.set!.call(model, "author/beta");
    model.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await act(async () => { update.resolve({ ok: true }); await flush(); });

  expect(host.textContent).not.toContain("Saved");
  expect(save.disabled).toBe(false);
});

test("offers a cache-bypassing refresh after an empty successful discovery", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return Response.json({ endpoints: [] });
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{ name: "openrouter", adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "author/model" } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["author/model"]}
    /></LanguageProvider>);
  });

  const load = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load providers"))!;
  await act(async () => { load.click(); await flush(); });
  const refresh = [...host.querySelectorAll("button")].find(button => button.textContent?.trim() === "Refresh")!;
  expect(refresh).toBeDefined();
  await act(async () => { refresh.click(); await flush(); });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("refresh=1");
});

test("labels a configured tag as absent only after successful discovery", async () => {
  globalThis.fetch = (async () => Response.json({ endpoints: [] })) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><OpenRouterModelRouting
      item={{
        name: "openrouter",
        adapter: "openai-chat",
        baseUrl: "https://openrouter.ai/api/v1",
        modelOpenRouterRouting: { "author/model": { only: ["saved/provider"], allowFallbacks: true } },
      } as WorkspaceItem}
      apiBase="http://localhost:10100"
      availableModels={["author/model"]}
    /></LanguageProvider>);
  });

  expect(host.textContent).toContain("saved/provider");
  expect(host.querySelector(".pwi-openrouter-missing")).toBeNull();
  const load = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Load providers"))!;
  await act(async () => { load.click(); await flush(); });
  expect(host.querySelector(".pwi-openrouter-missing")?.textContent).toContain("saved/provider");
});
