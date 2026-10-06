/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ComponentProps } from "react";
import type { Root } from "react-dom/client";
import ApiKeysListPanel from "../src/components/apikeys-workspace/ApiKeysListPanel";
import ApiKeys from "../src/pages/ApiKeys";
import { LanguageProvider } from "../src/i18n/provider";
import { configureApiTargets, resetApiAuthFetchForTests, SESSION_UNAVAILABLE_EVENT } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";
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

for (const mode of ["hidden", "inactive", "session", "apiBase"] as const) {
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
