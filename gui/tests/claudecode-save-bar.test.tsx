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

test("an edit back to the old value survives a read that lands before Save answers", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = { systemEnv: false, cliFirstParty: false };
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      Object.assign(server, body);
      // The server commits the Save at once, but its answer is late.
      if ("systemEnv" in body) await gate;
      return Response.json({ ok: true });
    }
    return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  const autoConnect = () => page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!;
  try {
    await page.click(autoConnect());
    await act(async () => { page.button("Save").click(); });
    await page.click(autoConnect());
    await page.click(page.button("Toggle Claude Code CLI first-party"));
    expect(autoConnect().checked).toBe(false);
    release();
    await settle(page.testWindow);
    expect(server.systemEnv).toBe(true);
    expect(autoConnect().checked).toBe(false);
    expect(page.barState()).toBe("Unsaved changes");
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a late Save from an unmounted page reaches the page on screen even when its refresh fails", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = { systemEnv: false };
  let offline = false;
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { systemEnv: boolean };
      await gate;
      server.systemEnv = body.systemEnv;
      offline = true;
      return Response.json({ ok: true });
    }
    if (offline) return Response.json({ error: "offline" }, { status: 503 });
    return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  const autoConnect = () => page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!;
  try {
    await page.click(autoConnect());
    await act(async () => { page.button("Save").click(); });
    await act(async () => { page.root.render(<LanguageProvider><ClaudeCode key="new" apiBase="http://localhost" /></LanguageProvider>); });
    await settle(page.testWindow);
    expect(autoConnect().checked).toBe(false);
    release();
    await settle(page.testWindow);
    expect(server.systemEnv).toBe(true);
    expect(autoConnect().checked).toBe(true);
    expect(page.barState()).toBe("No changes");
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a late connection acknowledgement from an unmounted page reaches the page on screen", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let enabled = true;
  let offline = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/native-integrations/claude")) {
      await gate;
      enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      offline = true;
      return Response.json({ desiredEnabled: enabled });
    }
    if (!url.endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (offline) return Response.json({ error: "offline" }, { status: 503 });
    return Response.json({ ...SERVER, enabled, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  try {
    await act(async () => { page.button("Toggle Claude connection").click(); });
    await act(async () => { page.root.render(<LanguageProvider><ClaudeCode key="new" apiBase="http://localhost" /></LanguageProvider>); });
    await settle(page.testWindow);
    release();
    await settle(page.testWindow);
    expect(enabled).toBe(false);
    expect(readSessionListCacheEntry<{ state: { enabled: boolean } }>("ocx.claude-code.v1:http://localhost")?.data?.state.enabled).toBe(false);
    expect(page.button("Toggle Claude connection").getAttribute("aria-pressed")).toBe("false");
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a late Save refresh from an unmounted page reaches the page on screen", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = { systemEnv: false };
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { systemEnv: boolean };
      await gate;
      server.systemEnv = body.systemEnv;
      return Response.json({ ok: true });
    }
    return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  const autoConnect = () => page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!;
  try {
    await page.click(autoConnect());
    await act(async () => { page.button("Save").click(); });
    await act(async () => { page.root.render(<LanguageProvider><ClaudeCode key="new" apiBase="http://localhost" /></LanguageProvider>); });
    await settle(page.testWindow);
    release();
    await settle(page.testWindow);
    expect(server.systemEnv).toBe(true);
    expect(readSessionListCacheEntry<{ state: { systemEnv: boolean } }>("ocx.claude-code.v1:http://localhost")?.data?.state.systemEnv).toBe(true);
    expect(autoConnect().checked).toBe(true);
    expect(page.barState()).toBe("No changes");
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a late Save from an unmounted page keeps a newer page's connection switch", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = { systemEnv: false, enabled: true };
  let offline = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/native-integrations/claude")) {
      server.enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      offline = true;
      return Response.json({ desiredEnabled: server.enabled });
    }
    if (!url.endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      await gate;
      Object.assign(server, JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (offline) return Response.json({ error: "offline" }, { status: 503 });
    return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
  }) as typeof fetch;
  const page = await mount();
  const cached = () => readSessionListCacheEntry<{ state: { systemEnv: boolean; enabled: boolean } }>("ocx.claude-code.v1:http://localhost")?.data?.state;
  try {
    await page.click(page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!);
    await act(async () => { page.button("Save").click(); });
    // The page is replaced while its Save is out, and the new page turns Claude off.
    await act(async () => { page.root.render(<LanguageProvider><ClaudeCode key="new" apiBase="http://localhost" /></LanguageProvider>); });
    await settle(page.testWindow);
    await page.click(page.button("Toggle Claude connection"));
    expect(server.enabled).toBe(false);
    release();
    await settle(page.testWindow);
    expect(server.systemEnv).toBe(true);
    expect(cached()?.systemEnv).toBe(true);
    expect(cached()?.enabled).toBe(false);
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

test("a 1P reread from an unmounted page cannot overwrite a newer page's Save", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = { systemEnv: false, cliFirstParty: false };
  let hold = false;
  let offline = false;
  globalThis.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/claude-code")) return new Response(null, { status: 404 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      Object.assign(server, body);
      if ("systemEnv" in body) offline = true;
      return Response.json({ ok: true });
    }
    if (offline) return Response.json({ error: "offline" }, { status: 503 });
    const snapshot = { ...SERVER, autoConnectSupported: true, ...server, modelMap: {} };
    if (hold) {
      hold = false;
      await gate;
    }
    return Response.json(snapshot);
  }) as typeof fetch;
  const page = await mount();
  const cachedSystemEnv = () => readSessionListCacheEntry<{ state: { systemEnv: boolean } }>("ocx.claude-code.v1:http://localhost")?.data?.state.systemEnv;
  try {
    hold = true;
    await act(async () => { page.button("Toggle Claude Code CLI first-party").click(); });
    await settle(page.testWindow);
    // A new page replaces the old one while its reread is still out.
    await act(async () => { page.root.render(<LanguageProvider><ClaudeCode key="new" apiBase="http://localhost" /></LanguageProvider>); });
    await settle(page.testWindow);
    await page.click(page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!);
    await page.click(page.button("Save"));
    expect(server.systemEnv).toBe(true);
    expect(cachedSystemEnv()).toBe(true);
    release();
    await settle(page.testWindow);
    expect(cachedSystemEnv()).toBe(true);
  } finally {
    release();
    await act(async () => page.root.unmount());
    page.testWindow.close();
  }
});

for (const control of ["first-party", "connection"] as const) {
  test(`a successful ${control} switch survives a failed reread, on screen and in the session copy`, async () => {
    const server = { cliFirstParty: false, enabled: true };
    let offline = false;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (init?.method === "PUT") {
        if (url.endsWith("/api/native-integrations/claude")) {
          server.enabled = (JSON.parse(String(init.body)) as { enabled: boolean }).enabled;
          offline = true;
          return Response.json({ desiredEnabled: server.enabled });
        }
        server.cliFirstParty = (JSON.parse(String(init.body)) as { cliFirstParty: boolean }).cliFirstParty;
        offline = true;
        return Response.json({ ok: true });
      }
      if (!url.endsWith("/api/claude-code")) return new Response(null, { status: 404 });
      if (offline) return Response.json({ error: "offline" }, { status: 503 });
      return Response.json({ ...SERVER, ...server, modelMap: {} });
    }) as typeof fetch;
    const page = await mount();
    try {
      const label = control === "first-party" ? "Toggle Claude Code CLI first-party" : "Toggle Claude connection";
      await page.click(page.button(label));
      const cached = readSessionListCacheEntry<{ state: typeof server }>("ocx.claude-code.v1:http://localhost");
      if (control === "first-party") {
        expect(server.cliFirstParty).toBe(true);
        expect(page.button(label).getAttribute("aria-pressed")).toBe("true");
        expect(cached?.data?.state.cliFirstParty).toBe(true);
      } else {
        expect(server.enabled).toBe(false);
        expect(page.button(label).getAttribute("aria-pressed")).toBe("false");
        expect(cached?.data?.state.enabled).toBe(false);
      }
    } finally {
      await act(async () => page.root.unmount());
      page.testWindow.close();
    }
  });
}

for (const control of ["first-party", "connection"] as const) {
  test(`a ${control} switch confirmed during Save survives in the session copy`, async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const server = { systemEnv: false, cliFirstParty: false, enabled: true };
    let offline = false;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/native-integrations/claude")) {
        server.enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
        return Response.json({ desiredEnabled: server.enabled });
      }
      if (!url.endsWith("/api/claude-code")) return new Response(null, { status: 404 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if ("cliFirstParty" in body) {
          server.cliFirstParty = body.cliFirstParty as boolean;
          return Response.json({ ok: true });
        }
        await saveGate;
        Object.assign(server, { systemEnv: body.systemEnv });
        offline = true;
        return Response.json({ ok: true });
      }
      if (offline) return Response.json({ error: "offline" }, { status: 503 });
      return Response.json({ ...SERVER, autoConnectSupported: true, ...server, modelMap: {} });
    }) as typeof fetch;
    const page = await mount();
    try {
      await page.click(page.container.querySelector<HTMLInputElement>('input[aria-label="Auto-connect"]')!);
      await act(async () => { page.button("Save").click(); });
      await page.click(page.button(control === "first-party" ? "Toggle Claude Code CLI first-party" : "Toggle Claude connection"));
      expect(control === "first-party" ? server.cliFirstParty : server.enabled).toBe(control === "first-party");
      releaseSave();
      await settle(page.testWindow);
      const cached = readSessionListCacheEntry<{ state: { systemEnv: boolean; cliFirstParty: boolean; enabled: boolean } }>("ocx.claude-code.v1:http://localhost");
      expect(cached?.data?.state.systemEnv).toBe(true);
      if (control === "first-party") expect(cached?.data?.state.cliFirstParty).toBe(true);
      else expect(cached?.data?.state.enabled).toBe(false);
    } finally {
      releaseSave();
      await act(async () => page.root.unmount());
      page.testWindow.close();
    }
  });
}

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
