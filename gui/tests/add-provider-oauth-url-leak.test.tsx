import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { useT } from "../src/i18n/shared";
import AddProviderModal from "../src/components/AddProviderModal";
import { OAUTH_LOGIN_POLL_INTERVAL_MS } from "../src/components/use-add-provider-oauth";
import { useProvidersOAuth } from "../src/pages/use-providers-oauth";
import type { OAuthAccount, OAuthStatus } from "../src/pages/providers-shared";

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
let oauthStatus: { loggedIn: boolean; error?: string } = { loggedIn: false };
let cancelledProviders: string[] = [];

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
  oauthStatus = { loggedIn: false };
  cancelledProviders = [];
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
      if (url.pathname === "/api/oauth/login/cancel" && (init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { provider?: string };
        if (body.provider) cancelledProviders.push(body.provider);
        return Response.json({ ok: true, cancelled: true });
      }
      if (url.pathname === "/api/oauth/status") return Response.json(oauthStatus);
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

async function mountModal(onAdded: (name: string) => void = () => {}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AddProviderModal apiBase="" existingNames={[]} initialTier="paid" onClose={() => {}} onAdded={onAdded} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

function ProvidersOAuthHarness({ provider = "orcarouter-oauth", apiBase = "", onSettled }: {
  provider?: string;
  apiBase?: string;
  onSettled?: (provider: string) => void;
}) {
  const t = useT();
  const aliveRef = useRef(true);
  const startedRef = useRef(false);
  const [accountSets, setAccountSets] = useState<Record<string, { activeAccountId: string | null; accounts: OAuthAccount[] }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loginInfo, setLoginInfo] = useState<{ provider: string; url?: string; instructions?: string; deviceCode?: string } | null>(null);
  const [, setOauthStatus] = useState<Record<string, OAuthStatus>>({});

  useEffect(() => () => { aliveRef.current = false; }, []);
  const { loginOAuth, cancelLoginOAuth } = useProvidersOAuth({
    apiBase,
    t,
    aliveRef,
    accountSets,
    setAccountSets,
    setBusy,
    setStatus,
    setLoginInfo,
    setOauthStatus,
    notify: (message) => setStatus(message),
    onLoginSettled: onSettled,
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchAccountSets: async () => undefined,
    fetchProviderQuotas: async () => {},
    bumpModelsRefresh: () => {},
  });

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void loginOAuth(provider);
  }, [loginOAuth, provider]);
  return (
    <>
      <span data-testid="oauth-status">{status}</span>
      <button onClick={() => { void cancelLoginOAuth(provider); }}>Cancel login</button>
      <span data-testid="oauth-busy">{busy ?? "idle"}</span>
      <span data-testid="oauth-login-info">{loginInfo?.url ?? "no-login-info"}</span>
      <button
        type="button"
        disabled={busy === provider}
        onClick={() => { void loginOAuth(provider); }}
      >
        Log in again
      </button>
    </>
  );
}

async function mountProvidersOAuthHarness(props: Parameters<typeof ProvidersOAuthHarness>[0] = {}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProvidersOAuthHarness {...props} />
      </LanguageProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
  });
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

test("unmounting the add-provider modal cancels its in-flight OAuth login", async () => {
  await mountModal();

  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 20));
  });

  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  await new Promise((r) => setTimeout(r, 20));

  expect(cancelledProviders).toEqual(["claude"]);
});

test("leaving the providers page cancels its in-flight account login", async () => {
  await mountProvidersOAuthHarness();
  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 20));
  });

  const current = root!;
  await act(async () => { current.unmount(); });
  root = null;
  await new Promise((r) => setTimeout(r, 20));

  expect(cancelledProviders).toEqual(["orcarouter-oauth"]);
});

test("pagehide cancels an account login and allows another login after bfcache restore", async () => {
  await mountProvidersOAuthHarness();
  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(host.querySelector('[data-testid="oauth-busy"]')?.textContent).toBe("orcarouter-oauth");
  expect(host.querySelector('[data-testid="oauth-login-info"]')?.textContent).toBe(A_URL);
  await act(async () => {
    win.dispatchEvent(new win.Event("pagehide"));
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(cancelledProviders).toEqual(["orcarouter-oauth"]);
  expect(host.querySelector('[data-testid="oauth-busy"]')?.textContent).toBe("idle");
  expect(host.querySelector('[data-testid="oauth-login-info"]')?.textContent).toBe("no-login-info");
  const loginAgain = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Log in again"));
  expect(loginAgain?.disabled).toBe(false);
  await act(async () => {
    loginAgain?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(pendingLogins).toHaveLength(1);
});

test("pagehide clears the add-provider OAuth hint and allows another login", async () => {
  await mountModal();
  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(host.querySelector(".login-url-block-text")?.textContent).toBe(A_URL);
  await act(async () => {
    win.dispatchEvent(new win.Event("pagehide"));
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(cancelledProviders).toEqual(["claude"]);
  expect(host.querySelector(".login-url-block-text")).toBeNull();
  const loginAgain = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Log in with Claude"));
  expect(loginAgain?.disabled).toBe(false);
  await act(async () => {
    loginAgain?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  expect(pendingLogins).toHaveLength(1);
});

test("the add-provider OAuth pane can cancel an in-flight login", async () => {
  await mountModal();

  clickByText("Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  clickByText("Log in with Claude");
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  await act(async () => {
    pendingLogins.shift()?.(A_URL);
    await new Promise((r) => setTimeout(r, 20));
  });

  await act(async () => {
    clickByText("Cancel");
    await new Promise((r) => setTimeout(r, 20));
  });

  expect(cancelledProviders).toEqual(["claude"]);
  expect(host.textContent).toContain("Claude login cancelled");
});

test("timing out an add-provider OAuth login releases the server login", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === OAUTH_LOGIN_POLL_INTERVAL_MS) {
      queueMicrotask(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);

  try {
    await mountModal();
    clickByText("Claude");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    clickByText("Log in with Claude");
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await act(async () => {
      pendingLogins.shift()?.(A_URL);
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(cancelledProviders).toEqual(["claude"]);
    expect(host.textContent).toContain("timed out");
  } finally {
    timeoutSpy.mockRestore();
  }
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

test("a login error wins over a retained OAuth credential", async () => {
  const added: string[] = [];
  oauthStatus = {
    loggedIn: true,
    error: "The credential was saved, but the provider entry was not written.",
  };
  const realSetTimeout = globalThis.setTimeout;
  const timeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === OAUTH_LOGIN_POLL_INTERVAL_MS) {
      queueMicrotask(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);

  try {
    await mountModal(name => added.push(name));
    await act(async () => {
      clickByText("Claude");
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      clickByText("Log in with Claude");
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(pendingLogins).toHaveLength(1);
    await act(async () => {
      pendingLogins.shift()!(A_URL);
      await new Promise((r) => setTimeout(r, 40));
    });

    expect(added).toEqual([]);
    expect(host.textContent).toContain("provider entry was not written");
  } finally {
    timeoutSpy.mockRestore();
  }
});

for (const surface of ['providers', 'modal'] as const) {
 test(`AUDIT ${surface} waits for pending cancellation before replacement login`, async () => {
  const inheritedFetch=globalThis.fetch;
  const cancelGate=Promise.withResolvers<Response>();
  let loginRequests=0, cancelRequests=0;
  globalThis.fetch=(async(input,init)=>{
   const path=new URL(String(input),'http://localhost').pathname;
   if(path==='/api/oauth/login/cancel'){cancelRequests++;return cancelGate.promise;}
   if(path==='/api/oauth/login')loginRequests++;
   return inheritedFetch(input,init);
  }) as typeof fetch;
  try {
   if(surface==='providers')await mountProvidersOAuthHarness();
   else {await mountModal();await act(async()=>{clickByText('Claude');});await act(async()=>{clickByText('Log in with Claude');});}
   expect(loginRequests).toBe(1);
   await act(async()=>{win.dispatchEvent(new win.Event('pagehide'));});
   expect(cancelRequests).toBe(1);
   await act(async()=>{clickByText(surface==='providers'?'Log in again':'Log in with Claude');});
   console.log(JSON.stringify({surface,loginRequests,cancelRequests,cancellation:'STILL PENDING'}));
   expect(loginRequests).toBe(1);
  } finally { await act(async()=>{cancelGate.resolve(Response.json({ok:true,cancelled:true}));}); }
 });
}

type RaceSurface = "providers" | "modal";

async function mountRaceSurface(surface: RaceSurface, settled: string[] = []) {
  if (surface === "providers") {
    await mountProvidersOAuthHarness({ provider: "claude", onSettled: name => settled.push(name) });
  } else {
    await mountModal(name => settled.push(name));
    await act(async () => { clickByText("Claude"); });
    await retryRaceLogin(surface);
  }
}

async function retryRaceLogin(surface: RaceSurface) {
  await act(async () => { clickByText(surface === "providers" ? "Log in again" : "Log in with Claude"); });
}

async function unmountRaceSurface() {
  const current = root;
  root = null;
  await act(async () => { current?.unmount(); });
}

// Provider-only cancellation affects the flow current at DELIVERY, not dispatch.
// Keep both network delivery and polling under explicit test control.
function raceServer() {
  const inheritedFetch = globalThis.fetch;
  const logins: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
  const cancels: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
  const active = new Map<string, number>();
  const loginKeys: string[] = [];
  const ticks: Array<() => void> = [];
  let complete = false;
  let statusOverride: Promise<Response> | undefined;
  const realSetTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]
  ) => {
    if (delay === OAUTH_LOGIN_POLL_INTERVAL_MS) {
      ticks.push(() => callback(...args));
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    const provider = init?.body
      ? (JSON.parse(String(init.body)) as { provider: string }).provider
      : url.searchParams.get("provider");
    const base = url.pathname.split("/api/oauth/")[0];
    const key = `${base}:${provider}`;
    if (url.pathname.endsWith("/api/oauth/login")) {
      const gate = Promise.withResolvers<Response>();
      logins.push(gate);
      loginKeys.push(key);
      active.set(key, logins.length);
      return gate.promise;
    }
    if (url.pathname.endsWith("/api/oauth/login/cancel")) {
      const gate = Promise.withResolvers<Response>();
      cancels.push(gate);
      const response = await gate.promise;
      if (response.ok) active.delete(key);
      return response;
    }
    if (url.pathname.endsWith("/api/oauth/status")) {
      if (statusOverride) return statusOverride;
      return Response.json(active.has(key)
        ? { loggedIn: complete, done: complete }
        : { loggedIn: false, error: "Login cancelled" });
    }
    return inheritedFetch(input, init);
  }) as typeof fetch;
  return {
    logins, cancels, active, loginKeys,
    holdStatus(response: Promise<Response> | undefined) { statusOverride = response; },
    async tick() {
      await act(async () => { ticks.splice(0).forEach(tick => tick()); });
    },
    async answerLogin(index: number, url = A_URL) {
      await act(async () => { logins[index]!.resolve(Response.json({ url })); });
    },
    async deliverCancel(index = 0) {
      await act(async () => { cancels[index]!.resolve(Response.json({ ok: true, cancelled: true })); });
    },
    async finish() {
      complete = true;
      await act(async () => { ticks.splice(0).forEach(tick => tick()); });
    },
    async dispose() {
      await unmountRaceSurface();
      await act(async () => {
        cancels.forEach(gate => gate.resolve(Response.json({ ok: true })));
        logins.forEach(gate => gate.resolve(Response.json({ url: A_URL })));
        ticks.splice(0).forEach(tick => tick());
      });
      timer.mockRestore();
      globalThis.fetch = inheritedFetch;
    },
  };
}

for (const surface of ["providers", "modal"] as const) {
  for (const trigger of ["pagehide", "remount", "explicit"] as const) {
    test(`F2 ${surface}: ${trigger} waits for cancel delivery and replacement completes`, async () => {
      const server = raceServer();
      const settled: string[] = [];
      try {
        await mountRaceSurface(surface, settled);
        await server.answerLogin(0);
        if (trigger === "remount") {
          await unmountRaceSurface();
          await mountRaceSurface(surface, settled);
        } else {
          await act(async () => {
            if (trigger === "pagehide") win.dispatchEvent(new win.Event("pagehide"));
            else clickByText("Cancel");
          });
          if (trigger === "explicit") {
            // The busy UI disables retry until cancel settles; reopening can
            // still request a new flow before that delivery finishes.
            await unmountRaceSurface();
            await mountRaceSurface(surface, settled);
          } else await retryRaceLogin(surface);
        }
        expect(server.cancels).toHaveLength(1);
        expect(server.logins).toHaveLength(1);
        await server.deliverCancel();
        expect(server.logins).toHaveLength(2);
        expect(server.active.get(":claude")).toBe(2);
        await server.answerLogin(1, B_URL);
        expect(host.textContent).toContain(B_URL);
        await server.finish();
        expect(settled).toEqual(["claude"]);
        await unmountRaceSurface();
        expect(server.cancels).toHaveLength(1);
      } finally { await server.dispose(); }
    });
  }

  test(`F2 ${surface}: abandoning a replacement waiting on cancellation never starts it`, async () => {
    const server = raceServer();
    try {
      await mountRaceSurface(surface);
      await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
      await retryRaceLogin(surface);
      await unmountRaceSurface();
      await server.deliverCancel();
      expect(server.logins).toHaveLength(1);
      expect(server.cancels).toHaveLength(1);
    } finally { await server.dispose(); }
  });

  test(`F2 ${surface}: stale login rejection cannot erase replacement cleanup`, async () => {
    const server = raceServer();
    try {
      await mountRaceSurface(surface);
      await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
      await retryRaceLogin(surface);
      await server.deliverCancel();
      await server.answerLogin(1, B_URL);
      await act(async () => { server.logins[0]!.reject(new Error("old request failed")); });
      expect(host.textContent).toContain(B_URL);
      expect(host.textContent).not.toContain("old request failed");
      await unmountRaceSurface();
      expect(server.cancels).toHaveLength(2);
    } finally { await server.dispose(); }
  });

  for (const failure of ["rejection", "http"] as const) {
    test(`F2 ${surface}: cancel ${failure} settles best-effort cleanup without wedging retry`, async () => {
      const server = raceServer();
      try {
        await mountRaceSurface(surface);
        await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
        await retryRaceLogin(surface);
        expect(server.logins).toHaveLength(1);
        await act(async () => {
          if (failure === "rejection") server.cancels[0]!.reject(new Error("offline"));
          else server.cancels[0]!.resolve(Response.json({ error: "unavailable" }, { status: 503 }));
        });
        expect(server.logins).toHaveLength(2);
        await server.answerLogin(1, B_URL);
        expect(host.textContent).toContain(B_URL);
        await unmountRaceSurface();
        expect(server.cancels).toHaveLength(2);
      } finally { await server.dispose(); }
    });
  }
}

for (const first of ["providers", "modal"] as const) {
  test(`F2 shared barrier survives ${first} unmount and the other hook mounting`, async () => {
    const server = raceServer();
    try {
      await mountRaceSurface(first);
      await unmountRaceSurface();
      await mountRaceSurface(first === "providers" ? "modal" : "providers");
      expect(server.logins).toHaveLength(1);
      await server.deliverCancel();
      expect(server.logins).toHaveLength(2);
      expect(server.active.get(":claude")).toBe(2);
    } finally { await server.dispose(); }
  });
}

for (const other of [{ provider: "gemini" }, { provider: "claude", apiBase: "/other" }]) {
  test(`F2 pending cancel does not block distinct key ${JSON.stringify(other)}`, async () => {
    const server = raceServer();
    try {
      await mountRaceSurface("providers");
      await unmountRaceSurface();
      await mountProvidersOAuthHarness(other);
      expect(server.cancels).toHaveLength(1);
      expect(server.logins).toHaveLength(2);
      await server.deliverCancel();
      expect(server.active.get(server.loginKeys[1]!)).toBe(2);
    } finally { await server.dispose(); }
  });
}

for (const surface of ["providers", "modal"] as const) {
  for (const reason of ["request-error", "timeout"] as const) {
    test(`F2 ${surface}: ${reason} cleanup cannot clear the replacement after cancellation`, async () => {
      const server = raceServer();
      const settled: string[] = [];
      try {
        await mountRaceSurface(surface, settled);
        if (reason === "request-error") {
          await act(async () => { server.logins[0]!.reject(new Error("request failed")); });
        } else {
          await server.answerLogin(0);
          for (let i = 0; i < (surface === "modal" ? 100 : 150); i++) await server.tick();
        }
        expect(server.cancels).toHaveLength(1);
        await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
        await retryRaceLogin(surface);
        expect(server.logins).toHaveLength(1);
        await server.deliverCancel();
        expect(server.logins).toHaveLength(2);
        await server.answerLogin(1, B_URL);
        expect(host.textContent).toContain(B_URL);
        expect(host.textContent).not.toContain("timed out");
        expect(host.querySelector('[data-testid="oauth-status"]')?.textContent ?? "").toBe("");
        await server.finish();
        expect(settled).toEqual(["claude"]);
      } finally { await server.dispose(); }
    });
  }

  test(`F2 ${surface}: stale response body cannot overwrite replacement URL`, async () => {
    const server = raceServer();
    const body = Promise.withResolvers<{ url: string }>();
    try {
      await mountRaceSurface(surface);
      const response = Response.json({});
      Object.defineProperty(response, "json", { value: () => body.promise });
      await act(async () => { server.logins[0]!.resolve(response); });
      await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
      await retryRaceLogin(surface);
      await server.deliverCancel();
      await server.answerLogin(1, B_URL);
      await act(async () => { body.resolve({ url: A_URL }); });
      expect(host.textContent).toContain(B_URL);
      expect(host.textContent).not.toContain(A_URL);
    } finally {
      body.resolve({ url: A_URL });
      await server.dispose();
    }
  });

  test(`F2 ${surface}: stale status cannot complete the replacement prematurely`, async () => {
    const server = raceServer();
    const status = Promise.withResolvers<Response>();
    const settled: string[] = [];
    try {
      await mountRaceSurface(surface, settled);
      await server.answerLogin(0);
      server.holdStatus(status.promise);
      await server.tick();
      await act(async () => { win.dispatchEvent(new win.Event("pagehide")); });
      await retryRaceLogin(surface);
      await server.deliverCancel();
      await server.answerLogin(1, B_URL);
      server.holdStatus(undefined);
      await act(async () => { status.resolve(Response.json({ loggedIn: true, done: true })); });
      expect(settled).toEqual([]);
      expect(host.textContent).toContain(B_URL);
      await server.finish();
      expect(settled).toEqual(["claude"]);
    } finally {
      status.resolve(Response.json({ loggedIn: true }));
      await server.dispose();
    }
  });
}
