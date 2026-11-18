import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { resetApiAuthFetchForTests, SESSION_CHANGED_EVENT } from "../src/api";

// `/classic/` is a partial overlay: `gui/classic/src` wins for a file it holds and every other
// relative import resolves inside `gui/src`, exactly as vite.classic.config.ts decides it. The page
// is resolved through that overlay here; importing either edition's file directly would prove
// nothing about the bundle the proxy serves at /classic/.
const CLASSIC_ROOT = join(import.meta.dir, "../classic/src");
const SHARED_ROOT = join(import.meta.dir, "../src");
Bun.plugin({
  name: "classic-overlay-for-tests",
  setup(build) {
    build.onLoad({ filter: /gui[\\/]classic[\\/]src[\\/].*\.tsx$/ }, ({ path }) => {
      const contents = readFileSync(path, "utf8").replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_match, prefix: string, specifier: string, quote: string) => {
        const shared = join(SHARED_ROOT, path.slice(CLASSIC_ROOT.length + 1), "..", specifier);
        for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
          const candidate = shared + suffix;
          const classic = join(CLASSIC_ROOT, candidate.slice(SHARED_ROOT.length + 1));
          if (existsSync(classic)) return prefix + classic.replaceAll("\\", "/") + quote;
          if (existsSync(candidate)) return prefix + candidate.replaceAll("\\", "/") + quote;
        }
        throw new Error(`Cannot resolve classic import ${specifier} from ${path}`);
      });
      return { contents, loader: "tsx" };
    });
  },
});

const CodexDesktopCompatibility = (await import("../classic/src/pages/codex-desktop-compatibility")).default;
const keys = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT", "__APP_VERSION__"] as const;
let previous: Record<string, unknown>, page: Window, root: Root | undefined;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  clearClientResourceStoresForTests(); resetApiAuthFetchForTests();
  previous = Object.fromEntries(keys.map(key => [key, Reflect.get(globalThis, key)]));
  page = new Window({ url: "http://localhost/classic/#codex-set/desktop" });
  page.localStorage.setItem("ocx-lang", "en");
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : key === "__APP_VERSION__" ? "0.0.0-test" : Reflect.get(page, key) });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined;
  resetApiAuthFetchForTests(); clearClientResourceStoresForTests();
  globalThis.fetch = originalFetch; page.close();
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
});

type Call = { path: string; method: string; body?: unknown };
// Shaped like a real Desktop grant; never a real credential and never exchanged with a server.
const GRANT = "ocx_pair_" + "A".repeat(43);

/**
 * The management server this page must talk to after #8427: Desktop mutation authority comes from a
 * one-use grant spent through POST /authorization, and every certificate/runtime/settings mutation
 * answers 403 desktop_authorization_required until that scope exists. No fixture performs real OS
 * trust work: the certificate state is a JSON field, not a trusted root.
 */
function desktopServer(options: { supported?: boolean; rememberedSession?: boolean; authorize?: boolean; expireAfterAuthorize?: boolean; refuseSettingsWrite?: boolean; refuseCertificateAction?: boolean } = {}) {
  const calls: Call[] = [];
  let scoped = false, trusted = false, spent = false;
  const authorize = options.authorize ?? true;
  const denied = () => Response.json({ error: "desktop_authorization_required" }, { status: 403 });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), page.location.href).pathname, method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/desktop-compatibility/authorization")) {
      if (method === "GET") return Response.json({ ok: true, supported: options.supported ?? true, authorized: scoped, rememberedSession: options.rememberedSession ?? false });
      const grant = (JSON.parse(String(init!.body)) as { grant?: unknown }).grant;
      // The server accepts only an unspent Desktop grant. The client must never report success
      // from its own optimism, so both a wrong code and a replay answer 403.
      if (grant !== GRANT || spent || !authorize) return denied();
      spent = true; scoped = !options.expireAfterAuthorize; return Response.json({ ok: true, authorized: true });
    }
    if (path.endsWith("/desktop-compatibility/settings")) {
      // A settings write is a Desktop mutation too, so it answers the same 403 once the scope is
      // gone; the panel must not keep offering the switch against that refusal.
      if (method === "POST") {
        if (!scoped) return denied();
        if (options.refuseSettingsWrite) { scoped = false; return denied(); }
        return Response.json({ ok: true, settings: { startOnProxyStart: true, revision: "b".repeat(64) } });
      }
      return Response.json({ ok: true, settings: { startOnProxyStart: false, revision: "a".repeat(64) } });
    }
    if (method === "POST") {
      if (!scoped) return denied();
      if (options.refuseCertificateAction) { scoped = false; return denied(); }
      trusted = (JSON.parse(String(init!.body)) as { action?: string }).action === "trust"; return Response.json({ ok: true });
    }
    if (path.endsWith("/desktop-compatibility/certificate")) return Response.json({ ok: true,
      certificate: { supported: true, mutationAuthorized: scoped, state: trusted ? "trusted" : "prepared", busy: null, fingerprint: "B".repeat(64) } });
    return Response.json({ ok: true, runtime: { supported: true, running: false, phase: "off" } });
  }) as typeof fetch;
  return { calls, spent: () => spent };
}
const posts = (calls: Call[]) => calls.filter(call => call.method === "POST");
function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(node => node.textContent === text);
  if (!found) throw new Error("Missing button: " + text);
  return found;
}
/** Fails as a contract violation, not a null dereference, when the page has no step-up at all. */
function stepUpInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="password"]');
  if (!input) throw new Error("the classic /classic/ page does not offer the Desktop one-use grant step-up");
  return input as HTMLInputElement;
}
function alerts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[role="alert"]')].map(node => node.textContent ?? "");
}
async function mount() {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root!.render(<StrictMode><LanguageProvider><CodexDesktopCompatibility apiBase="" active /></LanguageProvider></StrictMode>); });
  return container;
}
async function paste(container: HTMLElement, value: string) {
  const input = stepUpInput(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(page.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new page.Event("input", { bubbles: true }));
  });
  return input;
}
async function submit(container: HTMLElement) {
  const form = container.querySelector("form");
  if (!form) throw new Error("the classic /classic/ page has no step-up form to submit");
  await act(async () => { form.dispatchEvent(new page.Event("submit", { bubbles: true, cancelable: true })); });
}
async function armTrust(container: HTMLElement) {
  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  await act(async () => button(container, "Confirm action").click());
}

test("the classic overlay gives remembered sessions private-window recovery", async () => {
  const server = desktopServer({ rememberedSession: true });
  const container = await mount();
  expect(container.textContent).toContain("private browser window");
  expect(container.textContent).not.toContain("ocx gui pair --desktop --origin");
  expect(posts(server.calls)).toHaveLength(0);
});

test("the classic overlay offers the Desktop step-up and a consumed grant enables a trust mutation", async () => {
  const server = desktopServer();
  const container = await mount();

  // A plain pairing form is dead weight here: it mints an ordinary session, which #8427's server
  // refuses for Desktop mutation. /classic/ must ask for the one-use Desktop code.
  expect(container.textContent).toContain("ocx gui pair --desktop --origin");
  expect(container.textContent).not.toContain("ocx gui pair --origin");
  stepUpInput(container);
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(posts(server.calls)).toHaveLength(0);

  await paste(container, GRANT);
  await submit(container);
  await armTrust(container);

  // Authorization first, then the mutation the operator actually asked for — no local optimism
  // and no replayed earlier action.
  expect(posts(server.calls)[0]).toMatchObject({ path: "/api/codex/desktop-compatibility/authorization", body: { grant: GRANT } });
  expect(server.spent()).toBe(true);
  expect(posts(server.calls).at(-1)).toMatchObject({ path: "/api/codex/desktop-compatibility/certificate",
    body: { action: "trust", confirmed: true, fingerprint: "B".repeat(64) } });
  expect(posts(server.calls)).toHaveLength(2);
  expect(container.textContent).toContain("Desktop actions are temporarily authorized for this session.");
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

test("a refused grant leaves every Desktop mutation disabled and the code field usable", async () => {
  const server = desktopServer({ authorize: false });
  const container = await mount();
  await paste(container, GRANT);
  await submit(container);

  expect(posts(server.calls).map(call => call.path)).toEqual(["/api/codex/desktop-compatibility/authorization"]);
  expect(server.spent()).toBe(false);
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
  expect(alerts(container).some(text => text.includes("desktop_authorization_required"))).toBe(true);
  expect(stepUpInput(container).disabled).toBe(false);
});

test("a spent grant is not replayed, and a lost step-up drops the armed confirmation", async () => {
  const server = desktopServer();
  const container = await mount();
  await paste(container, GRANT);
  await submit(container);
  await armTrust(container);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  const exchanges = () => server.calls.filter(call => call.path.endsWith("/desktop-compatibility/authorization") && call.method === "POST").length;
  expect(exchanges()).toBe(1);

  // Arm a confirmation, then lose the step-up: the panel must drop the checkbox rather than
  // leave a click path that would submit consent the session no longer holds.
  await act(async () => button(container, "Remove trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  expect(button(container, "Confirm action").disabled).toBe(false);
  await act(async () => page.dispatchEvent(new page.CustomEvent(SESSION_CHANGED_EVENT, { detail: { plane: "machine" } })));
  expect(container.querySelector("fieldset")).toBeNull();
  stepUpInput(container);
  expect(button(container, "Remove trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);

  // Pasting the consumed code again must reach the server exactly once more and be refused;
  // the page must not turn its own hope into local consent.
  const before = posts(server.calls).length;
  await paste(container, GRANT);
  await submit(container);
  expect(posts(server.calls)).toHaveLength(before + 1);
  expect(server.spent()).toBe(true);
  expect(alerts(container).some(text => text.includes("desktop_authorization_required"))).toBe(true);
  expect(button(container, "Remove trust").disabled).toBe(true);
  expect(exchanges()).toBe(2);
});

test("authority that expired between the step-up and the mutation reopens the step-up instead of faking consent", async () => {
  const server = desktopServer({ expireAfterAuthorize: true });
  const container = await mount();
  await paste(container, GRANT);
  await submit(container);

  // The grant was spent, so the form closes — but the status read the client does itself says
  // the scope is gone, so no mutation button may be armed on the strength of the POST alone.
  expect(server.spent()).toBe(true);
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(stepUpInput(container).disabled).toBe(false);
  expect(alerts(container).some(text => text.includes("desktop_authorization_required"))).toBe(true);

  // Mutating anyway must reach no server and keep no local authority.
  const before = posts(server.calls).length;
  await act(async () => button(container, "Register trust").click());
  expect(posts(server.calls)).toHaveLength(before);
  expect(container.querySelector("fieldset")).toBeNull();
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
});

test("a settings write refused for a stale step-up drops the panel's authority and does not claim success", async () => {
  const server = desktopServer({ refuseSettingsWrite: true });
  const container = await mount();
  await paste(container, GRANT);
  await submit(container);
  expect(button(container, "Register trust").disabled).toBe(false);

  // The scope is valid on the read, but the write is refused: the panel must treat that as lost
  // authority rather than a one-off error next to a still-enabled switch.
  const toggle = button(container, "Resume observation when OpenCodex starts");
  await act(async () => toggle.click());
  const refused = posts(server.calls).filter(call => call.path.endsWith("/desktop-compatibility/settings"));
  expect(refused).toHaveLength(1);
  expect(toggle.disabled).toBe(true);
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(stepUpInput(container).disabled).toBe(false);
  expect(alerts(container).some(text => text.includes("desktop_authorization_required"))).toBe(true);
});

test("a certificate mutation refused at confirmation drops the consent and the authority", async () => {
  const server = desktopServer({ refuseCertificateAction: true });
  const container = await mount();
  await paste(container, GRANT);
  await submit(container);

  await act(async () => button(container, "Register trust").click());
  await act(async () => (container.querySelector("input[type=checkbox]") as HTMLInputElement).click());
  expect(button(container, "Confirm action").disabled).toBe(false);
  await act(async () => button(container, "Confirm action").click());

  // The scope was spent between the read and the confirm: the refusal has to close the checkbox,
  // disable the actions and reopen the step-up, never leave the confirmation armed.
  expect(posts(server.calls).map(call => call.path)).toEqual(["/api/codex/desktop-compatibility/authorization",
    "/api/codex/desktop-compatibility/certificate"]);
  expect(container.querySelector("fieldset")).toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(button(container, "Resume observation when OpenCodex starts").disabled).toBe(true);
  expect(stepUpInput(container).disabled).toBe(false);
  expect(alerts(container).some(text => text.includes("desktop_authorization_required"))).toBe(true);
});


test("unsupported authorization explains a possible local bind recovery without offering a grant", async () => {
  const server = desktopServer({ supported: false });
  const container = await mount();
  expect(container.textContent).toContain("hostname as the literal loopback address");
  expect(container.textContent).toContain("non-loopback address such as 0.0.0.0");
  expect(container.textContent).toContain("Forwarding, a different role or port, and the current session");
  expect(container.textContent).toContain("Restart the proxy");
  expect(container.textContent).not.toContain("ocx gui pair --desktop --origin");
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(button(container, "Register trust").disabled).toBe(true);
  expect(posts(server.calls)).toHaveLength(0);
});
