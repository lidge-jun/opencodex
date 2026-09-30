import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ROLE_INSTRUCTIONS_EXCERPT_CHARS } from "../../src/codex/role-sizing-limits";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import Subagents from "../src/pages/Subagents";

const globals = [
  "document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT",
] as const;

const SUGGESTION = {
  sizingModel: "gpt-5.5",
  sizingError: null,
  proposal: {
    model: "gpt-5.5", effort: "high", status: "proposed", tier: "fast", effortIntent: "glance",
    rationale: "Bounded read-only search.", moveUpIf: "It starts editing files.", moveDownIf: "Never.",
    proposedModel: "anthropic/claude-haiku-4-5", proposedEffort: "low", reason: null,
  },
  candidates: [],
};

let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let writes: Array<{ path: string; method: string; body: unknown }>;
let injection: { model: string | null; effort: string | null };
let suggestHold: Promise<void> | null;

beforeEach(() => {
  clearClientResourceStoresForTests();
  previousGlobals = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  writes = [];
  injection = { model: "gpt-5.5", effort: "high" };
  suggestHold = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost/").pathname;
      const method = init?.method ?? "GET";
      if (method !== "GET") writes.push({ path, method, body: JSON.parse(String(init?.body)) });
      if (path === "/api/injection-model/suggest" && method === "POST") {
        if (suggestHold) await suggestHold;
        return Response.json(SUGGESTION);
      }
      if (path === "/api/injection-model" && method === "PUT") {
        injection = { ...injection, ...(JSON.parse(String(init?.body)) as typeof injection) };
        return Response.json({ ok: true, ...injection });
      }
      if (path === "/api/injection-model") {
        return Response.json({
          ...injection,
          efforts: ["low", "medium", "high"],
          available: [
            { provider: "openai", model: "gpt-5.5", namespaced: "gpt-5.5" },
            { provider: "anthropic", model: "claude-haiku-4-5", namespaced: "anthropic/claude-haiku-4-5" },
          ],
        });
      }
      if (path === "/api/subagent-model-fallback") return Response.json({ models: [], pollMs: 45_000, available: ["gpt-5.5"] });
      if (path === "/api/subagent-models") return Response.json({ available: ["gpt-5.5"], chosen: [] });
      if (path === "/api/v2") return Response.json({ enabled: false, multiAgentMode: "v1", multiAgentModeHintText: null, keepNativeChatGptOnV1: false });
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container);
});

afterEach(async () => {
  try {
    if (root) {
      const current = root;
      await act(async () => { current.unmount(); });
      root = null;
    }
  } finally {
    clearClientResourceStoresForTests();
    testWindow.close();
    for (const key of globals) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

async function settle() {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === text);
  if (!found) throw new Error(`Button not found: ${text}`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => { target.click(); });
  await settle();
}

async function renderAndDescribe(work: string) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Subagents apiBase="" /></LanguageProvider>);
  });
  await settle();
  await click(button(en["sub.suggest.button"]));
  const textarea = container.querySelector<HTMLTextAreaElement>("#swi-suggest-work")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, work);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

test("a persistent polite live region announces the running state and then the result title", async () => {
  let release!: () => void;
  suggestHold = new Promise<void>(resolve => { release = resolve; });
  await renderAndDescribe("read-only repo searches");
  const live = container.querySelector<HTMLElement>(".swi-suggest [aria-live='polite']");
  expect(container.querySelector<HTMLTextAreaElement>("#swi-suggest-work")!.maxLength).toBe(ROLE_INSTRUCTIONS_EXCERPT_CHARS);
  expect(live).not.toBeNull();
  expect(live!.className).toContain("sr-only");
  expect(live!.textContent).toBe("");

  await click(button(en["sub.suggest.submit"]));
  expect(container.querySelector(".swi-suggest [aria-live='polite']")).toBe(live);
  expect(live!.textContent).toBe(en["sub.suggest.running"]);

  release();
  await settle();
  expect(container.querySelector(".swi-suggest [aria-live='polite']")).toBe(live);
  expect(live!.textContent).toBe(en["sub.suggest.title"]);
});

test("Suggest sizes the described work, shows the proposal without writing, and Use this saves through PUT /api/injection-model", async () => {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><Subagents apiBase="" /></LanguageProvider>);
  });
  await settle();

  await click(button(en["sub.suggest.button"]));
  expect(button(en["sub.suggest.submit"]).disabled).toBe(true);
  const textarea = container.querySelector<HTMLTextAreaElement>("#swi-suggest-work")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "  read-only repo searches  ");
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
  await click(button(en["sub.suggest.submit"]));

  expect(writes).toEqual([{ path: "/api/injection-model/suggest", method: "POST", body: { work: "read-only repo searches" } }]);
  const result = container.querySelector<HTMLElement>(".swi-suggest-result")!;
  expect(result.textContent).toContain("Fast tier, glance effort");
  expect(result.textContent).toContain("Bounded read-only search.");
  expect(result.textContent).toContain("Move up if: It starts editing files.");
  expect(result.textContent).toContain("low");

  await click(button(en["sub.suggest.accept"]));
  expect(writes.slice(1)).toEqual([
    { path: "/api/injection-model", method: "PUT", body: { model: "anthropic/claude-haiku-4-5", effort: "low" } },
  ]);
  expect(container.querySelector(".swi-suggest-done")?.textContent).toBe(en["integrations.lazycodexRoles.auto.alreadySet"]);
  expect(() => button(en["sub.suggest.accept"])).toThrow();
});
