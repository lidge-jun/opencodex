/** Responses plaintext replay opt-in survives only same-destination saves and is editable through PATCH. */
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
  home = mkdtempSync(join(tmpdir(), "ocx-provider-responses-reasoning-replay-"));
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

function provider(preserveResponsesReasoningContent?: boolean): OcxProviderConfig {
  return { adapter: "openai-responses", baseUrl: BASE_URL, ...(preserveResponsesReasoningContent === undefined ? {} : { preserveResponsesReasoningContent }) };
}

describe("preserveResponsesReasoningContent management saves", () => {
  test("same-destination POST keeps an omitted true on disk", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-responses", baseUrl: BASE_URL, defaultModel: "relay-thinker" },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ defaultModel: "relay-thinker", preserveResponsesReasoningContent: true });
    });
  });

  test("destination-move POST does not copy the old replay opt-in", async () => {
    await withServer(provider(true), async url => {
      const movedUrl = "https://other-relay.example/v1";
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-responses", baseUrl: movedUrl },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ baseUrl: movedUrl });
      expect(loadConfig().providers.relay).not.toHaveProperty("preserveResponsesReasoningContent");
    });
  });

  test("POST false overrides stored true", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-responses", baseUrl: BASE_URL, preserveResponsesReasoningContent: false },
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.relay?.preserveResponsesReasoningContent).toBe(false);
    });
  });

  test("POST rejects a string value", async () => {
    await withServer(provider(), async url => {
      const response = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-responses", baseUrl: BASE_URL, preserveResponsesReasoningContent: "true" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "preserveResponsesReasoningContent must be a boolean" });
      expect(loadConfig().providers.relay).not.toHaveProperty("preserveResponsesReasoningContent");
    });
  });

  test("PATCH with only preserveResponsesReasoningContent sets then clears it on disk", async () => {
    await withServer(provider(), async url => {
      const set = await send(url, "/api/providers?name=relay", "PATCH", { preserveResponsesReasoningContent: true });
      expect(set.status).toBe(200);
      expect(loadConfig().providers.relay?.preserveResponsesReasoningContent).toBe(true);
      const rows = await (await fetch(new URL("/api/providers", url))).json() as Array<Record<string, unknown>>;
      expect(rows.find(row => row.name === "relay")?.preserveResponsesReasoningContent).toBe(true);
      const disable = await send(url, "/api/providers?name=relay", "PATCH", { preserveResponsesReasoningContent: false });
      expect(disable.status).toBe(200);
      expect(loadConfig().providers.relay?.preserveResponsesReasoningContent).toBe(false);
      const clear = await send(url, "/api/providers?name=relay", "PATCH", { preserveResponsesReasoningContent: null });
      expect(clear.status).toBe(200);
      expect(loadConfig().providers.relay).not.toHaveProperty("preserveResponsesReasoningContent");
    });
  });

  test("PATCH rejects a string value", async () => {
    await withServer(provider(true), async url => {
      const response = await send(url, "/api/providers?name=relay", "PATCH", { preserveResponsesReasoningContent: "yes" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "preserveResponsesReasoningContent must be a boolean" });
      expect(loadConfig().providers.relay?.preserveResponsesReasoningContent).toBe(true);
    });
  });

  test("provider schema rejects a string instead of passing it through at config load", () => {
    expect(providerConfigSchema.safeParse({ ...provider(), preserveResponsesReasoningContent: "true" }).success).toBe(false);
    expect(providerConfigSchema.safeParse(provider(true)).success).toBe(true);
  });
});
