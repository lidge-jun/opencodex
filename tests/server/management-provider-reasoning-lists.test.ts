/**
 * Provider saves and the two reasoning-replay model lists (#5563).
 *
 * `preserveReasoningContentModels` and `requiresReasoningPlaceholderModels` decide whether an
 * openai-chat provider replays `reasoning_content` on tool-call turns. PATCH had no branch for
 * either, so a patch naming only them was refused and one that also named a recognized field
 * answered 200 without them. The dashboard save rebuilds the row from a form that sends
 * neither, so it dropped them from a custom provider and reset a registry provider to its seed.
 *
 * Held in a sibling file because management-provider-validation.test.ts sits at its file-size
 * ratchet cap (d3ca5522db, #4908).
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch } from "../helpers/management-auth";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxProviderConfig } from "../../src/types";

setDefaultTimeout(60_000);

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
});

async function withServer(
  providers: Record<string, OcxProviderConfig>,
  run: (url: URL) => Promise<void>,
  resolveDestination: (name: string) => Promise<string | null> = async () => null,
): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-reasoning-lists-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, ...providers } });
  const server = startServer(0);
  const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockImplementation(resolveDestination);
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

describe("provider saves keep the reasoning-replay model lists", () => {
  test("PATCH writes, validates and clears both lists", async () => {
    await withServer({ relay: { adapter: "openai-chat", baseUrl: "https://relay.example/v1" } }, async url => {
      const set = await send(url, "/api/providers?name=relay", "PATCH", {
        preserveReasoningContentModels: [" deepseek-v4-pro "],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      });
      expect(set.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({
        preserveReasoningContentModels: ["deepseek-v4-pro"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      });

      // Beside a recognized field the list used to vanish behind a 200. It is validated now.
      const mixed = await send(url, "/api/providers?name=relay", "PATCH", {
        preserveReasoningContentModels: 12345,
        liveModels: true,
      });
      expect(mixed.status).toBe(400);
      expect(await mixed.json()).toMatchObject({ error: "preserveReasoningContentModels must be an array" });
      const blank = await send(url, "/api/providers?name=relay", "PATCH", { requiresReasoningPlaceholderModels: [" "] });
      expect(blank.status).toBe(400);
      expect(await blank.json()).toMatchObject({ error: "requiresReasoningPlaceholderModels.0 must be a nonblank model id" });

      // An empty list is stored: it is the explicit opt-out that keeps a registry seed from
      // filling the field back in. null removes the field.
      const optOut = await send(url, "/api/providers?name=relay", "PATCH", { requiresReasoningPlaceholderModels: [] });
      expect(optOut.status).toBe(200);
      expect(loadConfig().providers.relay?.requiresReasoningPlaceholderModels).toEqual([]);
      const clear = await send(url, "/api/providers?name=relay", "PATCH", { preserveReasoningContentModels: null });
      expect(clear.status).toBe(200);
      expect(loadConfig().providers.relay).not.toHaveProperty("preserveReasoningContentModels");
    });
  });

  test("a dashboard save keeps both lists on a custom provider", async () => {
    await withServer({
      relay: {
        adapter: "openai-chat",
        baseUrl: "https://relay.example/v1",
        preserveReasoningContentModels: ["deepseek-v4-pro"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      },
    }, async url => {
      // The add/edit form sends neither list.
      const save = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: "https://relay.example/v1", defaultModel: "deepseek-v4-pro" },
      });
      expect(save.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({
        defaultModel: "deepseek-v4-pro",
        preserveReasoningContentModels: ["deepseek-v4-pro"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      });
    });
  });

  test("a dashboard save keeps a registry provider's edited list and its explicit opt-out", async () => {
    await withServer({
      deepseek: {
        adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        preserveReasoningContentModels: ["deepseek-flash", "house-reasoner"],
        requiresReasoningPlaceholderModels: [],
      },
    }, async url => {
      // Catalog enrichment fills an omitted list from the registry seed, so this save used to
      // replace the edited list with the seed and lose the opt-out.
      const save = await send(url, "/api/providers", "POST", {
        name: "deepseek",
        provider: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com" },
      });
      expect(save.status).toBe(200);
      const saved = loadConfig().providers.deepseek;
      expect(saved?.preserveReasoningContentModels).toEqual(["deepseek-flash", "house-reasoner"]);
      expect(saved?.requiresReasoningPlaceholderModels).toEqual([]);
    });
  });

  test("a save that sends the lists stores what it sent", async () => {
    await withServer({
      relay: {
        adapter: "openai-chat",
        baseUrl: "https://relay.example/v1",
        preserveReasoningContentModels: ["deepseek-v4-pro"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      },
    }, async url => {
      const save = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: {
          adapter: "openai-chat",
          baseUrl: "https://relay.example/v1",
          preserveReasoningContentModels: ["deepseek-v4-flash"],
          requiresReasoningPlaceholderModels: ["deepseek-v4-flash"],
        },
      });
      expect(save.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({
        preserveReasoningContentModels: ["deepseek-v4-flash"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-flash"],
      });
    });
  });

  test("a PATCH that lands while a dashboard save awaits DNS validation is not undone", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let held = false;
    // Hold the POST inside its DNS check, the await between reading the stored row and saving.
    const resolveDestination = async (name: string): Promise<string | null> => {
      if (name === "relay" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return null;
    };
    await withServer({
      relay: {
        adapter: "openai-chat",
        baseUrl: "https://relay.example/v1",
        preserveReasoningContentModels: ["deepseek-v4-pro"],
        requiresReasoningPlaceholderModels: ["deepseek-v4-pro"],
      },
    }, async url => {
      const saving = send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: "https://relay.example/v1" },
      });
      await entered.promise;
      const patch = await send(url, "/api/providers?name=relay", "PATCH", {
        preserveReasoningContentModels: ["deepseek-v4-flash"],
        requiresReasoningPlaceholderModels: [],
      });
      expect(patch.status).toBe(200);
      release.resolve();
      expect((await saving).status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({
        preserveReasoningContentModels: ["deepseek-v4-flash"],
        requiresReasoningPlaceholderModels: [],
      });
    }, resolveDestination);
  });
});
