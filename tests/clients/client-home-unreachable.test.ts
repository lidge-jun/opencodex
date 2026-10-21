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
import { LINK_RELAY_AUTH_FAILED_CODE, relayLinkDataRequest } from "../../src/client/link-relay";
import { LinkRelayAuthenticationError } from "../../src/client/link-relay-transport";
import { HOME_UNREACHABLE_CODE, HOME_UNREACHABLE_MESSAGE } from "../../src/client/home-unreachable";

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
      new Request("http://127.0.0.1:10100/api/machine/hub-relay/api/fallback"),
      "/api/fallback",
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

  test("a failed relay authentication is not home_unreachable, so it never reads as Home down", async () => {
    for (const unrecognized of [false, true]) {
      const response = await relayLinkDataRequest(new Request("http://127.0.0.1:10100/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", input: "hello" }),
      }), { tunnelPort: 41001, admissionKey: "fixture-link-key", linkId: "lnk_0123456789abcdef", apiKeyId: "key_link" }, {
        tunnel: { connected: () => true, pending: () => false, waitForConnected: async () => true },
        fetchImpl: (async () => { throw new LinkRelayAuthenticationError(unrecognized); }) as unknown as typeof fetch,
      });
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string; code: string; message?: string };
      expect(body.code).toBe(LINK_RELAY_AUTH_FAILED_CODE);
      expect(body.code).not.toBe(HOME_UNREACHABLE_CODE);
      expect(body.message).toBeUndefined();
      expect(body.error).toBe(new LinkRelayAuthenticationError(unrecognized).message);
    }
  });
});
