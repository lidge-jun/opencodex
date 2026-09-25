import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";
import { ApiKeysEndpointsPanel } from "../src/pages/api-keys-endpoints-panel";
import { parseApiSurfaces, type ApiSurfacesInfo } from "../src/pages/api-keys-utils";
import { patchProtocolSettings } from "../src/protocol-api";

const en = DICTS.en;
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const endpoints = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};
const authMatrix = [{ endpoint: "/v1/responses", bearer: "rejected" as const, dedicated: "required" as const, xApiKey: "rejected" as const }];

function surfaces(messages: ApiSurfacesInfo["messages"]): ApiSurfacesInfo {
  return {
    responses: { enabled: true, source: "fixed" },
    chat: { enabled: true, source: "fixed" },
    messages,
  };
}

const INFO = {
  schemaVersion: 1,
  policyRevision: "p1-00000002",
  surfaces: surfaces({ enabled: false, source: "api-surfaces" }),
  settings: { unrepresentable: "legacy" },
  features: ["request.tools"],
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
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

async function mount(props: Partial<Parameters<typeof ApiKeysEndpointsPanel>[0]>): Promise<{ root: Root; container: HTMLElement }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ApiKeysEndpointsPanel endpoints={endpoints} claudeCodeEnabled authMatrix={authMatrix} {...props} />
      </LanguageProvider>,
    );
  });
  return { root, container };
}

describe("parseApiSurfaces", () => {
  test("accepts the server shape", () => {
    expect(parseApiSurfaces(INFO.surfaces)).toEqual(INFO.surfaces);
  });

  test.each([
    ["absent", undefined],
    ["an array", []],
    ["a missing surface", { responses: { enabled: true, source: "fixed" }, chat: { enabled: true, source: "fixed" } }],
    ["a non-boolean state", surfaces({ enabled: "yes" as never, source: "api-surfaces" })],
    ["an unknown source", surfaces({ enabled: true, source: "guess" as never })],
  ])("answers undefined for %s", (_label, value) => {
    expect(parseApiSurfaces(value)).toBeUndefined();
  });
});

describe("API surface cards", () => {
  test("an older server without surfaces keeps the flat endpoint list", async () => {
    const { root, container } = await mount({ claudeCodeEnabled: false });
    expect(container.querySelector(".api-surface-card")).toBeNull();
    expect(container.textContent).not.toContain(en["api.messagesEndpoint"]);
    await act(async () => root.unmount());
  });

  test("three cards with state and source, and a closed Messages card stays visible", async () => {
    const { root, container } = await mount({
      surfaces: surfaces({ enabled: false, source: "claude-code-legacy" }),
      apiBase: "http://127.0.0.1:10100",
      onSurfacesChanged: () => {},
    });
    const cards = [...container.querySelectorAll("[data-surface]")].map(card => card.getAttribute("data-surface"));
    expect(cards).toEqual(["responses", "chat", "messages"]);
    const messages = container.querySelector('[data-surface="messages"]')!;
    expect(messages.textContent).toContain(endpoints.messages);
    expect(messages.textContent).toContain(en["api.surface.off"]);
    expect(messages.textContent).toContain(en["api.surface.source.inherited"]);
    expect(messages.textContent).toContain(en["api.surface.closedNote"]);
    expect(messages.textContent).toContain(en["api.surface.openClaude"]);
    expect(container.querySelector('[data-surface="responses"]')!.textContent).toContain(en["api.surface.source.fixed"]);
    // Only Messages is switchable.
    expect(container.querySelectorAll(".switch")).toHaveLength(1);
    await act(async () => root.unmount());
  });

  test("an invalid value reads as closed", async () => {
    const { root, container } = await mount({
      surfaces: surfaces({ enabled: false, source: "invalid" }),
      apiBase: "",
      onSurfacesChanged: () => {},
    });
    const messages = container.querySelector('[data-surface="messages"]')!;
    expect(messages.textContent).toContain(en["api.surface.source.invalid"]);
    expect(messages.textContent).toContain(en["api.surface.off"]);
    await act(async () => root.unmount());
  });

  test("the toggle PATCHes the target apiBase and asks the page to reload", async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, body: String(init?.body) });
      return new Response(JSON.stringify(INFO), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    let changed = 0;
    const { root, container } = await mount({
      surfaces: surfaces({ enabled: true, source: "claude-code-legacy" }),
      apiBase: "http://hub.example:10100",
      onSurfacesChanged: () => { changed++; },
    });
    const toggle = container.querySelector<HTMLButtonElement>('[data-surface="messages"] .switch')!;
    await act(async () => { toggle.click(); });
    expect(calls).toEqual([{ url: "http://hub.example:10100/api/protocols/settings", method: "PATCH", body: JSON.stringify({ messagesEnabled: false }) }]);
    expect(changed).toBe(1);
    await act(async () => root.unmount());
  });

  test("a failed toggle says so and does not reload", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "write_failed" } }), { status: 500 })) as unknown as typeof fetch;
    let changed = 0;
    const { root, container } = await mount({
      surfaces: surfaces({ enabled: true, source: "api-surfaces" }),
      apiBase: "",
      onSurfacesChanged: () => { changed++; },
    });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-surface="messages"] .switch')!.click(); });
    expect(container.textContent).toContain(en["api.surface.toggleFailed"]);
    expect(changed).toBe(0);
    await act(async () => root.unmount());
  });
});

describe("patchProtocolSettings", () => {
  test("an older server without the route reads as unavailable", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await patchProtocolSettings("", { messagesEnabled: true })).toEqual({ kind: "unavailable" });
  });

  test("a refusal carries the server's code", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "config_busy" } }), { status: 409 })) as unknown as typeof fetch;
    expect(await patchProtocolSettings("", { messagesEnabled: true })).toEqual({ kind: "error", code: "config_busy" });
  });

  test("a success returns the validated fresh info", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(INFO), { status: 200 })) as unknown as typeof fetch;
    const result = await patchProtocolSettings("", { messagesEnabled: false });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.info.surfaces.messages.enabled).toBe(false);
  });
});
