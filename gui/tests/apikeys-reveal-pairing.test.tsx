/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { configureApiTargets, resetApiAuthFetchForTests } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import ApiKeys from "../src/pages/ApiKeys";

// /api/keys/reveal refuses sessions the loopback bootstrap issued for itself:
// reading a stored value takes an operator-paired session. The page answers
// that refusal with the pairing path — a bare load failure would leave the
// operator with no way to regain access.

const ORIGIN = "http://127.0.0.1:10100";
// The list only shows a revealed value that extends the row's current prefix,
// so the fixture must start with the same "ocx_data_aaaaaaaa" stem.
const FULL_KEY = "ocx_data_" + "a".repeat(40);

const originalFetch = globalThis.fetch;
let restoreGlobals: (() => void) | undefined;
let previousLanguageDescriptor: PropertyDescriptor | undefined;
let testWindow: Window;

const AUTH_MATRIX = [
  { endpoint: "/v1/responses", bearer: "rejected", dedicated: "required", xApiKey: "rejected" },
  { endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" },
];

const KEYS_OK = {
  keys: [
    { id: "key-1", name: "alpha", prefix: "ocx_data_aaaaaaaa...", createdAt: "2026-01-15T12:00:00.000Z",
      usage: { requests7d: 3, totalRequests: 8 } },
  ],
  attributionSince: "2026-07-20T00:00:00.000Z",
  authMatrix: AUTH_MATRIX,
  baseUrl: `${ORIGIN}/v1`,
  endpoint: `${ORIGIN}/v1/responses`,
  claudeCodeEnabled: true,
};

function sessionHtml(token: string): string {
  return `<meta name="opencodex-session-token" content="${token}">`
    + `<meta name="opencodex-session-csrf" content="${token}-csrf">`
    + `<meta name="opencodex-session-origin" content="${ORIGIN}">`
    + `<meta name="opencodex-session-server-origin" content="${ORIGIN}">`;
}

type RevealMode = "denied" | "failed" | "ok";

/** One stub for both `fetch` (the page's reads) and `window.fetch` (the pairing exchange). */
function installFetch(mode: { current: RevealMode }): void {
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.endsWith("/v1/models")) return Response.json({ data: [] });
    if (url.endsWith("/api/keys") && method === "GET") return Response.json(KEYS_OK);
    if (url.endsWith("/api/keys/reveal")) {
      if (mode.current === "denied") {
        return Response.json({ error: "operator-authorized dashboard session required" }, { status: 403 });
      }
      if (mode.current === "failed") return Response.json({ error: "internal" }, { status: 500 });
      return Response.json({ key: FULL_KEY });
    }
    if (url.endsWith("/opencodex-session") && method === "POST") {
      // The freshly paired session can disclose when the operator clicks the key again.
      mode.current = "ok";
      return new Response(sessionHtml("ocx_session_paired"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  globalThis.fetch = impl;
  Object.defineProperty(testWindow, "fetch", { configurable: true, value: impl });
}

beforeEach(() => {
  clearClientResourceStoresForTests();
  resetApiAuthFetchForTests();
  testWindow = new Window({ url: `${ORIGIN}/` });
  previousLanguageDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "language");
  Object.defineProperty(globalThis.navigator, "language", { configurable: true, value: "en-US" });
  const keys = ["document", "window", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(
    keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof keys)[number], PropertyDescriptor | undefined>;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
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
  resetApiAuthFetchForTests();
  restoreGlobals?.();
  testWindow.close();
});

async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms));
    await Promise.resolve();
  });
}

async function mountPage(): Promise<{ container: HTMLDivElement; root: Root }> {
  // The session store checks the shared target's origin, so the module state
  // must describe the same standalone server the page believes it is on.
  configureApiTargets(standaloneApiTargets(ORIGIN));
  const container = testWindow.document.createElement("div") as unknown as HTMLDivElement;
  testWindow.document.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <LanguageProvider>
        <ApiKeys apiBase={ORIGIN} />
      </LanguageProvider>,
    );
  });
  await tick();
  return { container, root };
}

const keyButton = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>(".awi-keylist-key")!;

function standaloneRuntimeTag(): void {
  const meta = testWindow.document.createElement("meta");
  meta.setAttribute("name", "opencodex-runtime-role");
  meta.setAttribute("content", "standalone");
  testWindow.document.head.append(meta);
}

async function typePairingCode(container: HTMLDivElement): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#connect-pairing-code")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      testWindow.HTMLInputElement.prototype, "value",
    )!.set!;
    setter.call(input, `ocx_pair_${"a".repeat(43)}`);
    input.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

const DENIED_TEXT = "Showing a stored key requires an operator-authorized session";

test("a refused reveal offers the local pairing form, then requires another click", async () => {
  standaloneRuntimeTag();
  const mode = { current: "denied" as RevealMode };
  installFetch(mode);
  const { container, root } = await mountPage();
  try {
    await act(async () => { keyButton(container).click(); });
    await tick();

    expect(container.textContent).toContain(DENIED_TEXT);
    expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
    const form = container.querySelector(".connect-pairing");
    expect(form).not.toBeNull();
    // A standalone install mints locally, so the form shows the local copy.
    expect(form!.querySelector("h2")?.textContent).toBe("One-time pairing code");

    await typePairingCode(container);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".connect-pairing button[type=submit]")!.click();
    });
    await tick();
    await tick();

    // Pairing changes authority, while disclosure still requires a fresh click.
    expect(container.querySelector(".connect-pairing")).toBeNull();
    expect(container.textContent).not.toContain(DENIED_TEXT);
    expect(keyButton(container).textContent).toBe("ocx_data_aaaaaaaa...");
    await act(async () => { keyButton(container).click(); });
    await tick();
    expect(keyButton(container).textContent).toBe(FULL_KEY);
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a refused reveal elsewhere explains the requirement without a pairing form", async () => {
  // No standalone-runtime tag: nothing this page renders can mint a session,
  // so the denial is answered with the explanation alone.
  const mode = { current: "denied" as RevealMode };
  installFetch(mode);
  const { container, root } = await mountPage();
  try {
    await act(async () => { keyButton(container).click(); });
    await tick();

    expect(container.textContent).toContain(DENIED_TEXT);
    expect(container.querySelector(".connect-pairing")).toBeNull();
  } finally {
    await act(async () => { root.unmount(); });
  }
});

test("a failed reveal reports the failure without offering pairing", async () => {
  const mode = { current: "failed" as RevealMode };
  installFetch(mode);
  const { container, root } = await mountPage();
  try {
    await act(async () => { keyButton(container).click(); });
    await tick();

    expect(container.querySelector(".awi-keylist-keycell [role=\"alert\"]")?.textContent)
      .toBe("Could not load the full key.");
    expect(container.querySelector(".connect-pairing")).toBeNull();
    expect(container.textContent).not.toContain(DENIED_TEXT);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
