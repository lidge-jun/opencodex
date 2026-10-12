import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { LoginHint, type LoginHintData } from "../src/components/login-url-block";
import { addProviderModalReducer, createInitialAddProviderState } from "../src/components/add-provider-modal-reducer";
import { addCodexAccountUiReducer, initialAddCodexAccountUiState } from "../src/components/add-codex-account-reducer";
import { DEVICE_LOGIN_POLL_BUDGET_MS, loginPollAttempts } from "../src/oauth-login-budget";
import { parseBrowserLaunch } from "../src/oauth-browser-launch";

/**
 * How a login in progress tells the user what happened to the browser, and how a device login
 * gets them to the verification page. The standard shape (VS Code, GitHub CLI, Codex CLI): say
 * so when the browser did not open, keep the URL copyable either way, and let one click copy the
 * device code and open the page that asks for it.
 */

const URL_A = "https://auth.example.test/device";
const CODE = "WDJB-MJHT";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let clipboardWrites: string[] = [];
let opened: Array<{ url: string; target: string; features: string }> = [];

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  clipboardWrites = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  opened = [];
  Object.defineProperty(win, "open", {
    configurable: true,
    value: (url: string, target: string, features: string) => { opened.push({ url, target, features }); return null; },
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

async function render(hint: LoginHintData) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <LoginHint hint={hint} />
      </LanguageProvider>,
    );
  });
}

function openLink(): HTMLAnchorElement | null {
  return host.querySelector(".login-url-block-open") as HTMLAnchorElement | null;
}

test("says so when the proxy could not open a browser, and keeps the way in", async () => {
  await render({ url: URL_A, browserLaunch: "failed" });

  expect(host.querySelector(".login-hint-launch-failed")?.textContent).toContain("didn't open automatically");
  expect(openLink()?.getAttribute("href")).toBe(URL_A);
  expect(host.textContent).toContain(URL_A);
});

test("a started or unknown launch shows no failure notice and keeps the recovery wording", async () => {
  for (const browserLaunch of ["started", undefined] as const) {
    await render({ url: URL_A, browserLaunch });
    expect(host.querySelector(".login-hint-launch-failed")).toBeNull();
    expect(openLink()?.textContent).toContain("Didn't open?");
  }
});

test("a declined launch labels the link as the way in, not as a recovery", async () => {
  await render({ url: URL_A, browserLaunch: "skipped" });

  expect(host.querySelector(".login-hint-launch-failed")).toBeNull();
  expect(openLink()?.textContent).toContain("Open sign-in page");
});

test("one click copies the device code and opens the verification page", async () => {
  await render({ url: URL_A, deviceCode: CODE, browserLaunch: "skipped" });

  expect(openLink()?.textContent).toContain("Open sign-in page");
  const button = host.querySelector(".login-hint-copy-open") as HTMLButtonElement | null;
  expect(button?.textContent).toBe("Copy code & open");
  await act(async () => {
    button!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await new Promise((r) => setTimeout(r, 0));
  });

  expect(clipboardWrites).toEqual([CODE]);
  expect(opened).toEqual([{ url: URL_A, target: "_blank", features: "noopener,noreferrer" }]);
  // The code stays on screen: the clipboard is a shortcut, not the only copy.
  expect(host.textContent).toContain(CODE);
});

test("a device URL a browser cannot open never gets the open shortcut", async () => {
  await render({ url: "javascript:alert(1)", deviceCode: CODE });

  expect(host.querySelector(".login-hint-copy-open")).toBeNull();
  expect(openLink()).toBeNull();
  expect(host.textContent).toContain(CODE);
});

test("only the three known outcomes are read off a response", () => {
  expect(parseBrowserLaunch("failed")).toBe("failed");
  expect(parseBrowserLaunch("started")).toBe("started");
  expect(parseBrowserLaunch("skipped")).toBe("skipped");
  for (const value of [undefined, null, "", "FAILED", 1, {}]) expect(parseBrowserLaunch(value)).toBeUndefined();
});

test("the add-provider modal keeps the launch outcome across a status hint for the same login", () => {
  const preset = { id: "kimi", label: "Kimi", adapter: "openai-chat", baseUrl: "", auth: "oauth", oauthProvider: "kimi" };
  let state = { ...createInitialAddProviderState(false, "Custom"), preset } as ReturnType<typeof createInitialAddProviderState>;
  state = addProviderModalReducer(state, { type: "set-oauth-url", url: URL_A, providerId: "kimi", browserLaunch: "failed" });
  expect(state.oauthBrowserLaunch).toBe("failed");
  // The status poll re-sends the hint without the outcome.
  state = addProviderModalReducer(state, { type: "set-oauth-url", url: URL_A, providerId: "kimi" });
  expect(state.oauthBrowserLaunch).toBe("failed");
  // Clearing the URL ends the login, and its outcome with it.
  state = addProviderModalReducer(state, { type: "set-oauth-url", url: "", providerId: "kimi" });
  expect(state.oauthBrowserLaunch).toBeUndefined();
  // Leaving the preset clears it with the rest of the login state.
  state = addProviderModalReducer(state, { type: "set-oauth-url", url: URL_A, providerId: "kimi", browserLaunch: "failed" });
  state = addProviderModalReducer(state, { type: "back" });
  expect(state.oauthBrowserLaunch).toBeUndefined();
});

test("a device login polls for the grant's lifetime, a browser login keeps its own budget", () => {
  expect(loginPollAttempts(false, 2000, 150)).toBe(150);
  expect(loginPollAttempts(false, 2000, 100)).toBe(100);
  expect(loginPollAttempts(true, 2000, 150) * 2000).toBeGreaterThanOrEqual(DEVICE_LOGIN_POLL_BUDGET_MS);
  // Longer than the longest provider grant (Meta Muse, 30 minutes).
  expect(DEVICE_LOGIN_POLL_BUDGET_MS).toBeGreaterThan(30 * 60_000);
});

test("restarting a Codex login drops the previous login's launch warning", () => {
  let state = initialAddCodexAccountUiState();
  state = addCodexAccountUiReducer(state, { type: "set-login-hint", authUrl: URL_A, browserLaunch: "failed" });
  expect(state.browserLaunch).toBe("failed");
  // Switching to the device flow restarts the login before its own response arrives.
  state = addCodexAccountUiReducer(state, { type: "reset-oauth-start" });
  expect(state.browserLaunch).toBeUndefined();
});
