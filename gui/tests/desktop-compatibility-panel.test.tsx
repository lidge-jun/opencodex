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
    if (url.endsWith("/authorization")) return Response.json({ ok: true, supported: true, authorized: mutationAuthorized });
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

test("an ordinary loopback session offers explicit Desktop authorization and disables every mutation", async () => {
  server(false, undefined, undefined, undefined, undefined, false); const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
  expect(container.textContent).toContain("ocx gui pair --desktop --origin");
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  await act(async () => { button(container, "Register trust").click(); button(container, "Resume observation when OpenCodex starts").click(); });
  expect(container.querySelector("fieldset")).toBeNull();
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test("a remembered session offers private-window recovery instead of an unusable grant form", async () => {
  server(false, undefined, undefined, undefined, undefined, false);
  const fetchServer = globalThis.fetch;
  globalThis.fetch = (async (input, init) => String(input).endsWith("/authorization")
    ? Response.json({ ok: true, supported: true, authorized: false, rememberedSession: true })
    : fetchServer(input, init)) as typeof fetch;
  const container = await mount();
  expect(container.textContent).toContain("private browser window");
  expect(container.textContent).not.toContain("ocx gui pair --desktop --origin");
});

test("a host the server does not support offers no Desktop command a user could not run", async () => {
  // #8427: a configured `localhost` bind is canonicalized to 127.0.0.1 before listening, so the
  // page's own origin cannot be the served origin and the CLI refuses it. The server says so in
  // `supported`, and the dashboard must not print a command that would fail.
  server(); globalThis.fetch = (async (input, init) => {
    const url = String(input), method = init?.method ?? "GET";
    requests.push({ url, method });
    if (url.endsWith("/authorization")) return Response.json({ ok: true, supported: false, authorized: false });
    if (url.endsWith("/settings")) return Response.json({ ok: true, settings: { startOnProxyStart: false, revision: "a".repeat(64) } });
    return Response.json(url.endsWith("/certificate") ? { ok: true, certificate: { supported: true, state: "prepared", busy: null, fingerprint: "A".repeat(64) } }
      : { ok: true, runtime: { supported: true, running: false, phase: "off" } });
  }) as typeof fetch;
  const container = await mount();
  expect(container.textContent).toContain("hostname as the literal loopback address");
  expect(container.textContent).toContain("non-loopback address such as 0.0.0.0");
  expect(container.textContent).toContain("Forwarding, a different role or port, and the current session");
  expect(container.textContent).toContain("Restart the proxy");
  expect(container.textContent).not.toContain("ocx gui pair --desktop --origin");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(requests.every(request => request.method === "GET")).toBe(true);
});

test.each([false, true])("a one-use Desktop grant enables actions only after authorization (authorized: %s)", async allowed => {
  const calls: { path: string; method: string }[] = []; let authorized = false;
  globalThis.fetch = (async (input, init) => {
    const path = String(input), method = init?.method ?? "GET"; calls.push({ path, method });
    if (path.endsWith("/authorization")) {
      if (method === "POST") {
        if (!allowed) return Response.json({ error: "desktop_authorization_required" }, { status: 403 });
        authorized = true;
        return Response.json({ ok: true, authorized: true });
      }
      return Response.json({ ok: true, supported: true, authorized });
    }
    if (method === "POST") return Response.json({ ok: true });
    if (path.endsWith("/settings")) return Response.json({ ok: true, settings: { startOnProxyStart: false, revision: "a".repeat(64) } });
    if (path.endsWith("/certificate")) return Response.json({ ok: true, certificate: { supported: true, state: "prepared", busy: null, fingerprint: "A".repeat(64) } });
    return Response.json({ ok: true, runtime: { supported: true, running: false, phase: "off" } });
  }) as typeof fetch;
  const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(true);
  const code = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value")!.set!.call(code, "ocx_pair_" + "A".repeat(43));
    code.dispatchEvent(new page.Event("input", { bubbles: true }));
  });
  await act(async () => code.closest("form")!.dispatchEvent(new page.Event("submit", { bubbles: true, cancelable: true })));
  expect(calls.filter(call => call.method === "POST").map(call => call.path)).toEqual(["/api/codex/desktop-compatibility/authorization"]);
  expect(button(container, "Register trust").disabled).toBe(!allowed);
  if (allowed) {
    expect(container.querySelector('input[type="password"]')).toBeNull();
    await chooseAndConfirm(container);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
  } else {
    expect(code.disabled).toBe(false); expect(container.querySelector('[role="alert"]')).not.toBeNull();
  }
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
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(requests.every(request => request.method === "GET")).toBe(true);
});
test("reauthorization refreshes fingerprint and revision without replaying old trust or consent", async () => {
  const calls: { path: string; method: string }[] = []; let authorized = false, fingerprint = "A", exchanged = false;
  globalThis.fetch = (async (input, init) => {
    const path = String(input), method = init?.method ?? "GET"; calls.push({ path, method });
    if (path.endsWith("/authorization")) {
      if (method === "POST") { authorized = true; fingerprint = "B"; exchanged = true; }
      return Response.json({ ok: true, supported: true, authorized });
    }
    if (path.endsWith("/settings")) return Response.json({ ok: true, settings: { startOnProxyStart: false, revision: (exchanged ? "b" : "a").repeat(64) } });
    if (path.endsWith("/certificate")) return Response.json({ ok: true, certificate: { supported: true, state: "prepared", busy: null, fingerprint: fingerprint.repeat(64) } });
    return Response.json({ ok: true, runtime: { supported: true, running: false, phase: "off" } });
  }) as typeof fetch;
  const container = await mount();
  expect(button(container, "Register trust").disabled).toBe(true);
  const code = container.querySelector('input[type="password"]') as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value")!.set!;
    setter.call(code, "ocx_pair_" + "A".repeat(43));
    code.dispatchEvent(new page.Event("input", { bubbles: true }));
    code.dispatchEvent(new page.Event("change", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new page.Event("submit", { bubbles: true, cancelable: true })));
  expect(calls.filter(call => call.method === "POST")).toEqual([{ path: "/api/codex/desktop-compatibility/authorization", method: "POST" }]);
  expect(container.textContent).toContain("B".repeat(64)); expect(container.querySelector("fieldset")).toBeNull();
  expect(button(container, "Register trust").disabled).toBe(false);
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
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("true");
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
  expect(toggle.disabled).toBe(false); expect(toggle.getAttribute("aria-checked")).toBe("true");
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
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-checked")).toBe("false");
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
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-checked")).toBe("false");
});

test("a shared-session change does not cancel an authorized machine settings operation", async () => {
  const io = await heldStartupSetting();
  await act(async () => io.install("shared"));
  expect(io.signal()?.aborted).toBe(false);
  io.save(); await act(async () => io.release(io.settings()));
  expect(io.sent.filter(request => request.method === "POST").map(request => request.token)).toEqual(["ocx_session_old"]);
  expect(io.toggle.disabled).toBe(false); expect(io.toggle.getAttribute("aria-checked")).toBe("true");
});
