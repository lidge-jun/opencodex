import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode, useReducer } from "react";
import type { Root } from "react-dom/client";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
} from "../src/components/add-codex-account-reducer";
import { useAddCodexAccountOAuth } from "../src/components/use-add-codex-account-oauth";
import { LanguageProvider } from "../src/i18n/provider";

/**
 * StrictMode reauth latch + login-status single-flight / abort contracts for
 * useAddCodexAccountOAuth (PR #475 blockers).
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

type FetchCall = {
  path: string;
  method: string;
  signal?: AbortSignal | null;
};

let calls: FetchCall[] = [];
let statusHolders: Array<{ resolve: (value: Response) => void }> = [];
let loginCount = 0;

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

  originalFetch = globalThis.fetch;
  calls = [];
  statusHolders = [];
  loginCount = 0;

  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      calls.push({ path: `${url.pathname}${url.search}`, method, signal: init?.signal ?? null });

      if (url.pathname === "/api/codex-auth/login" && method === "POST") {
        loginCount += 1;
        return Response.json({
          url: "https://auth.example/login",
          flowId: `flow-${loginCount}`,
        });
      }
      if (url.pathname === "/api/codex-auth/login/cancel") {
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/codex-auth/login-status") {
        return await new Promise<Response>((resolve) => {
          statusHolders.push({ resolve });
        });
      }
      return Response.json({});
    },
  });

  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  for (const holder of statusHolders.splice(0)) {
    holder.resolve(Response.json({ status: "pending" }));
  }
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

function Probe({ reauthAccountId }: { reauthAccountId: string }) {
  const [ui, dispatch] = useReducer(
    addCodexAccountUiReducer,
    reauthAccountId,
    initialAddCodexAccountUiState,
  );
  useAddCodexAccountOAuth({
    apiBase: "",
    reauthAccountId,
    ui,
    dispatch,
    t: ((key: string) => key) as never,
  });
  return <div data-testid="oauth-probe" data-step={ui.step} />;
}

async function mountProbe(strict: boolean) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    const tree = <LanguageProvider><Probe reauthAccountId="acct-1" /></LanguageProvider>;
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

test("StrictMode remount clears the reauth latch and starts OAuth again", async () => {
  await mountProbe(true);
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });

  const loginPosts = calls.filter((c) => c.path === "/api/codex-auth/login" && c.method === "POST");
  // Dev StrictMode: setup → cleanup (clears startedReauthRef) → setup again.
  expect(loginPosts.length).toBeGreaterThanOrEqual(2);
  expect(loginCount).toBeGreaterThanOrEqual(2);
});

test("slow login-status polls stay single-flight and abort on unmount", async () => {
  await mountProbe(false);
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });

  // Wait past two interval ticks while the first status response is still held.
  await act(async () => { await new Promise((r) => setTimeout(r, 4500)); });

  const statusCalls = calls.filter((c) => c.path.includes("/api/codex-auth/login-status"));
  expect(statusCalls.length).toBe(1);
  expect(statusHolders.length).toBe(1);

  const inFlightSignal = statusCalls[0]?.signal;
  expect(inFlightSignal).toBeTruthy();

  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }

  expect(inFlightSignal!.aborted).toBe(true);

  // A late tick must not open a second in-flight poll after cleanup.
  await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
  const statusAfter = calls.filter((c) => c.path.includes("/api/codex-auth/login-status"));
  expect(statusAfter.length).toBe(1);
}, { timeout: 20_000 });
