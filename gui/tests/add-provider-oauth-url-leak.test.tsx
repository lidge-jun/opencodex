import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import AddProviderModal from "../src/components/AddProviderModal";

/**
 * The add-provider OAuth pane renders the authorization URL so a user whose
 * browser never opened can still copy it. That URL arrives asynchronously,
 * so a preset switch mid-flight must never render provider A's URL under
 * provider B — showing the wrong provider's authorization link would be
 * worse than the missing-copy-button bug this surface was added to fix.
 */

const A_URL = "https://auth.alpha.test/oauth/authorize?client_id=alpha&state=aaa";
const B_URL = "https://auth.beta.test/oauth/authorize?client_id=beta&state=bbb";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;
let pendingLogins: Array<(url: string) => void> = [];

const PRESETS = [
  { id: "claude", label: "Claude", adapter: "anthropic", baseUrl: "https://api.anthropic.com", auth: "oauth", oauthProvider: "claude" },
  { id: "gemini", label: "Gemini", adapter: "gemini", baseUrl: "https://generativelanguage.googleapis.com", auth: "oauth", oauthProvider: "gemini" },
];

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

  pendingLogins = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/oauth/providers") return Response.json({ providers: ["claude", "gemini"] });
      if (url.pathname === "/api/provider-presets") return Response.json({ providers: PRESETS });
      if (url.pathname === "/api/usage") return Response.json({ providers: [] });
      if (url.pathname === "/api/oauth/login" && (init?.method ?? "GET") === "POST") {
        // Held open so the test controls when the URL lands.
        return await new Promise<Response>((resolve) => {
          pendingLogins.push((authUrl: string) => resolve(Response.json({ url: authUrl })));
        });
      }
      if (url.pathname === "/api/oauth/status") return Response.json({ loggedIn: false });
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
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

async function mountModal() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={() => {}} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function clickByText(fragment: string) {
  const el = Array.from(host.querySelectorAll("button, [role='button']")).find((node) =>
    (node.textContent ?? "").includes(fragment),
  );
  expect(el).toBeTruthy();
  (el as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
}

test("an authorization URL arriving after a preset switch is never rendered", async () => {
  await mountModal();

  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // Abandon Claude for Gemini while the login request is still in flight.
  clickByText("Back");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Gemini");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 40));
  });

  expect(host.textContent).not.toContain(A_URL);
  expect(host.querySelector(".login-url-block-text")).toBeNull();
});

test("the in-flight provider's own authorization URL does render", async () => {
  await mountModal();

  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 40));
  });

  expect(host.querySelector(".login-url-block-text")?.textContent).toBe(A_URL);
});

test("a late URL for an abandoned provider cannot overwrite the one already shown", async () => {
  await mountModal();

  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // Switch to Gemini and start its login while Claude's request is still open.
  clickByText("Back");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Gemini");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Gemini");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });

  // Gemini answers first, then Claude's stale response lands.
  await act(async () => {
    pendingLogins[1]?.(B_URL);
    await new Promise((r) => setTimeout(r, 30));
  });
  await act(async () => {
    pendingLogins[0]?.(A_URL);
    await new Promise((r) => setTimeout(r, 30));
  });

  expect(host.querySelector(".login-url-block-text")?.textContent).toBe(B_URL);
  expect(host.textContent).not.toContain(A_URL);
});
