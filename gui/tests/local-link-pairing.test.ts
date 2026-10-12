import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { configureApiTargets, installApiAuthFetch, installApiSessionFromHtml, resetApiAuthFetchForTests } from "../src/api";
import type { ApiTargets } from "../src/api-targets";

const origin = "http://127.0.0.1:10100";
function sessionHtml(token: string, serverOrigin = origin): string {
  return `<meta name="opencodex-session-token" content="${token}"><meta name="opencodex-session-csrf" content="${token}-csrf"><meta name="opencodex-session-origin" content="${origin}"><meta name="opencodex-session-server-origin" content="${serverOrigin}">`;
}

// TRANSPORT_REGRESSIONS_BEGIN
for (const relay of [false, true]) test(`pairing omits stale shared authentication and preserves the machine boundary (relay: ${relay})`, async () => {
  const keys = ["window", "document", "sessionStorage"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin });
  const sent: Headers[] = [];
  const rawFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: rawFetch, writable: true });
  const targets: ApiTargets = { connected: relay,
    machine: { id: "machine", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
    shared: { id: "shared", baseUrl: relay ? "/api/machine/hub-relay" : "", serverOrigin: relay ? "https://hub.example.test" : origin,
      bootstrapPath: relay ? "/api/machine/hub-relay/opencodex-session" : "/opencodex-session", transport: relay ? "relay" : "same-origin" },
  };
  try {
    resetApiAuthFetchForTests(); configureApiTargets(targets); installApiAuthFetch();
    expect(installApiSessionFromHtml("machine", sessionHtml("ocx_session_machine"))).toBe(true);
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_old", targets.shared.serverOrigin))).toBe(true);
    await win.fetch(targets.shared.bootstrapPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant: `ocx_pair_${"a".repeat(43)}` }) });
    expect(sent[0]!.get("x-opencodex-api-key")).toBeNull();
    expect(sent[0]!.get("x-opencodex-gui-origin")).toBeNull();
    expect(sent[0]!.get("x-opencodex-csrf-token")).toBeNull();
    expect(sent[0]!.get("x-opencodex-machine-session")).toBe(relay ? "ocx_session_machine" : null);
    expect(sent[0]!.get("x-opencodex-machine-csrf-token")).toBe(relay ? "ocx_session_machine-csrf" : null);
    await win.fetch(`${targets.shared.baseUrl}/api/link/join`, { method: "POST" });
    expect(sent[1]!.get("x-opencodex-api-key")).toBe("ocx_session_old");
    expect(sent[1]!.get("x-opencodex-csrf-token")).toBe("ocx_session_old-csrf");
    // Explicit mixed credentials are not silently stripped: the server still refuses them.
    await win.fetch(targets.shared.bootstrapPath, { method: "POST", headers: { authorization: "Bearer explicit" } });
    expect(sent[2]!.get("authorization")).toBe("Bearer explicit");
    // A successful exchange installs the returned session without reloading into an unpaired bootstrap.
    expect(installApiSessionFromHtml("shared", sessionHtml("ocx_session_paired", targets.shared.serverOrigin))).toBe(true);
    await win.fetch(`${targets.shared.baseUrl}/api/link/status`);
    expect(sent[3]!.get("x-opencodex-api-key")).toBe("ocx_session_paired");
  } finally {
    resetApiAuthFetchForTests(); win.close();
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
// TRANSPORT_REGRESSIONS_END

test("local pairing form names the local origin, makes no automatic exchange, and waits for explicit submission", async () => {
  const keys = ["window", "document", "navigator", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const win = new Window({ url: origin });
  let requests = 0;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: win }, document: { configurable: true, value: win.document },
    navigator: { configurable: true, value: win.navigator }, sessionStorage: { configurable: true, value: win.sessionStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  Object.defineProperty(win, "fetch", { configurable: true, value: async () => { requests++; return new Response(null, { status: 403 }); } });
  const container = document.createElement("div"); document.body.append(container);
  const { LanguageProvider } = await import("../src/i18n/provider");
  const { ConnectPairingForm } = await import("../src/connect-pairing");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(LanguageProvider, null, createElement(ConnectPairingForm, {
      local: true, target: { id: "shared", baseUrl: "", serverOrigin: origin, bootstrapPath: "/opencodex-session", transport: "same-origin" },
      onConnected: () => { throw new Error("unexpected success"); },
    }))));
    expect(container.textContent).toContain(`ocx gui pair --origin "${origin}"`);
    expect(container.textContent).not.toContain("Connect this dashboard to the hub");
    expect(requests).toBe(0);
    expect((container.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
    const input = container.querySelector("#connect-pairing-code") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(input, `ocx_pair_${"a".repeat(43)}`);
    await act(async () => { input.dispatchEvent(new win.Event("input", { bubbles: true })); });
    await act(async () => { input.closest("form")!.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests).toBe(1);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); container.remove(); win.close();
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
