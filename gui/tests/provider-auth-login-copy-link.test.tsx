import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { LoginHint, ProviderAuthHandlers } from "../src/components/provider-workspace/types";

/**
 * Regression guard for the workspace OAuth login wait panel.
 * The copy-link affordance lived only in the Classic providers view, whose
 * render site was torn down in fa1af1b2; the workspace panel introduced in
 * df010cf3 never ported it, leaving users with no way to obtain the
 * authorization URL when the browser failed to open.
 */

const AUTH_URL = "https://auth.example.test/oauth/authorize?client_id=abc&state=xyz";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let clipboardWrites: string[] = [];

const ITEM: WorkspaceItem = {
  name: "claude",
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "oauth",
};

const HANDLERS: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
};

function installClipboard(available: boolean) {
  clipboardWrites = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: available
      ? { writeText: async (text: string) => { clipboardWrites.push(text); } }
      : undefined,
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  installClipboard(true);
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
  await win.happyDOM?.close?.();
});

async function mountPanel(hint: LoginHint) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase=""
          busy
          loginHint={hint}
          authHandlers={HANDLERS}
        />
      </LanguageProvider>,
    );
  });
}

/** Located structurally: its label changes to "Copied" after the first click. */
function copyLinkButton(): HTMLButtonElement {
  const button = host.querySelector(".login-url-block-actions button");
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

test("login wait panel exposes the authorization URL and copies it", async () => {
  await mountPanel({ provider: "claude", url: AUTH_URL });

  expect(host.textContent).toContain(AUTH_URL);

  await act(async () => {
    copyLinkButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(clipboardWrites).toEqual([AUTH_URL]);
  expect(host.textContent).toContain("Copied");
});

test("clipboard-less context reports unavailability instead of a false success", async () => {
  installClipboard(false);
  await mountPanel({ provider: "claude", url: AUTH_URL });

  await act(async () => {
    copyLinkButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(host.textContent).toContain("Clipboard unavailable");
});

test("repeated copies keep the latest feedback for its full window", async () => {
  await mountPanel({ provider: "claude", url: AUTH_URL });

  await act(async () => {
    copyLinkButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  // Second click lands inside the first click's 2.5s feedback window.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 200));
    copyLinkButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  expect(clipboardWrites).toEqual([AUTH_URL, AUTH_URL]);

  // Past the FIRST click's expiry but before the second's: an unguarded
  // timer would have already wiped the second click's feedback here.
  await act(async () => { await new Promise((r) => setTimeout(r, 2400)); });
  expect(host.textContent).toContain("Copied");
});

test("the open-in-browser fallback link survives alongside the copy button", async () => {
  await mountPanel({ provider: "claude", url: AUTH_URL });

  const anchor = Array.from(host.querySelectorAll("a")).find(
    (el) => el.getAttribute("href") === AUTH_URL,
  );
  expect(anchor).toBeTruthy();
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(host.textContent).toContain("Didn't open?");
});

test("a hint for a different provider renders no copy affordance", async () => {
  await mountPanel({ provider: "gemini", url: AUTH_URL });

  expect(host.textContent).not.toContain("Copy link");
  expect(host.textContent).not.toContain(AUTH_URL);
});

test("no login hint URL renders no copy affordance", async () => {
  await mountPanel({ provider: "claude" });

  expect(host.textContent).not.toContain("Copy link");
});
