/**
 * `GET|PUT /api/fallback` (OCX-11): the ocx.fallback/1 view, scoped writes persisted under the
 * config mutation lock and mirrored into the live config, device validation, the passive read a
 * Remote Link Child gets, and the link relay allowlist (read yes, write no).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import { readConfigDiagnostics, saveConfig } from "../../src/config";
import { runPassiveRead } from "../../src/lib/passive-read";
import { linkManagementReadAllowed } from "../../src/link/management-routes";
import { writeLinkStore } from "../../src/link/store";
import { linkStorePath } from "../../src/link/paths";
import { clearFallbackEventsForTests, guardFallbackHop } from "../../src/routing/fallback-policy";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const LINK = "lnk_0123456789abcdef";
let home: TempHome;

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "alpha",
    apiKeys: [
      { id: "key_link", name: "link", key: "link-key", createdAt: new Date(0).toISOString() },
      { id: "key_hub", name: "hub", key: "hub-key", createdAt: new Date(0).toISOString() },
    ],
    providers: { alpha: { adapter: "openai-chat", baseUrl: "https://alpha.test/v1", models: ["m1"] } },
  } as OcxConfig;
}

async function call(c: OcxConfig, body?: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/fallback", {
    method: body === undefined ? "GET" : "PUT",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), host: "localhost" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handleManagementAPI(req, new URL(req.url), c, {
    saveConfigPreservingClaudeCode: () => {}, createManagementConvergeCodex: catalogConvergenceFactory(),
  });
  if (!response) throw new Error("route not handled");
  return response;
}

beforeEach(() => {
  home = createTempHome("ocx-fallback-routes-");
  clearFallbackEventsForTests();
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: 41000,
    links: [{ id: LINK, alias: "mac-studio", direction: "client-initiated", hostKeyFingerprint: null, tunnelPort: 41001, apiKeyId: "key_link", createdAt: "2026-10-22T00:00:00.000Z" }],
  });
});
afterEach(() => {
  clearFallbackEventsForTests();
  home.remove();
});

describe("GET /api/fallback", () => {
  test("an unconfigured Home reports every fallback on and lists its links with local fallback off", async () => {
    const response = await call(config());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schema: "ocx.fallback/1",
      global: { model: true, provider: true },
      providers: {},
      routes: {},
      devices: [{ id: LINK, kind: "link", alias: "mac-studio", localFallback: false, model: null, provider: null }],
      last: null,
      recent: [],
    });
  });

  test("a passive read (a Child over the link) omits link aliases and event device ids", async () => {
    const c = { ...config(), fallback: { devices: { key_hub: { model: false } } } } as OcxConfig;
    guardFallbackHop(c, { site: "combo", route: "combo/x", from: { provider: "a", model: "m" }, to: { provider: "a", model: "n" }, trigger: "rate_limited", admission: { kind: "configured", keyId: "key_hub" } });
    const body = await (await runPassiveRead(() => call(c))).json() as { devices: Array<Record<string, unknown>>; last: Record<string, unknown> };
    expect(body.devices.map(device => device.alias)).toEqual([undefined, undefined]);
    expect(body.last.deviceId).toBeUndefined();
    expect(body.last.outcome).toBe("refused");
  });

  test("the link relay may read the state and may not write it", () => {
    expect(linkManagementReadAllowed("GET", "/api/fallback")).toBe(true);
    expect(linkManagementReadAllowed("PUT", "/api/fallback")).toBe(false);
  });
});

describe("PUT /api/fallback", () => {
  test("scoped writes persist, mirror into the live config, and clear back to absent", async () => {
    const live = config();
    saveConfig(live);
    expect((await call(live, { scope: "global", setting: "provider", value: false })).status).toBe(200);
    expect((await call(live, { scope: "route", key: "combo/coding", setting: "provider", value: true })).status).toBe(200);
    expect((await call(live, { scope: "device", key: "mac-studio", setting: "localFallback", value: true })).status).toBe(200);
    const expected = { provider: false, routes: { "combo/coding": { provider: true } }, devices: { [LINK]: { localFallback: true } } };
    expect(live.fallback).toEqual(expected);
    expect(readConfigDiagnostics().config.fallback).toEqual(expected);
    const view = await (await call(live)).json() as { global: { provider: boolean }; devices: Array<{ localFallback: boolean }> };
    expect(view.global.provider).toBe(false);
    expect(view.devices[0]!.localFallback).toBe(true);
    for (const body of [
      { scope: "global", setting: "provider", value: null },
      { scope: "route", key: "combo/coding", setting: "provider", value: null },
      { scope: "device", key: LINK, setting: "localFallback", value: null },
    ]) expect((await call(live, body)).status).toBe(200);
    expect(live.fallback).toBeUndefined();
    expect(readConfigDiagnostics().config.fallback).toBeUndefined();
  });

  test("a Hub data key id is a device; an unknown device and malformed bodies are refused", async () => {
    const live = config();
    saveConfig(live);
    expect((await call(live, { scope: "device", key: "key_hub", setting: "model", value: false })).status).toBe(200);
    expect(live.fallback?.devices?.key_hub).toEqual({ model: false });
    expect((await call(live, { scope: "device", key: "nobody", setting: "model", value: false })).status).toBe(404);
    // Clearing a device that is gone (a revoked link keeps its entry) is allowed and removes it.
    live.fallback = { devices: { lnk_fedcba9876543210: { model: false }, key_hub: { model: false } } };
    saveConfig(live);
    expect((await call(live, { scope: "device", key: "lnk_fedcba9876543210", setting: "model", value: null })).status).toBe(200);
    expect(live.fallback).toEqual({ devices: { key_hub: { model: false } } });
    expect(readConfigDiagnostics().config.fallback).toEqual({ devices: { key_hub: { model: false } } });
    for (const body of [
      { scope: "global", setting: "localFallback", value: true },
      { scope: "provider", setting: "model", value: false },
      { scope: "route", key: "has space", setting: "model", value: false },
      { scope: "global", setting: "account", value: false },
      { scope: "global", setting: "model", value: "off" },
      { writes: [] },
      { writes: [{ scope: "global", setting: "model", value: false }, { scope: "global", setting: "bogus", value: false }] },
    ]) expect((await call(live, body)).status).toBe(400);
    // A refused batch writes nothing.
    expect(live.fallback?.model).toBeUndefined();
  });

  test("a batch applies every write in one mutation, and an unknown device refuses the whole batch", async () => {
    const live = config();
    saveConfig(live);
    expect((await call(live, { writes: [
      { scope: "device", key: "mac-studio", setting: "model", value: false },
      { scope: "device", key: "mac-studio", setting: "provider", value: false },
    ] })).status).toBe(200);
    expect(live.fallback).toEqual({ devices: { [LINK]: { model: false, provider: false } } });
    expect((await call(live, { writes: [
      { scope: "global", setting: "model", value: false },
      { scope: "device", key: "nobody", setting: "model", value: false },
    ] })).status).toBe(404);
    expect(readConfigDiagnostics().config.fallback).toEqual({ devices: { [LINK]: { model: false, provider: false } } });
  });
});
