import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexAuth from "../src/pages/CodexAuth";

/**
 * Interaction-level recovery journey for Codex Auth.
 * Banner markup tests alone cannot prove absent→POST, disabled→PATCH,
 * error display, or post-success config refresh.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let requests: Array<{ method: string; path: string; body?: unknown }> = [];
let configProviders: Record<string, unknown> = {};

const CANONICAL_OPENAI = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "pool",
};

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  requests = [];
  configProviders = {};
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const entry: { method: string; path: string; body?: unknown } = {
        method,
        path: `${url.pathname}${url.search}`,
      };
      if (typeof init?.body === "string") entry.body = JSON.parse(init.body);
      requests.push(entry);

      if (url.pathname === "/api/config") {
        return Response.json({ providers: configProviders });
      }
      if (url.pathname === "/api/provider-presets") {
        return Response.json({
          providers: [{ id: "openai", codexAccountMode: "pool", provider: { ...CANONICAL_OPENAI } }],
        });
      }
      if (url.pathname === "/api/providers" && method === "POST") {
        configProviders = { openai: { ...CANONICAL_OPENAI } };
        return Response.json({ success: true, name: "openai" });
      }
      if (url.pathname === "/api/providers" && method === "PATCH") {
        const existing = configProviders.openai;
        if (existing && typeof existing === "object") {
          const next = { ...(existing as Record<string, unknown>) };
          delete next.disabled;
          configProviders = { openai: next };
        }
        return Response.json({ success: true, name: "openai", disabled: false });
      }
      if (url.pathname.startsWith("/api/codex-auth/accounts")) {
        return Response.json({
          accounts: [{ id: "main", email: "main@example.test", isMain: true, hasCredential: true, quota: null }],
        });
      }
      if (url.pathname.startsWith("/api/codex-auth/active")) {
        return Response.json({ activeCodexAccountId: null, autoSwitchThreshold: 80 });
      }
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountPage() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <CodexAuth apiBase="" />
      </LanguageProvider>,
    );
  });
  // CodexAuth loads mode via setTimeout(0); pool controller settles shortly after.
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function enableButton(): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((el) =>
    (el.textContent ?? "").includes("Enable OpenAI"),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

test("absent OpenAI: Enable posts the canonical preset and refreshes to Pool mode", async () => {
  configProviders = {};
  await mountPage();

  expect(host.textContent).toContain("Your OpenAI accounts are still available");
  expect(host.textContent).toContain("Enable OpenAI");

  await act(async () => {
    enableButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });

  expect(requests.some((r) => r.method === "GET" && r.path === "/api/provider-presets")).toBe(true);
  expect(requests.some((r) =>
    r.method === "POST"
    && r.path === "/api/providers"
    && (r.body as { name?: string })?.name === "openai",
  )).toBe(true);
  expect(host.textContent).toContain("Pool mode");
  expect(host.textContent).not.toContain("Enable OpenAI");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("disabled canonical OpenAI: Enable PATCHes disabled:false and refreshes", async () => {
  configProviders = {
    openai: { ...CANONICAL_OPENAI, disabled: true },
  };
  await mountPage();

  expect(host.textContent).toContain("Enable OpenAI");

  await act(async () => {
    enableButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });

  expect(requests.some((r) =>
    r.method === "PATCH"
    && r.path === "/api/providers?name=openai"
    && JSON.stringify(r.body) === JSON.stringify({ disabled: false }),
  )).toBe(true);
  expect(host.textContent).toContain("Pool mode");
  expect(host.textContent).not.toContain("Enable OpenAI");
});

test("absent OpenAI: preset load failure surfaces a localized error alert", async () => {
  configProviders = {};
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ method, path: `${url.pathname}${url.search}` });
      if (url.pathname === "/api/config") return Response.json({ providers: configProviders });
      if (url.pathname === "/api/provider-presets") return new Response("nope", { status: 500 });
      if (url.pathname.startsWith("/api/codex-auth/")) {
        return Response.json({ accounts: [], activeCodexAccountId: null, autoSwitchThreshold: 80 });
      }
      return Response.json({});
    },
  });

  await mountPage();
  await act(async () => {
    enableButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });

  const alert = host.querySelector('[role="alert"]');
  expect(alert).not.toBeNull();
  expect(alert!.textContent).toContain("Failed to load the OpenAI provider preset.");
  expect(host.textContent).toContain("Enable OpenAI");
  expect(requests.some((r) => r.method === "POST" && r.path === "/api/providers")).toBe(false);
});
