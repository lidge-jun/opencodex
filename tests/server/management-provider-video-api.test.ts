/** videoApi management (#9110): the per-provider video job wire survives dashboard saves to the same upstream. */
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

const BASE_URL = "https://videos.example/v1";
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withServer(provider: OcxProviderConfig, run: (url: URL) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-video-api-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, videos: provider } });
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

function provider(videoApi?: "xai" | "openai"): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: BASE_URL, ...(videoApi === undefined ? {} : { videoApi }) };
}

describe("videoApi management", () => {
  test("GET reports it and PATCH sets, clears, and rejects it", async () => {
    await withServer(provider(), async url => {
      const row = async () => (await (await fetch(new URL("/api/providers", url))).json() as Array<{ name: string; videoApi?: string }>)
        .find(entry => entry.name === "videos");
      expect((await row())?.videoApi).toBeUndefined();
      expect((await send(url, "/api/providers?name=videos", "PATCH", { videoApi: "openai" })).status).toBe(200);
      expect(loadConfig().providers.videos?.videoApi).toBe("openai");
      expect((await row())?.videoApi).toBe("openai");
      const reject = await send(url, "/api/providers?name=videos", "PATCH", { videoApi: "sora" });
      expect(reject.status).toBe(400);
      expect(await reject.json()).toMatchObject({ error: "videoApi must be xai, openai, or null to clear" });
      expect(loadConfig().providers.videos?.videoApi).toBe("openai");
      expect((await send(url, "/api/providers?name=videos", "PATCH", { videoApi: null })).status).toBe(200);
      expect(loadConfig().providers.videos).not.toHaveProperty("videoApi");
    });
  });

  test("a same-destination save from the dashboard form keeps the omitted wire", async () => {
    await withServer(provider("openai"), async url => {
      const response = await send(url, "/api/providers", "POST", { name: "videos", provider: { adapter: "openai-chat", baseUrl: BASE_URL, note: "edited" } });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.videos).toMatchObject({ note: "edited", videoApi: "openai" });
    });
  });

  test("moving the provider to another destination drops the wire", async () => {
    await withServer(provider("openai"), async url => {
      const movedUrl = "https://other-videos.example/v1";
      const response = await send(url, "/api/providers", "POST", { name: "videos", provider: { adapter: "openai-chat", baseUrl: movedUrl } });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.videos?.baseUrl).toBe(movedUrl);
      expect(loadConfig().providers.videos).not.toHaveProperty("videoApi");
    });
  });

  test("provider schema accepts only the two wires", () => {
    expect(providerConfigSchema.safeParse(provider("openai")).success).toBe(true);
    expect(providerConfigSchema.safeParse(provider("xai")).success).toBe(true);
    expect(providerConfigSchema.safeParse({ ...provider(), videoApi: "sora" }).success).toBe(false);
  });
});
