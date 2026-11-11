/** forwardAdvisorTool: the per-provider opt-in that lets an Anthropic-compatible gateway receive Claude Code's Advisor tool (#8448). */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { startServer } from "../../src/server";
import type { OcxProviderConfig } from "../../src/types";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

const BASE_URL = "https://gateway.example/v1";
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withServer(provider: OcxProviderConfig, run: (url: URL) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-forward-advisor-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, gateway: provider } });
  const server = startServer(0);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
  try {
    await run(server.url);
  } finally {
    resolved.mockRestore();
    await server.stop(true);
  }
}

function send(url: URL, path: string, method: "PATCH" | "POST", body: unknown): Promise<Response> {
  return fetch(new URL(path, url), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function provider(forwardAdvisorTool?: boolean): OcxProviderConfig {
  return { adapter: "anthropic", baseUrl: BASE_URL, ...(forwardAdvisorTool === undefined ? {} : { forwardAdvisorTool }) };
}

describe("forwardAdvisorTool management", () => {
  test("GET reports it and PATCH sets, clears, and rejects it", async () => {
    await withServer(provider(), async url => {
      const row = async () => (await (await fetch(new URL("/api/providers", url))).json() as Array<{ name: string; forwardAdvisorTool?: boolean }>)
        .find(entry => entry.name === "gateway");
      expect((await row())?.forwardAdvisorTool).toBeUndefined();
      const set = await send(url, "/api/providers?name=gateway", "PATCH", { forwardAdvisorTool: true });
      expect(set.status).toBe(200);
      expect(loadConfig().providers.gateway?.forwardAdvisorTool).toBe(true);
      expect((await row())?.forwardAdvisorTool).toBe(true);
      const reject = await send(url, "/api/providers?name=gateway", "PATCH", { forwardAdvisorTool: "yes" });
      expect(reject.status).toBe(400);
      expect(await reject.json()).toMatchObject({ error: "forwardAdvisorTool must be a boolean" });
      expect(loadConfig().providers.gateway?.forwardAdvisorTool).toBe(true);
      const clear = await send(url, "/api/providers?name=gateway", "PATCH", { forwardAdvisorTool: null });
      expect(clear.status).toBe(200);
      expect(loadConfig().providers.gateway).not.toHaveProperty("forwardAdvisorTool");
    });
  });

  test("a same-destination save keeps an omitted opt-in", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers", "POST", { name: "gateway", provider: { adapter: "anthropic", baseUrl: BASE_URL, note: "edited" } });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.gateway).toMatchObject({ note: "edited", forwardAdvisorTool: true });
    });
  });

  test("moving the provider to another destination drops the opt-in", async () => {
    await withServer(provider(true), async url => {
      const movedUrl = "https://other-gateway.example/v1";
      const response = await send(url, "/api/providers", "POST", { name: "gateway", provider: { adapter: "anthropic", baseUrl: movedUrl } });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.gateway?.baseUrl).toBe(movedUrl);
      expect(loadConfig().providers.gateway).not.toHaveProperty("forwardAdvisorTool");
    });
  });

  test("POST rejects a string value", async () => {
    await withServer(provider(), async url => {
      const response = await send(url, "/api/providers", "POST", { name: "gateway", provider: { ...provider(), forwardAdvisorTool: "true" } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "forwardAdvisorTool must be a boolean" });
      expect(loadConfig().providers.gateway).not.toHaveProperty("forwardAdvisorTool");
    });
  });

  test("provider schema rejects a string instead of passing it through at config load", () => {
    expect(providerConfigSchema.safeParse({ ...provider(), forwardAdvisorTool: "true" }).success).toBe(false);
    expect(providerConfigSchema.safeParse(provider(true)).success).toBe(true);
  });
});
