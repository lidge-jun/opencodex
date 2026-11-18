import { expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { handleRouteToRoutes } from "../../src/server/management/route-to-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { unlinkSync } from "node:fs";
import { getConfigPath } from "../../src/config";
import { resolveApiSurfaceSettings } from "../../src/protocols/settings";

test("materialization cannot revert concurrent Claude settings or an explicit Messages denial", async () => {
  const home = createTempHome("route-live-concurrency-");
  try {
    const live = getDefaultConfig(); live.port = 18274;
    live.claudeCode = { enabled: true, authMode: "auto", blockedSkills: ["before"] };
    live.apiSurfaces = { messages: { enabled: true } };
    saveConfig(live);
    const req = new Request("http://localhost/api/route-to", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "claude", action: "off" }) });
    const ctx = { req, url: new URL(req.url), config: live, version: "1", deps: { readLinkStore: () => ({ version: 1, listenerPort: null, links: [] }) } } as ManagementContext;
    const response = await handleRouteToRoutes(ctx, { materializeHome: async snapshot => {
      // The controller captured this subtree before its asynchronous model work.
      snapshot.claudeCode = { ...snapshot.claudeCode, enabled: false };
      snapshot.apiSurfaces = { messages: { enabled: true } };
      await Promise.resolve();
      // Another authenticated settings operation commits while it is awaiting I/O.
      live.claudeCode = { ...live.claudeCode, enabled: false, authMode: "subscription", blockedSkills: ["after"] };
      live.apiSurfaces = { messages: { enabled: false } };
      saveConfig(live);
      return [{ client: "claude", outcome: "current" }];
    } });
    expect(response?.status).toBe(200);
    expect(live.claudeCode).toMatchObject({ enabled: false, authMode: "subscription", blockedSkills: ["after"] });
    expect(live.apiSurfaces?.messages?.enabled).toBe(false);
    expect(loadConfig().apiSurfaces?.messages?.enabled).toBe(false);
  } finally { home.remove(); }
});

test("a missing durable config never removes a live explicit Messages denial", async () => {
  const home = createTempHome("route-live-missing-");
  try {
    const live = getDefaultConfig(); live.apiSurfaces = { messages: { enabled: false } };
    saveConfig(live);
    const req = new Request("http://localhost/api/route-to", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "claude", action: "off" }) });
    const ctx = { req, url: new URL(req.url), config: live, version: "1", deps: { readLinkStore: () => ({ version: 1, listenerPort: null, links: [] }) } } as ManagementContext;
    const response = await handleRouteToRoutes(ctx, { materializeHome: async () => {
      unlinkSync(getConfigPath()); return [{ client: "claude", outcome: "current" }];
    } });
    expect(response?.status).toBe(500);
    expect(resolveApiSurfaceSettings(live).messages.enabled).toBe(false);
  } finally { home.remove(); }
});
