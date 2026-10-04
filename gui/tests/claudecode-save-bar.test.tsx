import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ClaudeCode from "../src/pages/ClaudeCode";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { readSessionListCacheEntry } from "../src/session-list-cache";

/**
 * The single-page Claude Code settings have one Save bar. These mount the page because the
 * failures that matter are races between a draft and a server read: a Save acknowledgement
 * that never settles, an edit made while Save is in flight, and the 1P switch's re-read.
 */

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;

beforeEach(() => {
  clearClientResourceStoresForTests();
  const language = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const previous = (["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const)
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  restoreGlobals = () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    if (language) Object.defineProperty(globalThis.navigator, "language", language);
    else delete (globalThis.navigator as { language?: string }).language;
  };
});

test("a successful Save replaces the session copy even when its refresh fails", async () => {
  const server = { systemEnv: false };
  let offline = false;
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      Object.assign(server, JSON.parse(String(init.body)));
      offline = true;
      return Response.json({ ok: true });
    }
    if (offline) return Response.json({ error: "offline" }, { status: 503 });
    return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  try {
    await page.click(page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!);
    await page.click(page.button("Save"));
    expect(server.systemEnv).toBe(true);
    const cached = readSessionListCacheEntry<{ state: { systemEnv: boolean } }>("ocx.claude-code.v1:http://localhost");
    expect(cached?.data?.state.systemEnv).toBe(true);
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a read begun before a successful Save cannot undo it", async () => {
  // The 1P switch's GET is held until after Save is acknowledged and refreshed; every read
  // after it fails, so only the read epoch keeps the stale response out of the draft.
  let releaseStale!: () => void;
  const stale = new Promise<void>(resolve => { releaseStale = resolve; });
  const server = { systemEnv: false, cliFirstParty: false };
  let holdNextGet = false;
  let staleReleased = false;
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      Object.assign(server, JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    const snapshot = { ...SERVER, autoConnectSupported: true, ...server, modelMap: {} };
    // Once the stale read is released, the network fails: nothing later can paper over it.
    if (staleReleased) return Response.json({ error: "offline" }, { status: 503 });
    if (holdNextGet) {
      holdNextGet = false;
      await stale;
      staleReleased = true;
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const page = await mount();
  try {
    const autoConnect = () => page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!;
    await page.click(autoConnect());
    expect(page.barState()).toBe("Unsaved changes");
    holdNextGet = true;
    await act(async () => { page.button("Toggle Claude Code CLI first-party").click(); });
    await page.click(page.button("Save"));
    expect(server.systemEnv).toBe(true);
    expect(autoConnect().checked).toBe(true);
    releaseStale();
    await settle(page.testWindow);
    expect(autoConnect().checked).toBe(true);
    expect(page.barState()).toBe("No changes");
  } finally {
    releaseStale();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

afterEach(() => {
  clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch;
  restoreGlobals?.();
});

const SERVER = {
  enabled: true,
  cliFirstParty: false,
  cliFirstPartyApplied: false,
  desktopFirstParty: false,
  interceptRunning: true,
  interceptEligible: true,
  sharedProxy: "none",
  authMode: "proxy",
  autoConnectSupported: false,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: ["mock/model"],
  aliases: [],
  port: 10100,
};

const FROM_INPUT = 'input[aria-label="Original model (e.g. claude-sonnet-4-5)"]';

type Server = { modelMap: Record<string, string>; cliFirstParty: boolean; puts: unknown[]; holdPut?: Promise<void> };

function serve(server: Server) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { modelMap?: Record<string, string>; cliFirstParty?: boolean };
      server.puts.push(body);
      if (server.holdPut) await server.holdPut;
      if (body.modelMap) server.modelMap = body.modelMap;
      if (typeof body.cliFirstParty === "boolean") server.cliFirstParty = body.cliFirstParty;
      return Response.json({ ok: true });
    }
    return Response.json({ ...SERVER, cliFirstParty: server.cliFirstParty, modelMap: server.modelMap });
  }) as typeof fetch;
}

async function settle(testWindow: Window) {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0)); });
  }
}

async function mount() {
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(container);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><ClaudeCode apiBase="http://localhost" /></LanguageProvider>);
  });
  await settle(testWindow);
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!;
  const barState = () => container.querySelector(".ccw-savebar-state")?.textContent;
  const click = async (element: HTMLElement) => {
    await act(async () => { element.click(); });
    await settle(testWindow);
  };
  return { container, root, testWindow, button, barState, click };
}

test("an edit marks the page unsaved and Revert restores the server copy", async () => {
  serve({ modelMap: {}, cliFirstParty: false, puts: [] });
  const page = await mount();
  try {
    expect(page.barState()).toBe("No changes");
    expect(page.button("Revert").disabled).toBe(true);
    await page.click(page.button("Add rule"));
    expect(page.barState()).toBe("Unsaved changes");
    await page.click(page.button("Revert"));
    expect(page.barState()).toBe("No changes");
    expect(page.container.querySelectorAll(FROM_INPUT).length).toBe(0);
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("saving a blank row settles to clean once the server answers", async () => {
  const server: Server = { modelMap: {}, cliFirstParty: false, puts: [] };
  serve(server);
  const page = await mount();
  try {
    await page.click(page.button("Add rule"));
    expect(page.barState()).toBe("Unsaved changes");
    await page.click(page.button("Save"));
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]).not.toHaveProperty("enabled");
    expect(page.barState()).toBe("No changes");
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("an edit made while Save is in flight survives the acknowledging read", async () => {
  let release!: () => void;
  const server: Server = { modelMap: {}, cliFirstParty: false, puts: [], holdPut: new Promise<void>(resolve => { release = resolve; }) };
  serve(server);
  const page = await mount();
  try {
    await page.click(page.button("Add rule"));
    await act(async () => { page.button("Save").click(); });
    expect(page.button("Save").disabled).toBe(true);
    await page.click(page.button("Add rule"));
    release();
    await settle(page.testWindow);
    expect(page.container.querySelectorAll(FROM_INPUT).length).toBe(2);
    expect(page.barState()).toBe("Unsaved changes");
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("the 1P switch's re-read keeps an unsaved draft", async () => {
  const server: Server = { modelMap: {}, cliFirstParty: false, puts: [] };
  serve(server);
  const page = await mount();
  try {
    await page.click(page.button("Add rule"));
    const firstParty = page.button("Toggle Claude Code CLI first-party");
    await page.click(firstParty);
    expect(server.cliFirstParty).toBe(true);
    expect(page.container.querySelectorAll(FROM_INPUT).length).toBe(1);
    expect(page.barState()).toBe("Unsaved changes");
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("the connection switch is the last setting row, right above the Save bar", async () => {
  serve({ modelMap: {}, cliFirstParty: false, puts: [] });
  const page = await mount();
  try {
    const rows = page.container.querySelectorAll(".setting-row");
    const last = rows[rows.length - 1]!;
    expect(last.classList.contains("claudecode-connection-row")).toBe(true);
    expect(last.closest(".claudecode-master-card")?.nextElementSibling?.classList.contains("ccw-savebar")).toBe(true);
  } finally {
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});
