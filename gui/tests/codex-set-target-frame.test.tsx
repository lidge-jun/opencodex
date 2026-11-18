import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexSet from "../src/pages/CodexSet";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

/**
 * Codex Set's Multi-auth frame belongs to the logical target. A relay keeps the
 * same apiBase across a re-pair, so the panel and its cached account-mode banner
 * must be keyed by the target identity rather than the apiBase alone.
 */

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

async function mount(apiBase: string, targetKey: string): Promise<HTMLElement> {
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as never);
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <CodexSet apiBase={apiBase} machineApiBase={apiBase} targetKey={targetKey} />
      </LanguageProvider>,
    );
  });
  return container;
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/#codex-set" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  clearClientResourceStoresForTests();
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  if (root) {
    const current = root;
    root = null;
    await act(async () => { current.unmount(); });
  }
  // Leave the shared api module on the default standalone target for the next file.
  configureApiTargets(standaloneApiTargets(""));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await win.happyDOM?.close?.();
});

test("a logical target change starts a fresh Multi-auth frame", async () => {
  let holdConfig = false;
  const held: Array<() => void> = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/config")) {
        if (holdConfig) return await new Promise<Response>(resolve => held.push(() => resolve(json({ providers: {} }))));
        return json({ providers: {} });
      }
      return json({});
    },
  });

  const container = await mount("/same", "hub-a");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(container.textContent).toContain("Enable OpenAI");

  holdConfig = true;
  await act(async () => {
    root!.render(
      <LanguageProvider>
        <CodexSet apiBase="/same" machineApiBase="/same" targetKey="hub-b" />
      </LanguageProvider>,
    );
  });
  // A's account-mode frame must not survive under B's label while B's read is pending.
  expect(container.textContent).not.toContain("Enable OpenAI");

  await act(async () => {
    for (const release of held.splice(0)) release();
    await new Promise(resolve => setTimeout(resolve, 20));
  });
  // B's own answer drives the banner again.
  expect(container.textContent).toContain("Enable OpenAI");
});

test("the legacy relay preflight notice appears for Codex Set's own target only", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => json({ providers: {} }),
  });
  const container = await mount("/same", "hub-a");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const notice = "This proxy checks the save target before sending, but cannot verify it atomically. Update the proxy for target-bound saves.";
  expect(container.textContent).not.toContain(notice);

  await act(async () => {
    win.dispatchEvent(new win.CustomEvent("opencodex:target-preflight-legacy", { detail: { targetKey: "hub-b" } }));
  });
  expect(container.textContent).not.toContain(notice);

  await act(async () => {
    win.dispatchEvent(new win.CustomEvent("opencodex:target-preflight-legacy", { detail: { targetKey: "hub-a" } }));
  });
  expect(container.textContent).toContain(notice);
});
