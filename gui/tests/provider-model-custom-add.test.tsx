import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderModels from "../src/components/provider-workspace/ProviderModels";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalFetch = globalThis.fetch;
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
  globalThis.fetch = originalFetch;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

const item = {
  name: "AiCodeWith",
  adapter: "openai-chat",
  baseUrl: "https://example.test/v1",
  models: ["claude-opus-5"],
  defaultModel: "claude-opus-5",
} as WorkspaceItem;

async function mountProviderModels(
  availableModels = ["claude-opus-5"],
  onRetryModels?: () => void,
  providerItem = item,
  hasLiveModels = true,
): Promise<{ root: Root; container: HTMLElement; input: HTMLInputElement; addButton: HTMLButtonElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ProviderModels
          item={providerItem}
          availableModels={availableModels}
          hasLiveModels={hasLiveModels}
          selectedModels={[]}
          apiBase="http://localhost:10100"
          onRetryModels={onRetryModels}
        />
      </LanguageProvider>,
    );
  });
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Add custom model"]')!;
  const addButton = [...container.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Add") as HTMLButtonElement;
  return { root, container, input, addButton };
}

async function enterModelId(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(input, value);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

test("quick-add submits the trimmed model id for the current provider", async () => {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    if (!init?.method || init.method === "GET") return Response.json([]);
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ id: "custom-1" }, { status: 201 });
  }) as typeof fetch;

  let refreshes = 0;
  const { root, container, input, addButton } = await mountProviderModels(
    ["claude-opus-5"],
    () => { refreshes += 1; },
  );
  await enterModelId(input, "  claude-opus-5.1  ");
  await act(async () => {
    addButton.click();
    await Promise.resolve();
  });

  expect(requests).toEqual([{
    url: "http://localhost:10100/api/custom-models",
    method: "POST",
    body: { provider: "AiCodeWith", modelId: "claude-opus-5.1" },
  }]);
  expect(refreshes).toBe(1);
  expect(input.value).toBe("");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Custom model added");

  await act(async () => { root.unmount(); });
});

test("quick-add blocks existing ids but allows namespaced model ids", async () => {
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === "GET") return Response.json([]);
    requests += 1;
    return Response.json({ id: "unexpected" }, { status: 201 });
  }) as typeof fetch;
  const { root, input, addButton } = await mountProviderModels();

  await enterModelId(input, "claude-opus-5");
  expect(addButton.disabled).toBe(true);
  await enterModelId(input, "vendor/model");
  expect(addButton.disabled).toBe(false);
  expect(requests).toBe(0);

  await act(async () => { root.unmount(); });
});

test("quick-add blocks a slash id that encodes to an existing native id", async () => {
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === "GET") return Response.json([]);
    requests += 1;
    return Response.json({ id: "unexpected" }, { status: 201 });
  }) as typeof fetch;
  const colliding = { ...item, models: ["openai-gpt-5.5"], defaultModel: "openai-gpt-5.5" } as WorkspaceItem;
  const { root, input, addButton } = await mountProviderModels(["openai-gpt-5.5"], undefined, colliding);

  await enterModelId(input, "openai/gpt-5.5");
  expect(addButton.disabled).toBe(true);
  expect(requests).toBe(0);

  await act(async () => { root.unmount(); });
});

test("quick-add keeps the model id when the server rejects it", async () => {
  globalThis.fetch = (async (_input, init) => (
    !init?.method || init.method === "GET"
      ? Response.json([])
      : Response.json({ error: "duplicate model" }, { status: 409 })
  )) as typeof fetch;
  const { root, container, input, addButton } = await mountProviderModels();
  await enterModelId(input, "claude-opus-5.1");

  await act(async () => {
    addButton.click();
    await Promise.resolve();
  });

  expect(input.value).toBe("claude-opus-5.1");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Failed to save custom model");

  await act(async () => { root.unmount(); });
});

test("quick-add recovers from a network failure", async () => {
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === "GET") return Response.json([]);
    throw new Error("offline");
  }) as typeof fetch;
  const { root, container, input, addButton } = await mountProviderModels();
  await enterModelId(input, "claude-opus-5.1");

  await act(async () => {
    addButton.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(input.disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Network error");

  await act(async () => { root.unmount(); });
});

test("custom-only catalog keeps configured fallback models visible", async () => {
  // Discovery returned nothing for this provider, so the configured fallback must stay visible.
  globalThis.fetch = (async () => Response.json([
    { id: "custom-1", provider: "AiCodeWith", modelId: "claude-opus-5.1-custom" },
  ])) as typeof fetch;

  // Discovery returned nothing for this provider, so the configured fallback must stay visible.
  const { root, container } = await mountProviderModels(["claude-opus-5.1-custom"], undefined, item, false);
  await act(async () => { await Promise.resolve(); });

  const modelIds = [...container.querySelectorAll(".pws-model-id")].map(node => node.textContent);
  expect(modelIds).toEqual(["claude-opus-5", "claude-opus-5.1-custom"]);

  await act(async () => { root.unmount(); });
});

// A single transient GET used to leave `customModelsReady` false forever: the effect had no
// remaining trigger, so Add stayed disabled until the whole panel remounted. Drive the full
// recovery in one mount: failed load -> retry -> successful load -> Add enabled -> exactly one POST.
test("a failed custom-model lookup recovers through retry without a remount", async () => {
  let getCalls = 0;
  const posts: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (!init?.method || init.method === "GET") {
      getCalls += 1;
      if (getCalls === 1) throw new Error("offline");
      return Response.json([]);
    }
    posts.push(String(input));
    return Response.json({ id: "custom-9", provider: "AiCodeWith", modelId: "claude-opus-5.1" });
  }) as typeof fetch;

  const { root, container, input, addButton } = await mountProviderModels();
  await act(async () => { await Promise.resolve(); });

  // The first load failed, so Add must be blocked and a retry affordance must be offered.
  expect(getCalls).toBe(1);
  await enterModelId(input, "claude-opus-5.1");
  expect(addButton.disabled).toBe(true);
  const alert = container.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Network error");
  const retryButton = [...alert.querySelectorAll("button")]
    .find(button => button.textContent?.trim() === "Retry") as HTMLButtonElement;
  expect(retryButton).toBeDefined();

  await act(async () => { retryButton.click(); await Promise.resolve(); await Promise.resolve(); });

  // The retry refetched in the same mount and Add is usable again.
  expect(getCalls).toBe(2);
  expect(addButton.disabled).toBe(false);

  await act(async () => { addButton.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(posts).toHaveLength(1);

  await act(async () => { root.unmount(); });
});

test("successful quick-add appears immediately when catalog refresh is unavailable", async () => {
  globalThis.fetch = (async (_input, init) => (
    !init?.method || init.method === "GET"
      ? Response.json([])
      : Response.json({ id: "custom-1" }, { status: 201 })
  )) as typeof fetch;
  const emptyItem = { ...item, models: [], defaultModel: undefined } as WorkspaceItem;
  const { root, container, input, addButton } = await mountProviderModels([], undefined, emptyItem);
  await enterModelId(input, "claude-opus-5.1-custom");

  await act(async () => {
    addButton.click();
    await Promise.resolve();
  });

  expect(container.querySelector(".pws-model-id")?.textContent).toBe("claude-opus-5.1-custom");
  await act(async () => { root.unmount(); });
});

test("quick-add waits for custom-model duplicate knowledge", async () => {
  let resolveLookup!: (response: Response) => void;
  const lookup = new Promise<Response>(resolve => { resolveLookup = resolve; });
  let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === "GET") return lookup;
    posts += 1;
    return Response.json({ id: "unexpected" }, { status: 201 });
  }) as typeof fetch;
  const emptyItem = { ...item, models: [], defaultModel: undefined } as WorkspaceItem;
  const { root, input, addButton } = await mountProviderModels([], undefined, emptyItem);
  await enterModelId(input, "already-custom");

  expect(addButton.disabled).toBe(true);
  await act(async () => {
    resolveLookup(Response.json([{ provider: "AiCodeWith", modelId: "already-custom" }]));
    await lookup;
    await Promise.resolve();
  });
  expect(addButton.disabled).toBe(true);
  expect(posts).toBe(0);

  await act(async () => { root.unmount(); });
});

test("quick-add stays blocked when custom-model lookup fails", async () => {
  let posts = 0;
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === "GET") throw new Error("offline");
    posts += 1;
    return Response.json({ id: "unexpected" }, { status: 201 });
  }) as typeof fetch;
  const emptyItem = { ...item, models: [], defaultModel: undefined } as WorkspaceItem;
  const { root, input, addButton } = await mountProviderModels([], undefined, emptyItem);
  await enterModelId(input, "unknown-custom");
  await act(async () => { await Promise.resolve(); });

  expect(addButton.disabled).toBe(true);
  expect(posts).toBe(0);

  await act(async () => { root.unmount(); });
});
