/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import type { Root } from "react-dom/client";
import ApiKeysListPanel from "../src/components/apikeys-workspace/ApiKeysListPanel";
import ApiKeys from "../src/pages/ApiKeys";
import { LanguageProvider } from "../src/i18n/provider";
import { configureApiTargets, hasApiSession, installApiAuthFetch, installApiSessionFromHtml, logoutApiSession, resetApiAuthFetchForTests, SESSION_UNAVAILABLE_EVENT } from "../src/api";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { standaloneApiTargets } from "../src/api-targets";
import { readSessionListCacheEntry } from "../src/session-list-cache";
import type { RevealKeyResult } from "../src/pages/api-keys-utils";

const origin = "http://127.0.0.1:10100";
const full = "ocx_data_" + "a".repeat(40);
const key = { id: "k1", name: "alpha", prefix: "ocx_data_aaaaaaaa...",
  createdAt: "2026-01-01T00:00:00.000Z", usage: { requests7d: 0, totalRequests: 0 } };
const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, PropertyDescriptor | undefined>;
let win: Window;
let root: Root | null;
let container: HTMLDivElement;

beforeEach(async () => {
  clearClientResourceStoresForTests();
  resetApiAuthFetchForTests();
  previous = Object.fromEntries(globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  win = new Window({ url: origin });
  for (const k of ["document", "navigator", "localStorage", "sessionStorage"] as const)
    Object.defineProperty(globalThis, k, { configurable: true, value: win[k] });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  document.head.innerHTML = '<meta name="opencodex-runtime-role" content="standalone">';
  configureApiTargets(standaloneApiTargets(""));
  container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  resetApiAuthFetchForTests();
  clearClientResourceStoresForTests();
  win.close();
  for (const k of globals) {
    if (previous[k]) Object.defineProperty(globalThis, k, previous[k]!);
    else Reflect.deleteProperty(globalThis, k);
  }
});

type Props = ComponentProps<typeof ApiKeysListPanel> & { active?: boolean };
async function render(props: Partial<Props> = {}) {
  await act(async () => root!.render(<LanguageProvider><ApiKeysListPanel
    keys={[key]} keysLoading={false} keysLoadFailed={false} apiBase=""
    busy={false} onSelect={() => {}} {...props} /></LanguageProvider>));
}
const row = () => container.querySelector<HTMLButtonElement>(".awi-keylist-key")!;
const click = async () => { await act(async () => row().click()); };
const loseSession = () => win.dispatchEvent(new win.CustomEvent(SESSION_UNAVAILABLE_EVENT, { detail: { plane: "shared" } }));
function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function pair(response?: () => Promise<Response>) {
  Object.defineProperty(win, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
    expect(url).toBe("/opencodex-session");
    expect(init.method).toBe("POST");
    if (response) return response();
    return new Response('<meta name="opencodex-session-token" content="ocx_session_fixture">'
      + '<meta name="opencodex-session-csrf" content="fixture-csrf">'
      + '<meta name="opencodex-session-origin" content="' + origin + '">'
      + '<meta name="opencodex-session-server-origin" content="' + origin + '">');
  } });
  const input = container.querySelector<HTMLInputElement>("#connect-pairing-code")!;
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, "ocx_pair_" + "a".repeat(43));
  await act(async () => input.dispatchEvent(new win.Event("input", { bubbles: true })));
  await act(async () => container.querySelector("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })));
}

for (const mode of ["hidden", "host-hidden", "inactive", "session", "apiBase"] as const) {
  test("existing plaintext and copy feedback are cleared on " + mode, async () => {
    const props: Partial<Props> = { onReveal: async () => ({ ok: true, key: full }) };
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
    await render(props);
    await click();
    await act(async () => container.querySelector<HTMLButtonElement>(".awi-keylist-copy")!.click());
    expect(container.textContent).toContain("Copied");
    await act(async () => {
      if (mode === "hidden") {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new win.Event("visibilitychange"));
      } else if (mode === "host-hidden") {
        expect(document.visibilityState).toBe("visible");
        win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false }));
      } else if (mode === "session") loseSession();
    });
    if (mode === "inactive") await render({ ...props, active: false });
    if (mode === "apiBase") await render({ ...props, apiBase: "http://127.0.0.1:20200" });
    expect(row().textContent).toBe(key.prefix);
    expect(container.querySelector(".awi-keylist-copy")).toBeNull();
    expect(container.textContent).not.toContain("Copied");
  });

  test("a stale reveal cannot restore plaintext after " + mode, async () => {
    const pending = defer<RevealKeyResult>();
    const props: Partial<Props> = { onReveal: () => pending.promise };
    await render(props);
    await click();
    await act(async () => {
      if (mode === "hidden") {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new win.Event("visibilitychange"));
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      } else if (mode === "host-hidden") {
        expect(document.visibilityState).toBe("visible");
        win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false }));
        win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: true }));
      } else if (mode === "session") loseSession();
    });
    if (mode === "inactive") { await render({ ...props, active: false }); await render(props); }
    if (mode === "apiBase") await render({ ...props, apiBase: "http://127.0.0.1:20200" });
    await act(async () => pending.resolve({ ok: true, key: full }));
    expect(row().textContent).toBe(key.prefix);
    expect(container.querySelector(".awi-keylist-copy")).toBeNull();
  });
}

test("starting pairing clears a different row's previous plaintext", async () => {
  const second = { ...key, id: "k2", name: "beta" };
  await render({ keys: [key, second], onReveal: async id => id === "k1"
    ? { ok: true, key: full } : { ok: false, kind: "denied" } });
  await click();
  await act(async () => container.querySelectorAll<HTMLButtonElement>(".awi-keylist-key")[1]!.click());
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  expect(row().textContent).toBe(key.prefix);
  expect(container.querySelector(".awi-keylist-copy")).toBeNull();
});

test("a late clipboard completion cannot recreate copy feedback after session loss", async () => {
  const pending = defer<void>();
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: () => pending.promise } });
  const props: Partial<Props> = { onReveal: async () => ({ ok: true, key: full }) };
  await render(props);
  await click();
  await act(async () => container.querySelector<HTMLButtonElement>(".awi-keylist-copy")!.click());
  await act(async () => loseSession());
  await click();
  await act(async () => pending.resolve());
  expect(container.querySelector(".awi-keylist-copy")?.textContent).toBe("Copy");
});

for (const role of ["hub", "client"]) test(role + " denial shows guidance without a local pairing form", async () => {
  document.head.innerHTML = '<meta name="opencodex-runtime-role" content="' + role + '">';
  await render({ onReveal: async () => ({ ok: false, kind: "denied" }) });
  await click();
  expect(container.textContent).toContain("operator-authorized session");
  expect(container.querySelector("#connect-pairing-code")).toBeNull();
});

test("API-key page treats a reveal 401 as pairing guidance", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.endsWith("/api/keys/reveal")) return new Response(null, { status: 401 });
    if (path.endsWith("/api/keys")) return Response.json({ keys: [key], attributionSince: "2026-01-01T00:00:00.000Z",
      authMatrix: [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }] });
    return Response.json([]);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetcher });
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
  await click();
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  expect(row().textContent).toBe(key.prefix);
});

test("session loss during a reveal retains pairing guidance while discarding its answer", async () => {
  await render({ onReveal: async () => {
    loseSession();
    return { ok: false, kind: "denied" };
  } });
  await click();
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  expect(row().textContent).toBe(key.prefix);
});

test("an unrelated machine-session notice leaves the shared reveal intact", async () => {
  await render({ onReveal: async () => ({ ok: true, key: full }) });
  await click();
  await act(async () => win.dispatchEvent(new win.CustomEvent(SESSION_UNAVAILABLE_EVENT, { detail: { plane: "machine" } })));
  expect(row().textContent).toBe(full);
});

test("unmount discards a pending reveal and removes its session listener", async () => {
  const pending = defer<RevealKeyResult>();
  await render({ onReveal: () => pending.promise });
  await click();
  await act(async () => root!.unmount());
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  await render({ onReveal: async () => ({ ok: true, key: full }) });
  await act(async () => pending.resolve({ ok: true, key: full }));
  expect(row().textContent).toBe(key.prefix);
  await click();
  expect(row().textContent).toBe(full);
});

async function pageWithCreate(created: () => Promise<Response>) {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/api/keys") && init?.method === "POST") return created();
    if (String(input).endsWith("/api/keys/reveal")) return new Response(null, { status: 403 });
    if (String(input).endsWith("/api/keys")) return Response.json({ keys: [key],
      authMatrix: [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }] });
    return Response.json([]);
  } });
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
  const generate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Generate"))!;
  expect(generate).toBeDefined();
  await act(async () => generate.click());
}

test("a newly created one-time value is cleared when the page becomes inactive", async () => {
  await pageWithCreate(async () => Response.json({ key: full }));
  expect(container.textContent).toContain(full);
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" active={false} /></LanguageProvider>));
  expect(container.textContent).not.toContain(full);
});

test("a late create response cannot restore a one-time value after session loss", async () => {
  const pending = defer<Response>();
  await pageWithCreate(() => pending.promise);
  await act(async () => loseSession());
  await act(async () => pending.resolve(Response.json({ key: full })));
  expect(container.textContent).not.toContain(full);
});

test("pairing submission clears a one-time value created after its form was offered", async () => {
  await pageWithCreate(async () => Response.json({ key: full }));
  await click();
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  const generate = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes("Generate"))!;
  await act(async () => generate.click());
  expect(container.textContent).toContain(full);
  const pending = defer<Response>();
  await pair(() => pending.promise);
  expect(container.textContent).not.toContain(full);
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  await act(async () => pending.resolve(new Response(null, { status: 403 })));
  expect(container.textContent).not.toContain(full);
});

function sessionHtml(token: string) {
  return `<meta name="opencodex-session-token" content="${token}">`
    + `<meta name="opencodex-session-csrf" content="fixture-csrf">`
    + `<meta name="opencodex-session-origin" content="${origin}">`
    + `<meta name="opencodex-session-server-origin" content="${origin}">`;
}

test("401 recovery and authenticated retry expire an already revealed value", async () => {
  const bootstrap = defer<Response>();
  const credentials: (string | null)[] = [];
  let attempts = 0;
  let unavailable = 0;
  win.addEventListener(SESSION_UNAVAILABLE_EVENT, () => { unavailable++; });
  Object.defineProperty(win, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/opencodex-session") return bootstrap.promise;
    credentials.push(new Headers(init?.headers).get("X-OpenCodex-API-Key"));
    return ++attempts === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
  } });
  installApiAuthFetch();
  expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired"))).toBe(true);
  await render({ onReveal: async () => ({ ok: true, key: full }) });
  await click();
  expect(row().textContent).toBe(full);
  let recovery!: Promise<Response>;
  await act(async () => { recovery = window.fetch("/api/combos"); });
  expect(row().textContent).toBe(key.prefix);
  await act(async () => {
    bootstrap.resolve(new Response(sessionHtml("ocx_session_automatic")));
    expect((await recovery).status).toBe(200);
  });
  expect(credentials).toEqual(["ocx_session_paired", "ocx_session_automatic"]);
  expect(hasApiSession("shared")).toBe(true);
  expect(unavailable).toBe(0);
  expect(row().textContent).toBe(key.prefix);
});

for (const mode of ["replace", "clear", "logout", "target"] as const) {
  test("session store " + mode + " expires revealed values without an unavailable notice", async () => {
    installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired"));
    await render({ onReveal: async () => ({ ok: true, key: full }) });
    await click();
    await act(async () => {
      if (mode === "replace") installApiSessionFromHtml("shared", sessionHtml("ocx_session_other"));
      else if (mode === "clear") installApiSessionFromHtml("shared", "");
      else if (mode === "target") configureApiTargets(standaloneApiTargets("http://127.0.0.1:20200"));
      else {
        Object.defineProperty(win, "fetch", { configurable: true, value: async () => new Response(null, { status: 204 }) });
        expect(await logoutApiSession("shared")).toBe(true);
      }
    });
    expect(row().textContent).toBe(key.prefix);
  });
}

test("host hide prevents a late clipboard completion from restoring feedback", async () => {
  const pending = defer<void>();
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: () => pending.promise } });
  await render({ onReveal: async () => ({ ok: true, key: full }) });
  await click();
  await act(async () => container.querySelector<HTMLButtonElement>(".awi-keylist-copy")!.click());
  await act(async () => {
    win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false }));
    win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: true }));
  });
  expect(document.visibilityState).toBe("visible");
  await click();
  await act(async () => pending.resolve());
  expect(container.querySelector(".awi-keylist-copy")?.textContent).toBe("Copy");
});

for (const hostname of ["localhost", "dashboard.localhost"]) for (const apiBase of ["", origin, "http://[::1]:10100"]) {
  test(hostname + " denial at " + (apiBase || "same origin") + " omits an unproven pairing URL and keeps generic guidance", async () => {
    win.location.href = `http://${hostname}:10100/`;
    configureApiTargets(standaloneApiTargets(apiBase));
    await render({ apiBase, onReveal: async () => ({ ok: false, kind: "denied" }) });
    await click();
    expect(container.querySelector("#connect-pairing-code")).toBeNull();
    expect(container.textContent).toContain("operator-authorized session");
    expect(container.textContent).not.toContain("Reopen the dashboard");
    expect(container.querySelector('a[href^="http://127.0.0.1"], a[href^="http://[::1]"]')).toBeNull();
  });
}

const hiddenMessage = "The key was created or its rotation started, but the one-time value was hidden because the session or view changed.";
const authMatrix = [{ endpoint: "/v1/models", bearer: "accepted", dedicated: "accepted", xApiKey: "accepted" }];
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
  .find(b => b.textContent?.trim() === label)!;

for (const operation of ["create", "rotate"] as const) for (const change of ["session", "host-hidden", "inactive"] as const) {
  test(operation + " reconciles successful inventory after " + change + " and explains the hidden value", async () => {
    const pending = defer<Response>();
    let completed = false;
    let pendingRotation = false;
    let reads = 0;
    let finishBody: unknown;
    if (operation === "rotate") document.head.innerHTML = '<meta name="opencodex-runtime-role" content="client">';
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((operation === "create" && path === "/api/keys" && init?.method === "POST")
        || (path === "/api/keys/rotate" && init?.method === "POST")) return pending.promise;
      if (path === "/api/keys/rotate/commit") {
        finishBody = JSON.parse(String(init?.body));
        pendingRotation = false;
        return Response.json({ ok: true });
      }
      if (path === "/api/keys") {
        reads++;
        return Response.json({ authMatrix, keys: operation === "create" && completed ? [key, { ...key, id: "k2", name: "new key" }]
          : [{ ...key, ...(pendingRotation ? { pendingRotation: { id: "r1", createdAt: key.createdAt, expiresAt: "2026-12-01T00:00:00.000Z" } } : {}) }] });
      }
      return Response.json([]);
    } });
    await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
    if (operation === "rotate") await act(async () => container.querySelector<HTMLButtonElement>(".awi-keylist-name")!.click());
    await act(async () => button(operation === "create" ? "Generate" : "Start rotation").click());
    const readsBefore = reads;
    await act(async () => {
      if (change === "session") loseSession();
      else if (change === "host-hidden") win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false }));
      else root!.render(<LanguageProvider><ApiKeys apiBase="" active={false} /></LanguageProvider>);
    });
    await act(async () => {
      completed = true;
      pendingRotation = operation === "rotate";
      pending.resolve(Response.json({ key: full, rotationId: "r1" }));
    });
    expect(reads).toBe(readsBefore + 1);
    expect(container.textContent).not.toContain(full);
    expect(container.textContent).toContain(hiddenMessage);
    if (operation === "create") expect(container.textContent).toContain("new key");
    else {
      // Complete rotation only after returning to the active, visible view.
      if (change === "inactive") await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
      if (change === "host-hidden") await act(async () => win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: true })));
      expect(button("Abort rotation")).toBeDefined();
      expect(container.textContent).not.toContain("The rotation action did not complete");
      await act(async () => button("Commit rotation").click());
      expect(finishBody).toEqual({ id: "k1", rotationId: "r1" });
      expect(button("Start rotation")).toBeDefined();
    }
  });
}

test("a create completed after switching servers revalidates its original inventory on return", async () => {
  const pending = defer<Response>();
  const reads: string[] = [];
  let completed = false;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/keys" && init?.method === "POST") return pending.promise;
    if (path.endsWith("/api/keys")) {
      reads.push(path);
      return Response.json({ authMatrix, keys: [{ ...key, name: path === "/api/keys" && completed ? "original created" : "current server" }] });
    }
    return Response.json([]);
  } });
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
  await act(async () => button("Generate").click());
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="http://127.0.0.1:20200" /></LanguageProvider>));
  const before = reads.length;
  await act(async () => { completed = true; pending.resolve(Response.json({ key: full })); });
  expect(reads.slice(before)).toEqual([]);
  expect(container.textContent).toContain("current server");
  expect(container.textContent).not.toContain("original created");
  expect(container.textContent).not.toContain(full);
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
  expect(reads.slice(before)).toEqual(["/api/keys"]);
  expect(container.textContent).toContain("original created");
  expect(container.textContent).not.toContain(full);
});

test("a denied reveal after automatic session recovery keeps the pairing remedy", async () => {
  let attempts = 0;
  Object.defineProperty(win, "fetch", { configurable: true, value: async (input: RequestInfo | URL) => {
    if (String(input) === "/opencodex-session") return new Response(sessionHtml("ocx_session_automatic"));
    return new Response(null, { status: ++attempts === 1 ? 401 : 403 });
  } });
  installApiAuthFetch();
  installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired"));
  await render({ onReveal: async () => {
    const response = await window.fetch("/api/keys/reveal", { method: "POST" });
    return { ok: false, kind: response.status === 403 ? "denied" : "failed" };
  } });
  await click();
  expect(attempts).toBe(2);
  expect(row().textContent).toBe(key.prefix);
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
});

test("the same shared token and an unrelated machine replacement preserve the revealed value", async () => {
  installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired"));
  await render({ onReveal: async () => ({ ok: true, key: full }) });
  await click();
  await act(async () => {
    installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired"));
    installApiSessionFromHtml("machine", sessionHtml("ocx_session_machine"));
  });
  expect(row().textContent).toBe(full);
});

test("host hide rejects a reveal completion even before the host event arrives", async () => {
  const pending = defer<RevealKeyResult>();
  await render({ onReveal: () => pending.promise });
  await click();
  await act(async () => {
    Object.assign(win, { __OPENCODEX_HOST_VISIBLE__: false });
    pending.resolve({ ok: true, key: full });
  });
  expect(document.visibilityState).toBe("visible");
  expect(row().textContent).toBe(key.prefix);
});

test("a rejected one-time clipboard completion after host hide does not restore an error", async () => {
  let reject!: (reason: Error) => void;
  const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: { writeText: () => pending } });
  await pageWithCreate(async () => Response.json({ key: full }));
  const copy = container.querySelector<HTMLButtonElement>(".api-newkey-panel button")!;
  expect(copy.textContent).toBe("Copy");
  await act(async () => copy.click());
  await act(async () => win.dispatchEvent(new win.CustomEvent("opencodex:host-visibility", { detail: false })));
  await act(async () => reject(new Error("clipboard refused")));
  expect(container.textContent).not.toContain(full);
  expect(container.textContent).not.toContain("Could not copy");
});

for (const finish of ["commit", "abort"] as const) {
  test("a delayed rotation-start inventory cannot resurrect pending controls after " + finish, async () => {
    document.head.innerHTML = '<meta name="opencodex-runtime-role" content="client">';
    const older = defer<Response>();
    const newer = defer<Response>();
    const signals: (AbortSignal | null | undefined)[] = [];
    let reads = 0;
    const inventory = (pending: boolean) => Response.json({ authMatrix, keys: [{ ...key,
      ...(pending ? { pendingRotation: { id: "r1", createdAt: key.createdAt, expiresAt: "2026-12-01T00:00:00.000Z" } } : {}) }] });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/keys/rotate" && init?.method === "POST") return Response.json({ key: full, rotationId: "r1" });
      if (path === "/api/keys/rotate/commit" || (path === "/api/keys/rotate" && init?.method === "DELETE")) return Response.json({ ok: true });
      if (path === "/api/keys") {
        signals.push(init?.signal);
        return ++reads === 1 ? inventory(false) : reads === 2 ? older.promise : newer.promise;
      }
      return Response.json([]);
    } });
    await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".awi-keylist-name")!.click());
    await act(async () => button("Start rotation").click());
    expect(container.textContent).toContain(full);
    expect(reads).toBe(2);
    await act(async () => button(finish === "commit" ? "Commit rotation" : "Abort rotation").click());
    expect(reads).toBe(3);
    await act(async () => newer.resolve(inventory(false)));
    expect(button("Start rotation")).toBeDefined();
    await act(async () => older.resolve(inventory(true)));
    expect(button("Start rotation")).toBeDefined();
    expect(button("Commit rotation")).toBeUndefined();
    expect(button("Abort rotation")).toBeUndefined();
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);
    const cached = readSessionListCacheEntry<{ keys: { pendingRotation?: unknown }[] }>("ocx.apikeys.list.v2:");
    expect(cached?.data.keys[0]?.pendingRotation).toBeUndefined();
  });
}

test("a delayed first create inventory cannot replace a newer create inventory", async () => {
  const older = defer<Response>();
  const newer = defer<Response>();
  let reads = 0;
  let creates = 0;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/keys" && init?.method === "POST") {
      creates++;
      return Response.json({ key: full });
    }
    if (String(input) === "/api/keys") return ++reads === 1 ? Response.json({ authMatrix, keys: [key] })
      : reads === 2 ? older.promise : newer.promise;
    return Response.json([]);
  } });
  await act(async () => root!.render(<LanguageProvider><ApiKeys apiBase="" /></LanguageProvider>));
  await act(async () => button("Generate").click());
  await act(async () => button("Generate").click());
  expect(creates).toBe(2);
  expect(reads).toBe(3);
  const first = { ...key, id: "k2", name: "first created" };
  const second = { ...key, id: "k3", name: "second created" };
  await act(async () => newer.resolve(Response.json({ authMatrix, keys: [key, first, second] })));
  expect(container.textContent).toContain("second created");
  await act(async () => older.resolve(Response.json({ authMatrix, keys: [key, first] })));
  expect(container.textContent).toContain("second created");
  const cached = readSessionListCacheEntry<{ keys: { name: string }[] }>("ocx.apikeys.list.v2:");
  expect(cached?.data.keys.map(row => row.name)).toEqual(["alpha", "first created", "second created"]);
});

for (const literalOrigin of [origin, "http://[::1]:10100"]) {
  test("same-origin literal loopback retains its pairing form: " + literalOrigin, async () => {
    win.location.href = literalOrigin;
    configureApiTargets(standaloneApiTargets(""));
    await render({ onReveal: async () => ({ ok: false, kind: "denied" }) });
    await click();
    expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
    expect(container.querySelector(".connect-pairing pre")?.textContent)
      .toBe(`ocx gui pair --origin "${literalOrigin}"`);
    expect(container.querySelector("a")).toBeNull();
  });
}
