import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

/**
 * Rapid clicks on the Claude connection switch must serialize to a single
 * in-flight PUT (ClaudeCode.tsx `connectionInFlight` + disabled while pending).
 *
 * The control moved out of the sidebar when the three integration pages
 * collapsed into one Integrations route, but its semantics did not: it still
 * commits immediately rather than becoming another Save-gated draft, so the
 * serialization it depended on has to move with it.
 */

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let putBodies: unknown[] = [];
let claudeEnabled = false;
let releasePut: (() => void) | null = null;
let putGate: Promise<void> | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The fields ClaudeCode reads while rendering. A bare `{ enabled }` payload was
 * enough while the switch lived in the sidebar, but the control now sits on the
 * Claude Code surface itself, so the page has to render for the switch to
 * exist at all — and it throws on a response missing `aliases`/`available`.
 */
const CLAUDE_CODE_STATE = {
  authMode: "auto",
  autoConnectSupported: false,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: [],
  aliases: [],
  modelMap: {},
  port: 10100,
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previousGlobals;
  // The switch now lives on the Claude Code surface, so the route has to be
  // the one that mounts it.
  testWindow = new Window({ url: "http://localhost/#integrations/claude" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).__APP_VERSION__ = "0.0.0-test";

  putBodies = [];
  claudeEnabled = false;
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });

  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (url.includes("/api/claude-code") && method === "PUT") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { enabled?: boolean };
      putBodies.push(body);
      await putGate;
      // The server persists what it was sent, so the following GET reports it.
      // A fixed response would let the page re-read `enabled: false` after
      // enabling and send the same value twice — hiding a real toggle bug.
      if (typeof body.enabled === "boolean") claudeEnabled = body.enabled;
      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled });
    }
    if (url.includes("/api/claude-code")) {
      return jsonResponse({ ...CLAUDE_CODE_STATE, enabled: claudeEnabled });
    }
    if (url.includes("/healthz")) {
      return jsonResponse({ status: "ok", version: "0.0.0-test", uptime: 1 });
    }
    return jsonResponse({});
  }) as typeof fetch;

  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: mockFetch });

  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  releasePut?.();
  releasePut = null;
  putGate = null;
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 10));
    });
  }
}

function claudeSwitch(): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === "Toggle Claude connection",
  );
  if (!btn) throw new Error("Claude toggle switch not found");
  return btn as unknown as HTMLButtonElement;
}

test("rapid Claude toggle clicks issue only one PUT until the first settles", async () => {
  const { resetApiAuthFetchForTests, installApiAuthFetch } = await import("../src/api");
  resetApiAuthFetchForTests();
  installApiAuthFetch();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: window.fetch });

  const [{ createRoot }, { LanguageProvider }, { default: App }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/App"),
  ]);

  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <App />
      </LanguageProvider>,
    );
  });

  await waitFor(() => {
    try {
      return !!claudeSwitch();
    } catch {
      return false;
    }
  });

  const sw = claudeSwitch();
  expect(sw.disabled).toBe(false);
  expect(sw.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    sw.click();
    sw.click();
    sw.click();
  });

  expect(putBodies).toEqual([{ enabled: true }]);
  expect(claudeSwitch().disabled).toBe(true);

  await act(async () => {
    releasePut?.();
    releasePut = null;
    await Promise.resolve();
  });

  await waitFor(() => !claudeSwitch().disabled);

  // Re-arm a gated PUT and confirm a later click can fire again.
  putGate = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  await act(async () => {
    claudeSwitch().click();
  });
  expect(putBodies).toEqual([{ enabled: true }, { enabled: false }]);

  await act(async () => {
    releasePut?.();
    releasePut = null;
  });
  await waitFor(() => !claudeSwitch().disabled);
});
