/** Provider display policy survives dashboard saves and is editable through PATCH. */
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

const BASE_URL = "https://relay.example/v1";
const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withServer(provider: OcxProviderConfig, run: (url: URL) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-hide-raw-reasoning-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, relay: provider } });
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
  return fetch(new URL(path, url), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function provider(hideRawReasoning?: boolean): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: BASE_URL, ...(hideRawReasoning === undefined ? {} : { hideRawReasoning }) };
}

describe("hideRawReasoning management saves", () => {
  test("same-destination POST keeps an omitted true on disk", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: BASE_URL, defaultModel: "relay-thinker" },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ defaultModel: "relay-thinker", hideRawReasoning: true });
    });
  });

  test("destination-move POST keeps an omitted true on disk", async () => {
    await withServer(provider(true), async url => {
      const movedUrl = "https://other-relay.example/v1";
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: movedUrl },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ baseUrl: movedUrl, hideRawReasoning: true });
    });
  });

  test("POST false overrides stored true", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: BASE_URL, hideRawReasoning: false },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay?.hideRawReasoning).toBe(false);
    });
  });

  test("POST rejects a string value", async () => {
    await withServer(provider(), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: BASE_URL, hideRawReasoning: "true" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "hideRawReasoning must be a boolean" });
      expect(loadConfig().providers.relay).not.toHaveProperty("hideRawReasoning");
    });
  });

  test("PATCH with only hideRawReasoning sets then clears it on disk", async () => {
    await withServer(provider(), async url => {
      const set = await send(url, "/api/providers?name=relay", "PATCH", { hideRawReasoning: true });
      expect(set.status).toBe(200);
      expect(loadConfig().providers.relay?.hideRawReasoning).toBe(true);
      const clear = await send(url, "/api/providers?name=relay", "PATCH", { hideRawReasoning: null });
      expect(clear.status).toBe(200);
      expect(loadConfig().providers.relay).not.toHaveProperty("hideRawReasoning");
    });
  });

  test("PATCH rejects a string value", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers?name=relay", "PATCH", { hideRawReasoning: "yes" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "hideRawReasoning must be a boolean" });
      expect(loadConfig().providers.relay?.hideRawReasoning).toBe(true);
    });
  });

  test("provider schema rejects a string instead of passing it through at config load", () => {
    expect(providerConfigSchema.safeParse({ ...provider(), hideRawReasoning: "true" }).success).toBe(false);
    expect(providerConfigSchema.safeParse(provider(true)).success).toBe(true);
  });
});
