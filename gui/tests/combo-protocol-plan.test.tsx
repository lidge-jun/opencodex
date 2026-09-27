import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { planProtocol } from "../../src/protocols/plan";
import { FEATURE_SOURCES, PROTOCOL_FEATURES } from "../../src/protocols/features";
import { ComboProtocolPlan } from "../src/components/protocols/ComboProtocolPlan";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";
import { clearProtocolPlanCache } from "../src/protocol-api";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; body?: unknown }> = [];

const INFO = {
  schemaVersion: 1,
  contractVersion: "x",
  policyRevision: "p1-00000001",
  surfaces: { responses: { enabled: true }, chat: { enabled: true }, messages: { enabled: true } },
  settings: { unrepresentable: "legacy" },
  features: [...PROTOCOL_FEATURES],
};
const RESPONSES_FEATURES = PROTOCOL_FEATURES.filter(feature => FEATURE_SOURCES[feature].includes("responses"));
const PLAN = planProtocol({
  inbound: "responses",
  requestedModel: "combo/pair",
  routeKind: "combo",
  candidates: [
    { provider: "a", model: "m1", adapter: "openai-responses", nativeEligible: true, declineReasons: [] },
    { provider: "b", model: "m2", adapter: "openai-chat", nativeEligible: false, declineReasons: [] },
  ],
  features: RESPONSES_FEATURES,
  surfaces: INFO.surfaces,
  settings: { unrepresentable: "legacy" },
  policyRevision: INFO.policyRevision,
  basis: "preview",
});

function serve(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return routes[new URL(url).pathname]?.() ?? new Response("{}", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  clearProtocolPlanCache();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#models/combos" });
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

async function render(dirty = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ComboProtocolPlan apiBase="http://hub" model="combo/pair" dirty={dirty} /></LanguageProvider>);
  });
  const click = async () => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".combo-protocol-plan button")!.click();
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  return { container, click, unmount: () => act(async () => { root.unmount(); }) };
}

test("fetches nothing until asked, then plans every feature the client API can express", async () => {
  serve({ "/api/protocols": () => Response.json(INFO), "/api/protocols/plan": () => Response.json(PLAN) });
  const view = await render();
  expect(calls).toEqual([]);
  await view.click();
  expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/api/protocols", "/api/protocols/plan"]);
  expect(calls[1]!.body).toEqual({ model: "combo/pair", inbound: "responses", features: RESPONSES_FEATURES });
  const text = view.container.textContent ?? "";
  expect(text).toContain(DICTS.en["api.plan.guaranteed"]);
  expect(text).toContain(DICTS.en["api.plan.partial"]);
  expect(text).toContain("a/m1");
  expect(text).toContain("b/m2");
  expect(view.container.querySelectorAll(".protocol-plan-candidate")).toHaveLength(2);
  await view.unmount();
});

test("an older server hides the section quietly", async () => {
  serve({});
  const view = await render();
  await view.click();
  expect(view.container.innerHTML).toBe("");
  await view.unmount();
});

test("says the preview reads the saved combo while edits are unsaved", async () => {
  serve({});
  const view = await render(true);
  expect(view.container.textContent).toContain(DICTS.en["cws.plan.savedOnly"]);
  await view.unmount();
});
