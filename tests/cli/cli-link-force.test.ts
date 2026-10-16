import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { LinkStore } from "../../src/link/store";
import type { OcxConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const ID = "lnk_0123456789abcdef";
const RECOVERY = "Run ocx disconnect on the remote client.";
const nativeFetch = globalThis.fetch;
let home: TempHome;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-cli-link-force-");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});
function fixture(body: unknown = { linkId: ID }, status = 200) {
  let discoveries = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  const deps: LinkCliDeps = {
    findLiveProxy: async () => { discoveries++; return { pid: null, port: 15100, source: "runtime" }; },
    readAdminToken: () => "fixture-admin-token",
    fetchImpl: async (input, init) => { calls.push({ url: String(input), init }); return Response.json(body, { status }); },
  };
  return { calls, deps, discoveries: () => discoveries };
}
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));
const invoke = (args: string[], deps: LinkCliDeps) => runLinkCommand(["revoke", "--link-id", ID, ...args], deps);

describe("explicit forced link revoke", () => {
  test.each([["--force"], ["--yes"], ["--force", "--yes", "--force"], ["--force", "--yes", "--yes"], ["--force=true", "--yes"]])(
    "invalid confirmation flags cause no discovery: %j", async (...args) => {
      const f = fixture();
      expect(await invoke(args, f.deps)).toBe(2);
      expect(f.discoveries()).toBe(0); expect(f.calls).toEqual([]); expect(output).not.toHaveBeenCalled();
    },
  );
  test("force sends only the explicit boolean, refuses redirects and derives skipped cleanup", async () => {
    const f = fixture();
    expect(await invoke(["--force", "--yes", "--json"], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.discoveries()).toBe(1);
    expect(f.calls[0]?.url).toBe(`http://127.0.0.1:15100/api/link/${ID}`);
    expect(f.calls[0]?.init?.method).toBe("DELETE"); expect(f.calls[0]?.init?.redirect).toBe("error");
    expect(JSON.parse(String(f.calls[0]?.init?.body))).toEqual({ force: true });
    expect(new Headers(f.calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(json()).toEqual({ linkId: ID, remoteCleanup: "skipped", recovery: RECOVERY });
    expect(errors).not.toHaveBeenCalled();
  });
  test.each([{}, null, [], { linkId: "lnk_fedcba9876543210" }, { linkId: ID, remoteCleanup: "private-canary" }])(
    "invalid forced receipt cannot claim completion", async response => {
      const f = fixture(response);
      expect(await invoke(["--force", "--yes", "--json"], f.deps)).toBe(1);
      expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("private-canary");
    },
  );
  test.each([true, false])("missing link reports unverified cleanup, json=%s", async wantsJson => {
    const f = fixture({ error: { code: "link_not_found", message: "private-canary" } }, 404);
    expect(await invoke(["--force", "--yes", ...(wantsJson ? ["--json"] : [])], f.deps)).toBe(0);
    if (wantsJson) expect(json()).toEqual({ linkId: ID, remoteCleanup: "unverified", recovery: RECOVERY });
    else {
      expect(output.mock.calls.flat().join("\n")).toBe(`Link ${ID} is already absent; remote cleanup is unverified.\n${RECOVERY}`);
    }
    expect(errors).not.toHaveBeenCalled();
  });
  test("human force output names skipped cleanup and recovery, never a failed remote attempt", async () => {
    const f = fixture();
    expect(await invoke(["--force", "--yes"], f.deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toBe(`Revoked ${ID}; remote cleanup was skipped.\n${RECOVERY}`);
  });
  test.each([{ linkId: ID }, null])("ordinary revoke retains no body and JSON output without force fields", async response => {
    const f = fixture(response);
    expect(await invoke([], f.deps)).toBe(0);
    expect(f.calls[0]?.init?.body).toBeUndefined(); expect(json()).toEqual({ linkId: ID });
  });
  test.each([401, 403, 404, 409, 502, 503])("HTTP %d retains error mapping and does not leak error bodies", async status => {
    const f = fixture({ error: { code: "remote_disconnect_failed", message: "private-canary", hint: "private-canary" } }, status);
    const expected = status === 404 ? 4 : status === 409 ? 5 : 1;
    expect(await invoke(["--force", "--yes", "--json"], f.deps)).toBe(expected);
    expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("private-canary");
  });
  test("unexpected transport exception stays private", async () => {
    const f = fixture();
    f.deps.readAdminToken = () => { throw new Error("private-canary"); };
    expect(await invoke(["--force", "--yes"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("private-canary");
  });
  test("real owner force removes only local link/key without an SSH attempt; retry is unverified", async () => {
    const cfg: OcxConfig = { port: 15100, defaultProvider: "fixture", providers: {}, runtimeRole: "hub", apiKeys: [] };
    let store: LinkStore = { version: 1, listenerPort: 18181, links: [{ id: ID, alias: "fixture-peer", direction: "hub-initiated",
      tunnelPort: 19200, apiKeyId: "fixture-key", createdAt: "2026-10-01T00:00:00.000Z" }] };
    const events: string[] = [];
    const owner: ManagementApiDeps = {
      readLinkStore: () => store, writeLinkStore: next => { store = next; events.push("store"); },
      revokeApiKey: (_cfg, id) => { expect(id).toBe("fixture-key"); events.push("revoke"); return true; },
      linkKnownHostsPath: () => home.path("known_hosts"),
      linkSupervisor: () => ({ start() {}, ensureStarted: async () => {}, reload: async () => {}, stop: async () => {},
        stopLink: async id => { expect(id).toBe(ID); events.push("stop"); }, status: () => [] }),
      linkListener: () => ({ ensureStarted: async () => {}, status: () => ({ state: "listening", port: 18181, reason: null }),
        close: async () => { events.push("close"); }, onAuthenticatedCatalog: () => () => {} }),
      sshRunner: { run: async () => { throw new Error("Unexpected SSH attempt"); }, spawnTunnel: () => { throw new Error("Unexpected SSH spawn"); } },
    };
    const requests: string[] = [];
    const deps: LinkCliDeps = { baseUrl: "http://127.0.0.1:15100", readAdminToken: () => "fixture-admin-token", fetchImpl: async (input, init) => {
      const url = new URL(String(input)); requests.push(`${init?.method} ${url.pathname}`);
      const result = await handleManagementAPI(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host } }), url, cfg, owner, "admin-token", undefined, { trustedLoopback: true });
      if (!result) throw new Error("Unexpected route"); return result;
    } };
    expect(await invoke(["--force", "--yes", "--json"], deps)).toBe(0);
    expect(json()).toEqual({ linkId: ID, remoteCleanup: "skipped", recovery: RECOVERY });
    expect(store.links).toEqual([]); expect(events).toEqual(["stop", "revoke", "store", "close"]);
    output.mockClear();
    expect(await invoke(["--force", "--yes", "--json"], deps)).toBe(0);
    expect(json().remoteCleanup).toBe("unverified");
    expect(events).toEqual(["stop", "revoke", "store", "close"]);
    expect(requests).toEqual([`DELETE /api/link/${ID}`, `DELETE /api/link/${ID}`]);
  });
  test("redirect refuses before reaching another owned loopback endpoint", async () => {
    let first = 0, second = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { second++; return Response.json({ linkId: ID }); } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { first++; return Response.redirect(destination.url, 307); } });
    try {
      expect(await invoke(["--force", "--yes", "--json"], {
        baseUrl: origin.url.origin, readAdminToken: () => "fixture-admin-token", fetchImpl: nativeFetch,
      })).toBe(1);
      expect(first).toBe(1); expect(second).toBe(0); expect(output).not.toHaveBeenCalled();
    } finally { await origin.stop(true); await destination.stop(true); }
  });
});
