/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import ApiKeys from "../src/pages/ApiKeys";

// The model catalog had one sentence for three different situations: nothing
// installed, nothing matching the search, and a load that failed. This pins
// each of them to its own observable, and pins the retry to a real second GET.

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const KEYS_OK = {
  keys: [],
  attributionSince: "2026-07-20T00:00:00.000Z",
  authMatrix: [
    { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
    { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  ],
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  claudeCodeEnabled: true,
};

beforeEach(() => {
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (previousLanguageDescriptor) {
      Object.defineProperty(globalThis.navigator, "language", previousLanguageDescriptor);
    } else {
      delete (globalThis.navigator as { language?: string }).language;
    }
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearClientResourceStoresForTests();
  restoreGlobals?.();
  testWindow.close();
});

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms));
    await Promise.resolve();
  });
}

/** `models` is consulted per GET, so a test can change what the next one returns. */
function installFetch(models: () => Response, counter: { gets: number }): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models") && method === "GET") {
      counter.gets += 1;
      return models();
    }
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS_OK);
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function mountPage(): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = testWindow.document.createElement("div") as unknown as HTMLDivElement;
  testWindow.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ApiKeys apiBase="http://localhost" />
      </LanguageProvider>,
    );
  });
  await tick();
  return { container, root };
}

function typeQuery(container: HTMLDivElement, value: string): Promise<void> {
  const search = container.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search).toBeTruthy();
  return act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype, "value",
    )!.set!;
    setter.call(search!, value);
    search!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

function retryButton(container: HTMLDivElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".api-models-error button")][0];
}

test("an empty catalog says the catalog is empty, with no query in the sentence", async () => {
  const counter = { gets: 0 };
  installFetch(() => Response.json({ data: [] }), counter);
  const { container, root } = await mountPage();
  try {
    expect(container.textContent).toContain("No externally callable models are available yet.");
    expect(container.textContent).not.toContain("No models match");
    expect(retryButton(container)).toBeUndefined();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a query matching nothing names the query, and does not claim the catalog is empty", async () => {
  const counter = { gets: 0 };
  installFetch(() => Response.json({
    data: [{ id: "gpt-5.4", owned_by: "openai" }, { id: "claude/opus-4-6", owned_by: "anthropic" }],
  }), counter);
  const { container, root } = await mountPage();
  try {
    expect(container.textContent).toContain("gpt-5.4");
    await typeQuery(container, "nothing-matches-this");
    await tick();

    // Two models exist; the catalog is not empty, the filter is.
    expect(container.textContent).toContain("No models match");
    expect(container.textContent).toContain("nothing-matches-this");
    expect(container.textContent).not.toContain("No externally callable models are available yet.");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a failed cold load offers a retry that really refetches, and no false empty state", async () => {
  const counter = { gets: 0 };
  let fail = true;
  installFetch(
    () => (fail
      ? new Response("upstream unavailable", { status: 503 })
      : Response.json({ data: [{ id: "gpt-5.4", owned_by: "openai" }] })),
    counter,
  );
  const { container, root } = await mountPage();
  try {
    expect(counter.gets).toBe(1);
    expect(container.textContent).toContain("Could not load the external model catalog.");
    // Never assert an empty catalog from a payload we failed to read.
    expect(container.textContent).not.toContain("No externally callable models are available yet.");

    const retry = retryButton(container);
    expect(retry).toBeTruthy();
    fail = false;
    await act(async () => { retry!.click(); });
    await tick();
    await tick();

    expect(counter.gets).toBe(2);
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.textContent).not.toContain("Could not load the external model catalog.");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a failed load keeps the rows it already had, with the retry beside them", async () => {
  // Seed the cache the way a previous visit would have, then fail the refresh.
  // A failure that blanks the catalog costs the user information they already
  // had, to tell them about a request that has nothing to do with those rows.
  testWindow.sessionStorage.setItem(
    "ocx.apikeys.models.v1:http://localhost",
    JSON.stringify([{ id: "cached-model", displayName: "cached-model", provider: "openai", native: true }]),
  );
  const counter = { gets: 0 };
  installFetch(() => new Response("upstream unavailable", { status: 503 }), counter);
  const { container, root } = await mountPage();
  try {
    expect(counter.gets).toBe(1);
    // Error and last-good rows coexist.
    expect(container.textContent).toContain("Could not load the external model catalog.");
    expect(container.textContent).toContain("cached-model");
    expect(retryButton(container)).toBeTruthy();
    expect(container.textContent).not.toContain("No externally callable models are available yet.");

    await act(async () => { retryButton(container)!.click(); });
    await tick();
    expect(counter.gets).toBe(2);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a failure is announced, and a cache-backed retry shows progress without losing rows", async () => {
  testWindow.sessionStorage.setItem(
    "ocx.apikeys.models.v1:http://localhost",
    JSON.stringify([{ id: "cached-model", displayName: "cached-model", provider: "openai", native: true }]),
  );
  const counter = { gets: 0 };
  let release: (() => void) | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models") && method === "GET") {
      counter.gets += 1;
      if (counter.gets === 1) return new Response("upstream unavailable", { status: 503 });
      // Hold the retry open so the in-flight state is observable.
      await new Promise<void>(resolve => { release = resolve; });
      return Response.json({ data: [{ id: "fresh-model", owned_by: "openai" }] });
    }
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS_OK);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { container, root } = await mountPage();
  try {
    // The failure has to be announced, not merely drawn. Moving the message
    // from a page notice into the panel must not cost a screen reader the news.
    const alert = container.querySelector('.api-models-error [role="alert"]');
    expect(alert?.textContent).toContain("Could not load the external model catalog.");

    await act(async () => { retryButton(container)!.click(); });
    await tick();

    // Mid-retry: rows stay, and the page says something is happening. Silence
    // here reads as "the retry button did nothing".
    expect(container.textContent).toContain("cached-model");
    expect(container.textContent).toContain("Loading models");

    release?.();
    await tick();
    await tick();
    expect(container.textContent).toContain("fresh-model");
    expect(container.querySelector(".api-models-error")).toBeNull();
  } finally {
    release?.();
    await act(async () => { root.unmount(); });
  }
});
