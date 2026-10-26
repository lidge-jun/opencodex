import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import CodexDesktopCompatibility from "../src/pages/codex-desktop-compatibility";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { configureApiTargets, installApiAuthFetch, installApiSessionFromHtml, resetApiAuthFetchForTests, SESSION_CHANGED_EVENT } from "../src/api";
import { standaloneApiTargets } from "../src/api-targets";

const keys = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<string, unknown>, page: Window, root: Root | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearClientResourceStoresForTests(); resetApiAuthFetchForTests();
  previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  page = new Window({ url: "http://localhost/#codex-set/desktop" });
  page.localStorage.setItem("ocx-lang", "en");
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(page, key) });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  resetApiAuthFetchForTests();
  globalThis.fetch = originalFetch; page.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});
const requests: { url: string; method: string; body?: unknown }[] = [];
function server(uncertain = false, certificateState?: string, usagePhase?: string, observation?: Record<string, unknown>, buildAssessment?: unknown, mutationAuthorized = true) {
  requests.length = 0; let trusted = false, startup = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/settings")) {
      if (method === "POST") { startup = JSON.parse(String(init!.body)).startOnProxyStart; if (uncertain) throw new TypeError("uncertain response"); }
      return Response.json({ ok: true, settings: { startOnProxyStart: startup, revision: (startup ? "b" : "a").repeat(64) } });
    }
    if (method === "POST") { trusted = true; if (uncertain) throw new TypeError("uncertain response"); return Response.json({ ok: true }); }
    return Response.json(url.endsWith("/certificate") ? { ok: true, certificate: { supported: true, mutationAuthorized, state: trusted ? "trusted" : certificateState ?? "prepared", busy: null,
      fingerprint: (url.startsWith("/second") ? "B" : "A").repeat(64) } } : { ok: true, runtime: { supported: true, phase: usagePhase ? "running" : "off", running: !!usagePhase,
        ...(buildAssessment !== undefined ? { buildAssessment } : {}),
        ...(usagePhase ? { usage: { mode: "observe", phase: usagePhase, outputs: 0, appCacheConfirmed: false, ...(observation ? { observation } : {}) } } : {}) } });
  }) as typeof fetch;
}
async function mount(apiBase = "") {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render(apiBase); return container;
}
async function render(apiBase: string, connected = false) {
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CodexDesktopCompatibility apiBase={apiBase} active connected={connected} /></LanguageProvider></StrictMode>); });
}
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const value = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  if (!value) throw new Error("Missing button: " + text); return value;
}
async function chooseAndConfirm(container: HTMLElement) {
  await act(async () => button(container, "Register trust").click());
  expect(requests.filter(req => req.method === "POST" && !req.url.endsWith("/opencodex-session"))).toHaveLength(0);
  expect(button(container, "Confirm action").disabled).toBe(true);
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
}
test("StrictMode status reads are inert and a fingerprint-bound action needs explicit consent", async () => {
  server(); const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(false);
  expect(requests.every(req => req.method === "GET")).toBe(true);
  await chooseAndConfirm(container);
  const posts = requests.filter(req => req.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ action: "trust", confirmed: true, fingerprint: "A".repeat(64) });
  expect(button(container, "Start observation").disabled).toBe(false);
  await act(async () => button(container, "Start observation").click());
  expect(requests.filter(req => req.method === "POST").at(-1)?.body).toEqual({ action: "start", confirmed: true });
  expect(container.querySelector("fieldset")).toBeNull();
});

test("an ordinary loopback session offers explicit local pairing and disables every mutation", async () => {
  server(false, undefined, undefined, undefined, undefined, false); const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
  expect(container.textContent).toContain('ocx gui pair --origin "http://localhost"');
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  await act(async () => { button(container, "Register trust").click(); button(container, "Resume observation when OpenCodex starts").click(); });
  expect(container.querySelector("fieldset")).toBeNull();
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test.each([false, true])("a local pairing handoff enables desktop actions only after read-only authorization (authorized: %s)", async allowed => {
  server(false, undefined, undefined, undefined, undefined, false);
  const read = globalThis.fetch, origin = page.location.origin, sent: { url: string; token: string | null }[] = [];
  const sessionHtml = (token: string) => `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="${token}-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${origin}">`;
  const raw = (async (input, init) => {
    const url = String(input), token = new Headers(init?.headers).get("x-opencodex-api-key"); sent.push({ url, token });
    if (url.endsWith("/opencodex-session")) {
      requests.push({ url, method: init?.method ?? "GET" }); return new Response(sessionHtml("ocx_session_paired"));
    }
    const response = await read(input, init);
    if (!url.endsWith("/certificate")) return response;
    const value = await response.json(); if (value.certificate) value.certificate.mutationAuthorized = allowed && token === "ocx_session_paired";
    return Response.json(value);
  }) as typeof fetch;
  Object.defineProperty(page, "fetch", { configurable: true, writable: true, value: raw });
  configureApiTargets(standaloneApiTargets("")); installApiAuthFetch();
  for (const plane of ["machine", "shared"] as const) expect(installApiSessionFromHtml(plane, sessionHtml("ocx_session_automatic"))).toBe(true);
  globalThis.fetch = page.fetch as unknown as typeof fetch;
  const container = await mount(), input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
  await act(async () => input.dispatchEvent(new page.Event("input", { bubbles: true })));
  await act(async () => input.closest("form")!.dispatchEvent(new page.Event("submit", { bubbles: true, cancelable: true })));
  expect(requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["/opencodex-session"]);
  expect(button(container, "Register trust").disabled).toBe(!allowed);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(!allowed);
  if (allowed) {
    expect(container.querySelector("#connect-pairing-code")).toBeNull();
    await chooseAndConfirm(container);
    expect(sent.filter(request => request.url.endsWith("/certificate")).at(-1)!.token).toBe("ocx_session_paired");
    expect(requests.filter(request => request.method === "POST")).toHaveLength(2);
  } else {
    expect(input.disabled).toBe(false); expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await page.fetch("/api/codex/desktop-compatibility/certificate");
    expect(sent.at(-1)!.token).toBe("ocx_session_automatic");
  }
});

const pairingSessionHtml = (token: string, origin: string): string =>
  `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="${token}-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${origin}">`;
function pairingTransport(intercept: (url: string, token: string | null) => Response | null) {
  server(false, undefined, undefined, undefined, undefined, false);
  const read = globalThis.fetch, origin = page.location.origin, sent: { url: string; token: string | null }[] = [];
  const raw = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), token = new Headers(init?.headers).get("x-opencodex-api-key");
    sent.push({ url, token });
    if (url.endsWith("/opencodex-session")) { requests.push({ url, method: init?.method ?? "GET" }); return new Response(pairingSessionHtml("ocx_session_paired", origin)); }
    return intercept(url, token) ?? read(input, init);
  }) as typeof fetch;
  return { sent, raw };
}
async function mountPairing(raw: typeof fetch): Promise<HTMLElement> {
  Object.defineProperty(page, "fetch", { configurable: true, writable: true, value: raw });
  configureApiTargets(standaloneApiTargets("")); installApiAuthFetch();
  for (const plane of ["machine", "shared"] as const) expect(installApiSessionFromHtml(plane, pairingSessionHtml("ocx_session_automatic", page.location.origin))).toBe(true);
  globalThis.fetch = page.fetch as unknown as typeof fetch;
  return mount();
}
async function submitPairing(container: HTMLElement): Promise<HTMLInputElement> {
  const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
  await act(async () => input.dispatchEvent(new page.Event("input", { bubbles: true })));
  await act(async () => input.closest("form")!.dispatchEvent(new page.Event("submit", { bubbles: true, cancelable: true })));
  return input;
}
function refusedResponse(status: number, cancel: () => Promise<void>): Response {
  const response = new Response(null, { status });
  Object.defineProperty(response, "body", { value: { cancel } });
  return response;
}
function expectRefusedRollbackState(container: HTMLElement, input: HTMLInputElement): void {
  expect(requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["/opencodex-session"]);
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("rejected the code");
  expect(alert?.textContent).not.toContain("Could not reach the hub");
  expect(input.disabled).toBe(false);
  button(container, "Connect");
}

test.each([401, 403])("a refused pairing validation rolls back the session handoff when body cleanup rejects (status: %s)", async status => {
  let cancelCalls = 0;
  const { sent, raw } = pairingTransport((url, token) => url.endsWith("/certificate") && token === "ocx_session_paired"
    ? refusedResponse(status, () => { cancelCalls++; return Promise.reject(new Error("cancel failed")); }) : null);
  const container = await mountPairing(raw), input = await submitPairing(container);
  expect(cancelCalls).toBe(1);
  expectRefusedRollbackState(container, input);
  await page.fetch("/api/codex/desktop-compatibility/certificate");
  expect(sent.at(-1)!.token).toBe("ocx_session_automatic");
});

test.each([401, 403])("a refused pairing validation does not wait on a stalled body cleanup (status: %s)", async status => {
  let cancelCalls = 0, releaseStall: (() => void) | undefined;
  const { sent, raw } = pairingTransport((url, token) => url.endsWith("/certificate") && token === "ocx_session_paired"
    ? refusedResponse(status, () => { cancelCalls++; return new Promise<void>(resolve => { releaseStall = () => resolve(); }); }) : null);
  try {
    const container = await mountPairing(raw), input = await submitPairing(container);
    expect(cancelCalls).toBe(1);
    expectRefusedRollbackState(container, input);
    await page.fetch("/api/codex/desktop-compatibility/certificate");
    expect(sent.at(-1)!.token).toBe("ocx_session_automatic");
  } finally { releaseStall?.(); }
});

test("a network failure during pairing validation keeps the pending handoff for an explicit retry", async () => {
  let failed = false;
  const { sent, raw } = pairingTransport((url, token) => {
    if (url.endsWith("/certificate") && token === "ocx_session_paired" && !failed) { failed = true; throw new TypeError("connection reset"); }
    return null;
  });
  const container = await mountPairing(raw), input = await submitPairing(container);
  expect(failed).toBe(true);
  expect(requests.filter(request => request.method === "POST").map(request => request.url)).toEqual(["/opencodex-session"]);
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("session validation could not complete");
  expect(alert?.textContent).not.toContain("rejected the code");
  expect(input.disabled).toBe(true);
  button(container, "Retry validation");
  await page.fetch("/api/codex/desktop-compatibility/certificate");
  expect(sent.at(-1)!.token).toBe("ocx_session_paired");
});

test("machine session replacement drops consent and authorization while unrelated shared changes preserve them", async () => {
  server(); const container = await mount();
  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => page.dispatchEvent(new page.CustomEvent(SESSION_CHANGED_EVENT, { detail: { plane: "shared" } })));
  expect(button(container, "Confirm action").disabled).toBe(false);
  await act(async () => page.dispatchEvent(new page.CustomEvent(SESSION_CHANGED_EVENT, { detail: { plane: "machine" } })));
  expect(container.querySelector("fieldset")).toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
  expect(container.querySelector("#connect-pairing-code")).not.toBeNull();
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test.each(["expired-awaiting-original-response", "observing-awaiting-original-response"])("%s does not claim the native cache has reverted", async phase => {
  server(false, "trusted", phase); const container = await mount();
  expect(container.textContent).toContain("Stopping correction does not immediately reset the Codex display.");
  expect(container.textContent).toContain("this panel cannot confirm that refresh.");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test("observed response counts are displayed without claiming a native process or recovered composer", async () => {
  server(false, "trusted", "observing", { jsonSnapshots: 2, streamSnapshots: 3, validatedActiveStreams: 1, lastSnapshotAt: 1000,
    sourceProcessVerified: false, composerRecoveryVerified: false });
  const container = await mount();
  expect(container.textContent).toContain("JSON 2, SSE 3; active bound streams: 1");
  expect(container.textContent).toContain("Counts do not identify the sending process or prove composer recovery.");
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test("trial confirmation explains delayed native refresh before any correction request", async () => {
  server(false, "trusted", "observing"); const container = await mount();
  expect(container.textContent).not.toContain("Stopping correction does not immediately reset the Codex display.");
  await act(async () => button(container, "Run 3-minute trial").click());
  expect(container.querySelector("fieldset")?.textContent).toContain("Codex must receive fresh usage data");
  expect(button(container, "Confirm action").disabled).toBe(true);
  expect(requests.every(req => req.method === "GET")).toBe(true);
});

test.each([
  ["prepared", false, true], ["trusted", true, true], ["expired", true, true], ["renewal-required", true, true], ["unknown", true, false], ["invalid", false, false],
] as const)("certificate state %s exposes only supported cleanup and renewal actions", async (state, remove, renew) => {
  server(false, state); const container = await mount();
  const labels = [...container.querySelectorAll("button")].map(value => value.textContent);
  expect(labels.includes("Remove trust")).toBe(remove); expect(labels.includes("Renew certificate")).toBe(renew);
  if (state === "renewal-required") expect(labels.includes("Start observation")).toBe(false);
  expect(requests.filter(value => value.method === "POST")).toHaveLength(0);
});
test("a lost write response disables replay until a fresh read proves the actual state", async () => {
  server(true); const container = await mount(); await chooseAndConfirm(container);
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
  await act(async () => button(container, "Refresh status").click());
  expect(button(container, "Start observation").disabled).toBe(false);
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
});
test("changing target drops an outstanding certificate confirmation", async () => {
  server(); const container = await mount();
  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await render("/second");
  expect(container.querySelector("fieldset")).toBeNull(); expect(container.textContent).toContain("B".repeat(64));
  expect(requests.filter(req => req.method === "POST")).toHaveLength(0);
});
test("managed client mode never falls back to mutating the shared hub", async () => {
  server(); const container = await mount(); requests.length = 0;
  await render("/machine", true);
  expect(container.textContent).toContain("unavailable in OpenCodex managed client mode");
  expect(requests).toHaveLength(0); expect(container.querySelector("button")).toBeNull();
});
test("a completed build assessment shows verified and last observed versions without claiming support", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: "26.1007.9446.0", verified: false, completedAt: 1770000000000, privatePath: "fixture-secret" });
  const container = await mount();
  expect(container.textContent).toContain("Verified package version");
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).not.toContain("Installed package version");
  expect(container.textContent).toContain("26.924.2738.0");
  expect(container.textContent).toContain("26.1007.9446.0");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
  expect(container.textContent).not.toContain("fixture-secret");
  expect(container.textContent).not.toContain("Not detected");
});
test("a build assessment without an observed version reports detection, not verification", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: null, verified: false, completedAt: 1770000000000 });
  const container = await mount();
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).toContain("Not detected");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
});
test("no probe result hides the build version rows", async () => {
  server(false, "trusted");
  const container = await mount();
  expect(container.textContent).not.toContain("Last observed package version");
  expect(container.textContent).not.toContain("Observed at");
});
test("a stopped runtime still presents a stale verified check as a past observation, not current proof", async () => {
  server(false, "trusted", undefined, undefined,
    { assessedVersion: "26.924.2738.0", observedVersion: "26.924.2738.0", verified: true, completedAt: 1770000000000 });
  const container = await mount();
  expect(container.textContent).toContain("Last observed package version");
  expect(container.textContent).toContain(new Date(1770000000000).toLocaleString("en"));
  expect(container.textContent).not.toContain("Installed package version");
  expect(container.textContent).not.toContain("currently installed");
});
test("auto-start toggle writes once with the displayed revision and rechecks the saved state", async () => {
  server(); const container = await mount();
  const toggle = button(container, "Resume observation when OpenCodex starts");
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
  const posts = requests.filter(req => req.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toEndWith("/settings"); expect(posts[0]!.body).toEqual({ confirmed: true, startOnProxyStart: true, revision: "a".repeat(64) });
  expect(requests.some(req => req.method === "POST" && req.url.endsWith("/runtime"))).toBe(false);
});
test("an uncertain auto-start write is not replayed and refresh recovers its committed state", async () => {
  server(true); const container = await mount();
  const toggle = button(container, "Resume observation when OpenCodex starts");
  await act(async () => toggle.click()); expect(toggle.disabled).toBe(true);
  const setting = toggle.closest(".panel")!;
  await act(async () => button(setting as HTMLElement, "Refresh status").click());
  expect(toggle.disabled).toBe(false); expect(toggle.getAttribute("aria-pressed")).toBe("true");
  expect(requests.filter(req => req.method === "POST")).toHaveLength(1);
});

async function heldStartupSetting() {
  server();
  const read = globalThis.fetch, origin = page.location.origin;
  const sent: { method: string; token: string | null }[] = [];
  let release!: (response: Response) => void, postSignal: AbortSignal | undefined, saved = false;
  const settings = () => Response.json({ ok: true, settings: { startOnProxyStart: saved, revision: (saved ? "b" : "a").repeat(64) } });
  const html = (token: string) => `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="${token}-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${origin}">`;
  const raw = (async (input, init) => {
    init?.signal?.throwIfAborted();
    if (!String(input).endsWith("/settings")) return read(input, init);
    const method = init?.method ?? "GET", token = new Headers(init?.headers).get("x-opencodex-api-key"); sent.push({ method, token });
    if (method === "POST") {
      if (token === "ocx_session_old") {
        postSignal = init?.signal ?? undefined;
        // Deliberately return late even after abort, to exercise completion ownership as well.
        return await new Promise<Response>(resolve => { release = resolve; });
      }
      saved = true;
    }
    return settings();
  }) as typeof fetch;
  Object.defineProperty(page, "fetch", { configurable: true, writable: true, value: raw });
  configureApiTargets(standaloneApiTargets("")); installApiAuthFetch();
  expect(installApiSessionFromHtml("machine", html("ocx_session_old"))).toBe(true);
  globalThis.fetch = page.fetch as unknown as typeof fetch;
  const container = await mount(), toggle = button(container, "Resume observation when OpenCodex starts");
  const setting = toggle.closest(".panel") as HTMLElement;
  await act(async () => toggle.click());
  expect(typeof release).toBe("function");
  return { container, toggle, setting, sent, signal: () => postSignal, saved: () => saved,
    install: (plane: "machine" | "shared") => installApiSessionFromHtml(plane, html("ocx_session_new")),
    release: (response: Response) => release(response), settings,
    save: () => { saved = true; },
    refreshAuthority: () => (container.querySelector("section.panel > button") as HTMLButtonElement).click() };
}

test("machine session replacement aborts a held settings POST before a 401 can replay its consent", async () => {
  const io = await heldStartupSetting();
  let abortedSynchronously = false;
  await act(async () => { io.install("machine"); abortedSynchronously = io.signal()?.aborted === true; });
  await act(async () => io.release(new Response(null, { status: 401 })));
  expect(io.sent.filter(request => request.method === "POST").map(request => request.token)).toEqual(["ocx_session_old"]);
  expect(io.saved()).toBe(false); expect(abortedSynchronously).toBe(true);
  expect(io.toggle.disabled).toBe(true);
  await act(async () => io.refreshAuthority());
  expect(io.toggle.disabled).toBe(true); // Authority metadata cannot settle the uncertain preference.
  await act(async () => button(io.setting, "Refresh status").click());
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-pressed")).toBe("false");
});

test("a late old-session settings response cannot replace a fresh read or restore uncertainty", async () => {
  const io = await heldStartupSetting();
  await act(async () => io.install("machine"));
  await act(async () => io.refreshAuthority());
  await act(async () => button(io.setting, "Refresh status").click());
  expect(io.toggle.disabled).toBe(false);
  const reads = io.sent.filter(request => request.method === "GET").length;
  await act(async () => io.release(Response.json({ ok: true, settings: { startOnProxyStart: true, revision: "b".repeat(64) } })));
  expect(io.sent.filter(request => request.method === "GET")).toHaveLength(reads);
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-pressed")).toBe("false");
});

test("a shared-session change does not cancel an authorized machine settings operation", async () => {
  const io = await heldStartupSetting();
  await act(async () => io.install("shared"));
  expect(io.signal()?.aborted).toBe(false);
  io.save(); await act(async () => io.release(io.settings()));
  expect(io.sent.filter(request => request.method === "POST").map(request => request.token)).toEqual(["ocx_session_old"]);
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-pressed")).toBe("true");
});
