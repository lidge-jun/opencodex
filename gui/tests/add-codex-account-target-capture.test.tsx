import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useLayoutEffect, useReducer } from "react";
import type { Dispatch } from "react";
import type { Root } from "react-dom/client";
import { configureApiTargets } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
import {
  addCodexAccountUiReducer,
  initialAddCodexAccountUiState,
  type AddCodexAccountUiAction,
  type AddCodexAccountUiState,
} from "../src/components/add-codex-account-reducer";
import { useAddCodexAccountOAuth } from "../src/components/use-add-codex-account-oauth";
import type { CodexAccountMutationCompletion } from "../src/codex-account-mutation";

/**
 * The Codex add-account OAuth flow belongs to the logical target it started on.
 * A relay keeps the same apiBase across a re-pair, so only the capture can tell A
 * from B: start, status, manual code and cancel must all use the flow's original
 * capture, and a completion may apply only while that capture is still current.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

type Call = { path: string; method: string; target: string | null; body: string | null };
let calls: Call[];
let loginCount: number;
let statusBody: unknown;
let holdStatus: boolean;
let statusHolders: Array<(response: Response) => void>;

let hook: ReturnType<typeof useAddCodexAccountOAuth>;
let uiState: AddCodexAccountUiState;
let dispatchUi: Dispatch<AddCodexAccountUiAction>;
let completions: CodexAccountMutationCompletion[];
let closes: number;

function relay(apiBase: string, origin: string) {
  const base = standaloneApiTargets(apiBase);
  return {
    ...base,
    connected: true,
    shared: { ...base.shared, baseUrl: apiBase, serverOrigin: origin, transport: "relay" as const },
    apiKeyId: "fixture-key",
    relayTargetCheck: "expected-target-v1" as const,
  };
}

function Probe({ apiBase, targetKey, reauthAccountId }: { apiBase: string; targetKey?: string; reauthAccountId?: string }) {
  const [ui, dispatch] = useReducer(addCodexAccountUiReducer, reauthAccountId, initialAddCodexAccountUiState);
  const oauth = useAddCodexAccountOAuth({
    apiBase,
    targetKey,
    reauthAccountId,
    ui,
    dispatch,
    t: ((key: string) => key) as never,
  });
  const { bindCallbacks } = oauth;
  useEffect(() => {
    bindCallbacks(completion => { completions.push(completion); }, () => { closes += 1; });
  }, [bindCallbacks]);
  useLayoutEffect(() => {
    hook = oauth;
    uiState = ui;
    dispatchUi = dispatch;
  }, [oauth, ui, dispatch]);
  return null;
}

async function render(apiBase: string, targetKey: string, reauthAccountId?: string): Promise<void> {
  const { createRoot } = await import("react-dom/client");
  if (!root) root = createRoot(host);
  await act(async () => {
    root!.render(<Probe apiBase={apiBase} targetKey={targetKey} reauthAccountId={reauthAccountId} />);
  });
}

async function start(): Promise<void> {
  await act(async () => { await hook.startOAuth(); });
}

/** Fire the visibility make-up tick the way a returning tab does. */
async function tick(): Promise<void> {
  await act(async () => {
    win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false }));
    win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: true }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, writable: true, value: true },
  });
  calls = [];
  loginCount = 0;
  statusBody = { status: "pending" };
  holdStatus = false;
  statusHolders = [];
  completions = [];
  closes = 0;
  originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers ?? undefined);
      calls.push({
        path: url.pathname,
        method,
        target: headers.get("x-opencodex-expected-target"),
        body: init?.body ? String(init.body) : null,
      });
      if (url.pathname.endsWith("/api/codex-auth/login") && method === "POST") {
        loginCount += 1;
        return Response.json({ url: "https://auth.example/login", flowId: `flow-${loginCount}` });
      }
      if (url.pathname.endsWith("/api/codex-auth/login/cancel")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/api/codex-auth/login/code")) return Response.json({ ok: true });
      if (url.pathname.endsWith("/api/codex-auth/login-status")) {
        if (!holdStatus) return Response.json(statusBody);
        return await new Promise<Response>(resolve => statusHolders.push(resolve));
      }
      return Response.json({});
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  for (const holder of statusHolders.splice(0)) holder(Response.json({ status: "pending" }));
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  // Leave the shared api module on the default standalone target for the next file.
  configureApiTargets(standaloneApiTargets(""));
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

test("a render gap refuses the login POST before fetch", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  configureApiTargets(relay("/same", "hub-b"));
  await start();
  expect(calls).toEqual([]);
});

test("A's flow keeps its capture: manual code, polling and cancel never reach B", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  await start();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.target).toBe("hub-a");
  expect(uiState.flowId).toBe("flow-1");

  calls = [];
  configureApiTargets(relay("/same", "hub-b"));
  await render("/same", "hub-b");

  await act(async () => { dispatchUi({ type: "set-manual-code", manualCode: "ABCD-1234" }); });
  await act(async () => { await hook.submitManualCode(); });
  expect(calls).toEqual([]);
  expect(uiState.error).toBe("prov.targetChanged");

  await tick();
  expect(calls).toEqual([]);

  await act(async () => { hook.closeModal(); });
  expect(calls).toEqual([]);
  expect(closes).toBe(1);
});

test("B can start its own flow after the switch", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  await start();

  configureApiTargets(relay("/same", "hub-b"));
  await render("/same", "hub-b");
  calls = [];
  await start();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.target).toBe("hub-b");
  expect(uiState.flowId).toBe("flow-2");
});

test("ABA does not revive the abandoned A flow", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  await start();
  configureApiTargets(relay("/same", "hub-b"));
  await render("/same", "hub-b");
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");

  calls = [];
  await act(async () => { dispatchUi({ type: "set-manual-code", manualCode: "CODE" }); });
  await act(async () => { await hook.submitManualCode(); });
  await act(async () => { hook.closeModal(); });
  expect(calls).toEqual([]);

  await start();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.target).toBe("hub-a");
});

test("a completion in flight during a target change is dropped", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  holdStatus = true;
  await start();
  await tick();
  expect(statusHolders).toHaveLength(1);

  configureApiTargets(relay("/same", "hub-b"));
  await render("/same", "hub-b");
  await act(async () => {
    statusHolders.shift()!(Response.json({ status: "done" }));
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  expect(completions).toEqual([]);
  expect(closes).toBe(0);
});

test("a completion on the flow's own target is applied once", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a");
  await start();
  statusBody = { status: "done", catalogRefreshPending: true };
  await tick();
  expect(completions).toEqual([{ catalogRefreshPending: true }]);
  expect(closes).toBe(1);
});

test("a reauth latch does not restart the login on a new target", async () => {
  configureApiTargets(relay("/same", "hub-a"));
  await render("/same", "hub-a", "acct-1");
  expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/api/codex-auth/login"))).toHaveLength(1);
  expect(calls[0]!.target).toBe("hub-a");

  calls = [];
  configureApiTargets(relay("/same", "hub-b"));
  await render("/same", "hub-b", "acct-1");
  expect(calls).toEqual([]);
});
