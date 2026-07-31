/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import ApiKeys from "../src/pages/ApiKeys";

// The protocol chips are the one control on this page that claims a key really
// works. A test that rebuilds the request map beside the component proves only
// that the test agrees with itself, so this one mounts the real page, drives a
// real create, and reads the requests that actually left `fetch`.

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/chat/completions", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/messages", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
];

const KEYS_OK = {
  keys: [],
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

const ONE_TIME_KEY = "ocx_data_onetime_secret_value";

interface SentRequest {
  url: string;
  method: string;
  key: string | null;
  authorization: string | null;
  body: Record<string, unknown>;
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  testWindow = new Window({ url: "http://localhost/" });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
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

/** Routes every request the page makes and records the data-plane ones. */
function installFetch(sent: SentRequest[], dataPlaneStatus = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models") && method === "GET") {
      return Response.json({ data: [{ id: "gpt-5.4", owned_by: "openai" }] });
    }
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS_OK);
    if (url.endsWith("/api/keys") && method === "POST") return Response.json({ key: ONE_TIME_KEY });
    if (method === "POST") {
      const headers = new Headers(init?.headers);
      sent.push({
        url,
        method,
        key: headers.get("x-opencodex-api-key"),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      if (dataPlaneStatus !== 200) return new Response("model not routable", { status: dataPlaneStatus });
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

async function mountWithFreshKey(): Promise<{ container: HTMLDivElement; root: Root }> {
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
  const generate = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(button => button.textContent?.includes("Generate"));
  expect(generate).toBeTruthy();
  await act(async () => { generate!.click(); });
  await tick();
  await tick();
  return { container, root };
}

function chips(container: HTMLDivElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".api-model-test-chip button")];
}

test("each protocol chip posts its own endpoint and body, carrying the one-time key", async () => {
  const sent: SentRequest[] = [];
  installFetch(sent);
  const { container, root } = await mountWithFreshKey();
  try {
    const buttons = chips(container);
    expect(buttons).toHaveLength(3);
    for (const chip of buttons) {
      await act(async () => { chip.click(); });
      await tick();
    }

    expect(sent.map(s => s.url)).toEqual([
      "http://127.0.0.1:10100/v1/responses",
      "http://127.0.0.1:10100/v1/chat/completions",
      "http://127.0.0.1:10100/v1/messages",
    ]);
    // Each protocol speaks its own wire. A chat body posted at /v1/responses
    // would be rejected for its shape, not for the key, and the green chip
    // would then be lying about what it proved.
    expect(sent[0]!.body).toMatchObject({ model: "gpt-5.4", input: "ping", stream: false });
    expect(sent[0]!.body).not.toHaveProperty("messages");
    expect(sent[1]!.body).toMatchObject({ model: "gpt-5.4", max_tokens: 1, stream: false });
    expect(sent[1]!.body).toHaveProperty("messages");
    expect(sent[2]!.body).toMatchObject({ model: "gpt-5.4", max_tokens: 1 });
    expect(sent[2]!.body).not.toHaveProperty("stream");

    // The dedicated header is the only one every data-plane endpoint accepts;
    // Bearer is rejected at /v1/responses, so sending it would prove nothing.
    expect(sent.every(s => s.key === ONE_TIME_KEY)).toBe(true);
    expect(sent.every(s => s.authorization === null)).toBe(true);

    // Three chips, three independent results — a shared slot would collapse
    // them into one and hide which protocol actually answered.
    const notes = [...container.querySelectorAll(".api-test-note")];
    expect(notes).toHaveLength(3);
    expect(notes.every(note => note.className.includes("api-test-note--ok"))).toBe(true);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a rejected test surfaces the server's own words, not a generic failure", async () => {
  const sent: SentRequest[] = [];
  installFetch(sent, 404);
  const { container, root } = await mountWithFreshKey();
  try {
    await act(async () => { chips(container)[0]!.click(); });
    await tick();
    expect(sent).toHaveLength(1);
    const note = container.querySelector(".api-test-note");
    expect(note?.textContent).toContain("model not routable");
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("before a key exists the chips send nothing at all", async () => {
  const sent: SentRequest[] = [];
  installFetch(sent);
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
  try {
    const buttons = chips(container);
    expect(buttons).toHaveLength(3);
    expect(buttons.every(button => button.disabled)).toBe(true);
    for (const chip of buttons) await act(async () => { chip.click(); });
    await tick();
    // On a loopback bind an unauthenticated request passes regardless of the
    // key, so a chip that fired here would report a pass it never earned.
    expect(sent).toHaveLength(0);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
