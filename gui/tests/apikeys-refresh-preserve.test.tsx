import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import ApiKeys from "../src/pages/ApiKeys";

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    actEnv: Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
  };
  restoreGlobals = () => {
    for (const [key, descriptor] of [
      ["document", previous.document],
      ["window", previous.window],
      ["localStorage", previous.localStorage],
      ["IS_REACT_ACT_ENVIRONMENT", previous.actEnv],
    ] as const) {
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
});

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/chat/completions", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/messages", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
];

const EXISTING_KEY = {
  id: "key-1",
  name: "existing-key",
  prefix: "ocx_data_12345678...",
  createdAt: "2026-01-15T12:00:00.000Z",
  usage: { requests7d: 3, totalRequests: 8, lastUsedAt: "2026-07-30T12:00:00.000Z" },
};

const KEYS_OK = {
  keys: [EXISTING_KEY],
  attributionSince: "2026-07-20T00:00:00.000Z",
  authMatrix: AUTH_MATRIX,
  baseUrl: "http://127.0.0.1:10100/v1",
  endpoint: "http://127.0.0.1:10100/v1/responses",
  responsesEndpoint: "http://127.0.0.1:10100/v1/responses",
  chatCompletionsEndpoint: "http://127.0.0.1:10100/v1/chat/completions",
  messagesEndpoint: "http://127.0.0.1:10100/v1/messages",
  modelsEndpoint: "http://127.0.0.1:10100/v1/models",
  claudeCodeEnabled: true,
};

test("successful key create keeps last-good keys visible when follow-up refresh fails", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  let keysGets = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [] });
    }
    if (url.endsWith("/api/keys") && method === "GET") {
      keysGets += 1;
      if (keysGets === 1) return Response.json(KEYS_OK);
      return new Response("upstream unavailable", { status: 503 });
    }
    if (url.endsWith("/api/keys") && method === "POST") {
      return Response.json({ key: "ocx_new_secret_value_only_shown_once" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("http://127.0.0.1:10100/v1");
    expect(container.textContent).not.toContain("Could not load API keys.");

    const generate = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Generate"));
    expect(generate).toBeTruthy();

    await act(async () => {
      generate!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(keysGets).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("http://127.0.0.1:10100/v1");
    expect(container.textContent).toContain("Could not load API keys.");
    expect(container.textContent).not.toContain("No API keys yet.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});

test("successful key delete keeps last-good keys visible when follow-up refresh fails", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  let keysGets = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [] });
    }
    if (url.endsWith("/api/keys") && method === "GET") {
      keysGets += 1;
      if (keysGets === 1) return Response.json(KEYS_OK);
      return Response.json({ not: "keys" }, { status: 500 });
    }
    if (url.endsWith("/api/keys") && method === "DELETE") {
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <ApiKeys apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("existing-key");

    // Retargeted from the rail to the key table; the invariant under test —
    // last-good keys survive a failed post-delete refresh — is unchanged.
    const keyRow = [...container.querySelectorAll<HTMLButtonElement>(".awi-keylist-name")]
      .find((button) => button.textContent?.includes("existing-key"));
    expect(keyRow).toBeTruthy();
    await act(async () => {
      keyRow!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
    });

    const deleteBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Delete API key"]');
    expect(deleteBtn).toBeTruthy();
    await act(async () => {
      deleteBtn!.click();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 310));
    });

    const confirmBtn = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Confirm"));
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn!.disabled).toBe(false);

    await act(async () => {
      confirmBtn!.click();
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(keysGets).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("existing-key");
    expect(container.textContent).toContain("Could not load API keys.");
  } finally {
    await act(async () => root.unmount());
    testWindow.close();
  }
});
