/**
 * OCX-11 Home-down contract on a Remote Link Child and a Hub client.
 *
 * The client runtime that serves both has no provider dispatch, so "never serve from local
 * providers while the Home is unreachable" is structural. This file pins that structure (no
 * load-time path from the client runtime to provider, adapter or Responses dispatch code) and
 * the stable `home_unreachable` answers the relays give instead.
 */
import { describe, expect, test } from "bun:test";
import { firstLoadTimePathTo } from "../helpers/import-graph";
import { relayHubManagementRequest } from "../../src/client/hub-relay";
import { HOME_INITIATED_LINK_TUNNEL, LINK_RELAY_AUTH_FAILED_CODE, relayLinkDataRequest } from "../../src/client/link-relay";
import { LinkRelayAuthenticationError } from "../../src/client/link-relay-transport";
import { HOME_UNREACHABLE_CODE, HOME_UNREACHABLE_MESSAGE } from "../../src/client/home-unreachable";
import { LINK_RELAY_AUTH_PATH } from "../../src/link/relay-auth";

// The modules that turn a request into an upstream send: Responses dispatch, the router and
// adapter construction. Config schemas, provider metadata and the combo catalog projection the
// Child's catalog sync reads are shared and are not a serving path.
const LOCAL_SERVING = /\/src\/server\/responses\/|\/src\/router\.ts$|\/src\/server\/adapter-resolve\.ts$/;

describe("a Child or Hub client cannot serve from local providers", () => {
  for (const entry of ["src/client/runtime.ts", "src/client/machine-listener.ts", "src/client/link-relay.ts"]) {
    test(entry + " has no load-time path to provider dispatch", () => {
      expect(firstLoadTimePathTo(entry, path => LOCAL_SERVING.test(path))).toBeNull();
    });
  }
  test("control: the standalone server does reach provider dispatch, so the walk is not vacuous", () => {
    expect(firstLoadTimePathTo("src/server/index.ts", path => LOCAL_SERVING.test(path))).not.toBeNull();
  });
  test("route-intent transport and receipt helpers do not eagerly load device writers", () => {
    const writers = /\/src\/client\/route-intent-apply\.ts$|\/src\/integrations\/route-intent\.ts$/;
    for (const entry of ["src/integrations/route-intent-connected.ts", "src/integrations/route-intent-disconnect.ts"]) {
      expect(firstLoadTimePathTo(entry, path => writers.test(path))).toBeNull();
    }
  });
});

describe("home_unreachable answers", () => {
  test("a Child whose tunnel is down answers a retryable 503 and sends nothing", async () => {
    let sends = 0;
    const response = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "hello" }),
    }), { tunnelPort: 41001, admissionKey: "fixture-link-key", linkId: "lnk_0123456789abcdef", apiKeyId: "key_link" }, {
      fetchImpl: (async () => { sends += 1; return new Response(); }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(await response.json()).toEqual({ error: "link tunnel unavailable", code: HOME_UNREACHABLE_CODE, message: HOME_UNREACHABLE_MESSAGE });
    expect(sends).toBe(0);
  });

  test("a Hub client's relay keeps its 502 and adds the stable code when the Hub does not answer", async () => {
    const response = await relayHubManagementRequest(
      new Request("http://127.0.0.1:10100/api/machine/hub-relay/api/provider-quotas"),
      "/api/provider-quotas",
      { managementUrl: "https://hub.example.test", browserOrigin: "http://127.0.0.1:10100" },
      { fetchImpl: (async () => { throw new TypeError("connect ECONNREFUSED"); }) as unknown as typeof fetch },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "hub relay unavailable", code: HOME_UNREACHABLE_CODE, message: HOME_UNREACHABLE_MESSAGE });
  });

  test("the message says nothing was served locally and where local fallback is decided", () => {
    expect(HOME_UNREACHABLE_MESSAGE).toContain("did not serve this request from this device's local providers");
    expect(HOME_UNREACHABLE_MESSAGE).toContain("ocx fallback local on --device");
  });

  const linkTarget = { tunnelPort: 41001, admissionKey: "fixture-link-key", linkId: "lnk_0123456789abcdef", apiKeyId: "key_link" };
  const linkTurn = () => new Request("http://127.0.0.1:10100/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hello" }),
  });

  test.each([
    { status: 204, error: "link relay authentication failed" },
    { status: 404, error: "link relay authentication unavailable; upgrade the Home and Child or re-link" },
  ])("a failed challenge with peer status $status answers with link_relay_auth_failed", async ({ status, error }) => {
    const requests: Array<{ path: string; method: string; hasAuthorization: boolean; hasBody: boolean }> = [];
    const peer = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          method: request.method,
          hasAuthorization: request.headers.has("authorization"),
          hasBody: request.body !== null,
        });
        return new Response(null, { status });
      },
    });
    try {
      const response = await relayLinkDataRequest(linkTurn(), { ...linkTarget, tunnelPort: peer.port! }, {
        tunnel: HOME_INITIATED_LINK_TUNNEL,
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).not.toBeNull();
      const body = await response.json() as { error: string; code: string; message?: string };
      expect(body.code).toBe(LINK_RELAY_AUTH_FAILED_CODE);
      expect(body.code).not.toBe(HOME_UNREACHABLE_CODE);
      expect(body.message).toBeUndefined();
      expect(body.error).toBe(error);
      expect(requests).toEqual([{ path: LINK_RELAY_AUTH_PATH, method: "GET", hasAuthorization: false, hasBody: false }]);
    } finally {
      await peer.stop(true);
    }
  });

  test("an authentication error after data dispatch answers with a terminal replay refusal", async () => {
    const response = await relayLinkDataRequest(linkTurn(), linkTarget, {
      tunnel: HOME_INITIATED_LINK_TUNNEL,
      // The complete-send seam models an authentication error from the data phase.
      fetchImpl: (async () => { throw new LinkRelayAuthenticationError(); }) as unknown as typeof fetch,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.get("retry-after")).toBeNull();
    const body = await response.json() as { error: { code: string }; code?: string };
    expect(body.error.code).toBe("upstream_reset_replay_refused");
    expect(body.code).not.toBe(HOME_UNREACHABLE_CODE);
  });
});
