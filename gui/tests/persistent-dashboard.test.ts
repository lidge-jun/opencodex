import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { promptForAdminToken } from "../src/admin-token-dialog";
import { bootstrapApiSession, configureApiTargets, DEVICE_PROOF_CHANGED_EVENT, hasApiSession, hasRememberedDashboardDevice, installApiAuthFetch, installApiSessionFromHtml, logoutApiSession, resetApiAuthFetchForTests, setRebootstrapTimeoutForTests } from "../src/api";

const PROOF_KEY = "opencodex.dashboard-device-proof";
const PROOF = `ocx_proof_${"A".repeat(43)}`;
const names = ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement"] as const;
let previous: unknown[];
let browser: Window;
beforeEach(() => {
  previous = names.map(name => Reflect.get(globalThis, name));
  browser = new Window({ url: "https://dashboard.example.test/" });
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: Reflect.get(browser, name) });
  const meta = document.createElement("meta"); meta.name = "opencodex-management-auth-required"; meta.content = "1"; document.head.append(meta);
  resetApiAuthFetchForTests();
});
afterEach(() => { resetApiAuthFetchForTests(); browser.close(); names.forEach((name, i) => Object.defineProperty(globalThis, name, { configurable: true, value: previous[i] })); });

test("remember is opt-in and submits the device choice without storing the admin token", async () => {
  let requested: unknown;
  const pending = promptForAdminToken(async (_token, remember) => { requested = remember; return "accepted"; });
  const box = document.querySelector<HTMLInputElement>('input[name="remember-device"]');
  expect(box).not.toBeNull(); expect(box!.checked).toBe(false);
  box!.checked = true;
  const form = document.querySelector("form")!;
  form.querySelector<HTMLInputElement>('input[name="password"]')!.value = "ocx_admin_fixture";
  form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
  expect(await pending).toBe("ocx_admin_fixture"); expect(requested).toBe(true);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); expect(document.cookie).toBe("");
});

test("remember response stores proof and reload sends it only on session bootstrap", async () => {
  const seen: Array<{ path: string; headers: Headers; init?: RequestInit }> = [];
  resetApiAuthFetchForTests(async (verify, allowed) => { expect(allowed).toBe(true); expect(await verify("ocx_admin_fixture", true)).toBe("accepted"); return "ocx_admin_fixture"; });
  let reload = false;
  const handler = (async (input, init) => {
    const path = String(input); const headers = new Headers(init?.headers); seen.push({ path, headers, init });
    if (path.endsWith("/api/session/remember")) return Response.json({ device: { proof: PROOF }, session: { token: "ocx_session_remembered", csrfToken: "csrf-fixture", browserOrigin: window.location.origin, serverOrigin: window.location.origin } });
    if (reload && path === "/opencodex-session" && headers.get("X-OpenCodex-Device-Proof") === PROOF) return new Response(sessionHtml());
    if (path === "/api/config" && headers.get("X-OpenCodex-API-Key") === "ocx_session_remembered") return Response.json({ ok: true });
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  window.fetch = handler;
  installApiAuthFetch();
  expect((await window.fetch("/api/config")).status).toBe(200); expect(hasApiSession("shared")).toBe(true);
  const exchange = seen.find(row => row.path.endsWith("/api/session/remember"))!;
  expect(exchange.init?.method).toBe("POST"); expect(exchange.init?.credentials).toBe("same-origin");
  expect(seen.filter(row => row.path === "/api/config").some(row => row.headers.get("X-OpenCodex-API-Key") === "ocx_admin_fixture")).toBe(false);
  expect(localStorage.getItem(PROOF_KEY)).toBe(PROOF);
  expect(localStorage.length).toBe(1); expect(sessionStorage.length).toBe(0); expect(document.cookie).toBe("");
  reload = true;
  resetApiAuthFetchForTests(async () => { throw new Error("reload should resume without a prompt"); });
  window.fetch = handler; installApiAuthFetch();
  expect(await bootstrapApiSession("shared")).toBe(true);
  expect((await window.fetch("/api/config")).status).toBe(200);
  await window.fetch("/api/config", { method: "POST" });
  await window.fetch("/v1/models");
  await window.fetch("https://other.example.test/api/config");
  const proofRequests = seen.filter(row => row.headers.has("X-OpenCodex-Device-Proof"));
  expect(proofRequests).toHaveLength(1);
  expect(proofRequests[0]!.path).toBe("/opencodex-session");
  expect(proofRequests[0]!.init?.redirect).toBe("error");
  for (const row of seen) expect(row.path).not.toContain(PROOF);
});

test("obsolete remembered bearer tokens are removed without reading or migrating them", () => {
  localStorage.setItem("opencodex.remembered-admin-token", "unsafe-legacy");
  localStorage.setItem("opencodex.remembered-admin-token:https://server|same-origin", "unsafe-scoped");
  localStorage.setItem("opencodex.remembered-admin-token-decoy", "unrelated");
  localStorage.setItem(PROOF_KEY, PROOF);
  const getter = localStorage.getItem.bind(localStorage); let reads = 0;
  Object.defineProperty(localStorage, "getItem", { configurable: true, value: (key: string) => { reads++; return getter(key); } });
  installApiAuthFetch();
  expect(reads).toBe(0); expect(getter("opencodex.remembered-admin-token")).toBeNull();
  expect(getter("opencodex.remembered-admin-token:https://server|same-origin")).toBeNull();
  expect(getter("opencodex.remembered-admin-token-decoy")).toBe("unrelated");
  expect(getter(PROOF_KEY)).toBe(PROOF);
});

test("Forget visibility follows stored proof enrollment and refreshes on the proof event", async () => {
  const events: string[] = [];
  window.addEventListener(DEVICE_PROOF_CHANGED_EVENT, event => events.push((event as CustomEvent<{ plane?: string }>).detail?.plane ?? ""));
  installApiAuthFetch();
  expect(hasRememberedDashboardDevice("shared")).toBe(false);
  resetApiAuthFetchForTests(async (verify, allowed) => allowed && await verify("ocx_admin_fixture", true) === "accepted" ? "ocx_admin_fixture" : null);
  window.fetch = (async (input, init) => {
    const path = String(input);
    if (path.endsWith("/api/session/remember")) return Response.json({ device: { proof: PROOF }, session: { token: "ocx_session_enrolled", csrfToken: "csrf", browserOrigin: window.location.origin, serverOrigin: window.location.origin } });
    if (path.endsWith("/api/session/logout")) return Response.json({ ok: true });
    if (path === "/api/config" && new Headers(init?.headers).get("X-OpenCodex-API-Key") === "ocx_session_enrolled") return Response.json({ ok: true });
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  installApiAuthFetch();
  expect((await window.fetch("/api/config")).status).toBe(200);
  expect(hasRememberedDashboardDevice("shared")).toBe(true);
  expect(events).toEqual(["shared"]);
  expect(await logoutApiSession("shared")).toBe(true);
  expect(hasRememberedDashboardDevice("shared")).toBe(false);
  expect(events).toEqual(["shared", "shared"]);
});

test("a hung Remember response body is aborted and cannot install a session", async () => {
  let verdict: unknown; let attempts = 0; let signal: AbortSignal | undefined;
  resetApiAuthFetchForTests(async verify => { verdict = await verify("ocx_admin_fixture", true); return null; });
  setRebootstrapTimeoutForTests(20);
  window.fetch = (async (input, init) => {
    if (!String(input).endsWith("/api/session/remember")) return new Response(null, { status: 401 });
    attempts++; signal = init?.signal as AbortSignal;
    const response = new Response(null);
    response.json = () => new Promise(() => {});
    return response;
  }) as typeof fetch;
  installApiAuthFetch();
  expect((await window.fetch("/api/config")).status).toBe(401);
  expect(attempts).toBe(1); expect(verdict).toBe("unavailable"); expect(signal?.aborted).toBe(true); expect(hasApiSession("shared")).toBe(false);
});

function sessionHtml(): string {
  return `<meta name="opencodex-session-token" content="ocx_session_remembered">
    <meta name="opencodex-session-csrf" content="csrf-fixture">
    <meta name="opencodex-session-origin" content="${window.location.origin}">
    <meta name="opencodex-session-server-origin" content="${window.location.origin}">`;
}

for (const storageFailure of ["unavailable", "write throws"] as const) {
  test(`Remember reports unavailable and clears its session when storage ${storageFailure}`, async () => {
    if (storageFailure === "unavailable") Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Storage disabled"); } });
    else Object.defineProperty(window, "localStorage", { configurable: true, value: {
      get length() { return 0; }, key: () => null, removeItem: () => {},
      getItem: () => null, setItem: () => { throw new Error("Quota exceeded"); },
    } });
    let verdict: unknown;
    resetApiAuthFetchForTests(async verify => { verdict = await verify("ocx_admin_fixture", true); return null; });
    window.fetch = (async input => String(input).endsWith("/api/session/remember")
      ? Response.json({ device: { proof: PROOF }, session: { token: "ocx_session_remembered", csrfToken: "csrf-fixture", browserOrigin: window.location.origin, serverOrigin: window.location.origin } })
      : new Response(null, { status: 401 })) as typeof fetch;
    installApiAuthFetch();
    expect((await window.fetch("/api/config")).status).toBe(401);
    expect(verdict).toBe("unavailable"); expect(hasApiSession("shared")).toBe(false);
  });
}

for (const proof of [undefined, null, 42, `ocx_proof_${"A".repeat(42)}`, `ocx_proof_${"A".repeat(44)}`, `ocx_proof_${"!".repeat(43)}`]) {
  test(`Remember rejects malformed device proof: ${String(proof)}`, async () => {
    let verdict: unknown;
    resetApiAuthFetchForTests(async verify => { verdict = await verify("ocx_admin_fixture", true); return null; });
    window.fetch = (async input => String(input).endsWith("/api/session/remember")
      ? Response.json({ device: { proof }, session: { token: "ocx_session_remembered", csrfToken: "csrf-fixture", browserOrigin: window.location.origin, serverOrigin: window.location.origin } })
      : new Response(null, { status: 401 })) as typeof fetch;
    installApiAuthFetch();
    expect((await window.fetch("/api/config")).status).toBe(401);
    expect(verdict).toBe("unavailable"); expect(hasApiSession("shared")).toBe(false);
    expect(localStorage.getItem(PROOF_KEY)).toBeNull();
  });
}

for (const failure of ["response", "network"] as const) {
  test(`logout keeps proof after ${failure} failure, then retry revokes and removes proof`, async () => {
    localStorage.setItem(PROOF_KEY, PROOF);
    let attempts = 0;
    const seen: Headers[] = [];
    window.fetch = (async (input, init) => {
      expect(String(input)).toBe("/api/session/logout");
      seen.push(new Headers(init?.headers)); attempts++;
      if (attempts === 1 && failure === "network") throw new Error("Offline");
      return new Response(null, { status: attempts === 1 ? 503 : 200 });
    }) as typeof fetch;
    installApiAuthFetch();
    expect(installApiSessionFromHtml("shared", sessionHtml())).toBe(true);
    expect(await logoutApiSession("shared")).toBe(false);
    expect(localStorage.getItem(PROOF_KEY)).toBe(PROOF); expect(hasApiSession("shared")).toBe(true);
    expect(await logoutApiSession("shared")).toBe(true);
    expect(localStorage.getItem(PROOF_KEY)).toBeNull(); expect(hasApiSession("shared")).toBe(false);
    expect(await bootstrapApiSession("shared")).toBe(false);
    expect(attempts).toBe(2);
    for (const headers of seen) {
      expect(headers.get("X-OpenCodex-API-Key")).toBe("ocx_session_remembered");
      expect(headers.get("X-OpenCodex-CSRF-Token")).toBe("csrf-fixture");
      expect(headers.has("X-OpenCodex-Device-Proof")).toBe(false);
    }
  });
}

test("invalid stored proof is omitted from bootstrap", async () => {
  localStorage.setItem(PROOF_KEY, "invalid-proof");
  window.fetch = (async (_input, init) => {
    expect(new Headers(init?.headers).has("X-OpenCodex-Device-Proof")).toBe(false);
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  installApiAuthFetch();
  expect(await bootstrapApiSession("shared")).toBe(false);
});

test("a bootstrap URL outside the dashboard origin receives no proof", async () => {
  localStorage.setItem(PROOF_KEY, PROOF);
  window.fetch = (async (_input, init) => {
    expect(new Headers(init?.headers).has("X-OpenCodex-Device-Proof")).toBe(false);
    return new Response(null, { status: 401 });
  }) as typeof fetch;
  installApiAuthFetch();
  const target = { baseUrl: "", serverOrigin: window.location.origin, bootstrapPath: "https://other.example.test/opencodex-session", transport: "same-origin" as const };
  configureApiTargets({ connected: false, machine: { ...target, id: "machine" }, shared: { ...target, id: "shared" } });
  expect(await bootstrapApiSession("shared")).toBe(false);
});
