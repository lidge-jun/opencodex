import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  apiBaseForPlane,
  discoverApiTargets,
  relayUrlForPath,
  standaloneApiTargets,
  targetsFromMachineStatus,
  type MachineStatusV1,
} from "../src/api-targets";

let win: Window;
let previousWindow: unknown;
let previousDocument: unknown;
let previousFetch: typeof fetch;

/**
 * Stand in for the runtime-role meta tag the server injects into the served document.
 * `null` means the server said nothing, which every reader must treat as standalone.
 */
function setRuntimeRole(role: string | null): void {
  const existing = win.document.querySelector('meta[name="opencodex-runtime-role"]');
  existing?.remove();
  if (role === null) return;
  const meta = win.document.createElement("meta");
  meta.setAttribute("name", "opencodex-runtime-role");
  meta.setAttribute("content", role);
  win.document.head.append(meta);
}

const status = (transport: "direct" | "relay"): MachineStatusV1 => ({
  mode: "client",
  connected: true,
  machineBase: "http://localhost",
  sharedBase: transport === "direct" ? "https://hub.example.test" : "http://localhost/api/machine/hub-relay",
  sharedServerOrigin: "https://hub.example.test",
  managementTransport: transport,
  apiKeyId: "client-key-a",
  protocolVersion: 1,
  connectedAt: "2026-08-28T00:00:00.000Z",
  catalogSyncedAt: "2026-08-28T00:05:00.000Z",
  hubReachability: "unknown",
});

beforeEach(() => {
  previousWindow = Reflect.get(globalThis, "window");
  previousDocument = Reflect.get(globalThis, "document");
  previousFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: win.document });
  // Most rows here exercise the connected path; the standalone rows set their own role.
  setRuntimeRole("client");
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
  win.close();
});

describe("two-plane API targets", () => {
  test("404 selects the unchanged standalone same-origin target", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const targets = await discoverApiTargets("");
    expect(targets).toEqual(standaloneApiTargets(""));
    expect(apiBaseForPlane("machine", targets)).toBe("");
    expect(apiBaseForPlane("shared", targets)).toBe("");
  });

  test("constructs exact direct and fixed relay shared bases", () => {
    const direct = targetsFromMachineStatus("", status("direct"));
    expect(direct.shared).toMatchObject({ baseUrl: "https://hub.example.test", serverOrigin: "https://hub.example.test", transport: "direct" });
    expect(direct.catalogSyncedAt).toBe("2026-08-28T00:05:00.000Z");
    const relay = targetsFromMachineStatus("", status("relay"));
    expect(relay.machine.baseUrl).toBe("");
    expect(relay.shared).toMatchObject({ baseUrl: "/api/machine/hub-relay", serverOrigin: "https://hub.example.test", transport: "relay" });
    expect(relayUrlForPath(relay.shared, "/api/usage?range=all")).toBe("/api/machine/hub-relay/api/usage?range=all");
    expect(() => relayUrlForPath(relay.shared, "/api/%2e%2e/config")).toThrow();
    expect(() => relayUrlForPath(relay.shared, "//evil.example/api/config")).toThrow();
  });

  test("a machine-status network failure is not treated as standalone", async () => {
    setRuntimeRole("client");
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await expect(discoverApiTargets("")).rejects.toThrow("local machine plane unavailable");
  });

  test("rejects a non-string catalog fetch timestamp", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ...status("direct"), catalogSyncedAt: 42 }), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(discoverApiTargets("")).rejects.toThrow("local machine plane returned invalid status");
  });

  test("standalone discovers nothing and sends no request", async () => {
    // The whole point of the runtime-role meta tag: a user who never enabled remote hub
    // must not have their browser probe a remote-hub endpoint. Discovery previously ran
    // unconditionally and inferred standalone from the resulting 404 — a request that
    // announced the feature's existence on every dashboard load.
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(null, { status: 404 }); }) as typeof fetch;

    for (const role of [null, "standalone", "hub"] as const) {
      calls = 0;
      setRuntimeRole(role);
      const targets = await discoverApiTargets("");
      expect(targets.connected).toBe(false);
      expect(targets).toEqual(standaloneApiTargets(""));
      expect(calls).toBe(0);
    }
  });

  test("a connected runtime still discovers", async () => {
    // The tag narrows who asks; it does not remove discovery for the role that needs it.
    setRuntimeRole("client");
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; return new Response(null, { status: 404 }); }) as typeof fetch;
    await discoverApiTargets("");
    expect(calls).toBe(1);
  });
});
