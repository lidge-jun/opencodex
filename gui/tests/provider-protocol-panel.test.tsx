import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ProtocolProviderSummaryV1 } from "../../src/protocols/dto";
import { ProviderProtocolPanel } from "../src/components/provider-workspace/ProviderProtocolPanel";
import ProviderSettings from "../src/components/provider-workspace/ProviderSettings";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";
import { fetchProtocolProviderSummary } from "../src/protocol-api";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
let calls: string[] = [];

const SUMMARY: ProtocolProviderSummaryV1 = {
  name: "custom",
  adapter: "openai-chat",
  adapterSource: "operator",
  authMode: "key",
  upstream: "chat",
  modelOverrides: [
    { model: "wide", adapter: "openai-responses", source: "operator" },
    { model: "pinned", adapter: "anthropic", source: "hard-pin" },
  ],
};

function serve(respond: (url: URL) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return respond(new URL(String(input), "http://localhost"));
  }) as typeof fetch;
}

function info(extra: Record<string, unknown> = {}): Response {
  return Response.json({ schemaVersion: 1, policyRevision: "p1", features: [], surfaces: {}, ...extra });
}

beforeEach(() => {
  calls = [];
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#providers" });
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
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function renderPanel(props: Parameters<typeof ProviderProtocolPanel>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderProtocolPanel {...props} /></LanguageProvider>);
  });
  // Let the summary fetch settle.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return { container, unmount: () => act(async () => { root.unmount(); }) };
}

test("labels the adapter as the upstream wire and shows who decided it", async () => {
  serve(() => info({ provider: SUMMARY }));
  const { container, unmount } = await renderPanel({ apiBase: "http://hub", providerName: "custom", savedAdapter: "openai-chat" });
  const text = container.textContent ?? "";
  expect(text).toContain(DICTS.en["pws.protocol.adapterLabel"]);
  expect(text).toContain(DICTS.en["pws.protocol.source.operator"]);
  expect(text).toContain(DICTS.en["pws.protocol.source.hardPin"]);
  expect(text).toContain("wide");
  expect(text).toContain("pinned");
  expect(calls).toEqual(["http://hub/api/protocols?provider=custom"]);
  await unmount();
});

test("the dashboard's own same-origin target (an empty base) still loads the panel", async () => {
  serve(() => info({ provider: SUMMARY }));
  const { container, unmount } = await renderPanel({ apiBase: "", providerName: "custom", savedAdapter: "openai-chat" });
  expect(calls).toEqual(["/api/protocols?provider=custom"]);
  expect(container.textContent ?? "").toContain(DICTS.en["pws.protocol.adapterLabel"]);
  await unmount();
});

test("offers no control, so it cannot pass for an API exposure switch", async () => {
  serve(() => info({ provider: SUMMARY }));
  const { container, unmount } = await renderPanel({ apiBase: "http://hub", providerName: "custom", savedAdapter: "openai-chat" });
  const panel = container.querySelector('[data-testid="provider-protocol-panel"]');
  expect(panel).not.toBeNull();
  expect(panel!.querySelectorAll("input, select, button, [role='switch']")).toHaveLength(0);
  await unmount();
});

test("says what an unsaved adapter choice would send", async () => {
  serve(() => info({ provider: SUMMARY }));
  const { container, unmount } = await renderPanel({
    apiBase: "http://hub",
    providerName: "custom",
    savedAdapter: "openai-chat",
    draftAdapter: "anthropic",
  });
  expect(container.textContent).toContain("After you save, this provider receives anthropic.");
  await unmount();
});

test("hides quietly for an older server: 404 or no provider block", async () => {
  serve(() => new Response("{}", { status: 404 }));
  const missing = await renderPanel({ apiBase: "http://old", providerName: "custom", savedAdapter: "openai-chat" });
  expect(missing.container.innerHTML).toBe("");
  await missing.unmount();

  serve(() => info());
  const ignored = await renderPanel({ apiBase: "http://older", providerName: "custom", savedAdapter: "openai-chat" });
  expect(ignored.container.innerHTML).toBe("");
  await ignored.unmount();
});

test("fetchProtocolProviderSummary refuses a block for another provider", async () => {
  serve(() => info({ provider: { ...SUMMARY, name: "other" } }));
  expect(await fetchProtocolProviderSummary("http://hub", "custom")).toEqual({ kind: "error" });
  serve(() => info({ provider: { ...SUMMARY, adapterSource: "captured-auth" } }));
  expect(await fetchProtocolProviderSummary("http://hub", "custom")).toEqual({ kind: "error" });
});

test("provider settings without an API target fetch nothing for the panel", async () => {
  serve(() => info({ provider: SUMMARY }));
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ProviderSettings
      item={{ name: "custom", adapter: "openai-chat", baseUrl: "https://custom.example/v1", authMode: "key" }}
      onUpdateProvider={async () => ({ ok: true })}
    /></LanguageProvider>);
  });
  expect(calls).toEqual([]);
  expect(container.querySelector('[data-testid="provider-protocol-panel"]')).toBeNull();
  await act(async () => { root.unmount(); });
});
