/**
 * What a provider save keeps (#5563): the five operator compatibility settings survive an
 * unrelated POST overwrite with the same name, and none of them, nor the stored key pool, follow
 * the provider to a new destination.
 *
 * Each survival case saves through the management API, reloads the config from disk, routes the
 * provider the way a request would, and checks the next outgoing chat body. The expected body is
 * compared with the one built without the setting, so a probe that the setting does not affect
 * fails instead of passing vacuously.
 *
 * The two reasoning lists' PATCH and dashboard-save cases live in
 * management-provider-reasoning-lists.test.ts.
 */
import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenAIChatPassthroughRequest, createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { loadConfig, saveConfig } from "../../src/config";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { parseRequest } from "../../src/responses/parser";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { routeModel } from "../../src/router";
import { startServer } from "../../src/server";
import {
  PROVIDER_COMPAT_CARRY_FIELDS,
  PROVIDER_REASONING_WIRE_FORMATS,
  providerOverwriteKeepsDestination,
  sampleProviderOverwrite,
  type ProviderCompatCarryField,
} from "../../src/server/management/provider-overwrite-carry";
import type { OcxProviderConfig } from "../../src/types";
import { managementFetch as fetch } from "../helpers/management-auth";
import { config } from "../helpers/management-relative-send-paths";
import { removeTreeWithRetry } from "../helpers/remove-tree";

setDefaultTimeout(60_000);

const MODEL = "relay-thinker";
const BASE_URL = "https://relay.example/v1";
const WIRE_FORMAT = PROVIDER_REASONING_WIRE_FORMATS[0]!;

const previousHome = process.env.OPENCODEX_HOME;
let home = "";

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
  home = "";
  clearReasoningReplayCacheForTests();
});

async function withServer(providers: Record<string, OcxProviderConfig>, run: (url: URL) => Promise<void>): Promise<void> {
  home = mkdtempSync(join(tmpdir(), "ocx-provider-compat-carry-"));
  process.env.OPENCODEX_HOME = home;
  const base = config("127.0.0.1");
  saveConfig({ ...base, providers: { ...base.providers, ...providers } });
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

function nativeBody(provider: OcxProviderConfig, raw: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(buildOpenAIChatPassthroughRequest(provider, { ...raw, model: MODEL }, MODEL, false).body) as Record<string, unknown>;
}

/** An assistant tool-call turn with no recorded reasoning, so the replay cache misses. */
function translatedAssistant(provider: OcxProviderConfig): Record<string, unknown> | undefined {
  const parsed = parseRequest({
    model: MODEL,
    stream: true,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "README.md" },
    ],
  });
  parsed.modelId = MODEL;
  const body = JSON.parse(createOpenAIChatAdapter(provider).buildRequest(parsed).body as string) as {
    messages: Array<Record<string, unknown>>;
  };
  return body.messages.find(message => message.role === "assistant");
}

const tool = {
  type: "function",
  function: { name: "get_weather", parameters: { type: "object", properties: {} } },
};

interface CarryCase {
  /** The stored row besides adapter and base URL. */
  seed: Partial<OcxProviderConfig>;
  /** What the next outgoing request shows about the setting. */
  probe: (provider: OcxProviderConfig) => unknown;
}

const CASES: Record<ProviderCompatCarryField, CarryCase> = {
  foldDeveloperRoleToSystem: {
    seed: { foldDeveloperRoleToSystem: true },
    probe: provider => (nativeBody(provider, {
      messages: [{ role: "developer", content: "be brief" }, { role: "user", content: "hi" }],
    }).messages as Array<{ role: string }>)[0]!.role,
  },
  reasoningWireFormat: {
    seed: { reasoningWireFormat: WIRE_FORMAT },
    probe: provider => {
      const body = nativeBody(provider, { messages: [{ role: "user", content: "hi" }], reasoning_effort: "none" });
      return { reasoning: body.reasoning, reasoningEffort: body.reasoning_effort };
    },
  },
  omitReasoningEffortWithToolsModels: {
    seed: { omitReasoningEffortWithToolsModels: [MODEL] },
    probe: provider => Object.hasOwn(nativeBody(provider, {
      messages: [{ role: "user", content: "weather?" }],
      tools: [tool],
      reasoning_effort: "high",
    }), "reasoning_effort"),
  },
  preserveReasoningContentModels: {
    seed: { preserveReasoningContentModels: [MODEL] },
    probe: provider => translatedAssistant(provider)?.reasoning_content,
  },
  requiresReasoningPlaceholderModels: {
    // The preserve list alone implies a placeholder on a cache miss; the explicit [] opts out.
    seed: { preserveReasoningContentModels: [MODEL], requiresReasoningPlaceholderModels: [] },
    probe: provider => translatedAssistant(provider)?.reasoning_content,
  },
};

function withoutField(provider: OcxProviderConfig, field: ProviderCompatCarryField): OcxProviderConfig {
  const copy = { ...provider } as Record<string, unknown>;
  delete copy[field];
  return copy as unknown as OcxProviderConfig;
}

describe("an unrelated POST overwrite keeps each compatibility setting on the next request", () => {
  test("every carried field has a case", () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROVIDER_COMPAT_CARRY_FIELDS].sort());
  });

  for (const field of PROVIDER_COMPAT_CARRY_FIELDS) {
    test(field, async () => {
      const { seed, probe } = CASES[field];
      const name = `relay-${field.toLowerCase()}`;
      await withServer({ [name]: { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-relay", ...seed } }, async url => {
        // The add/edit form sends none of the five settings; the edit here is the default model.
        const save = await send(url, "/api/providers", "POST", {
          name,
          provider: { adapter: "openai-chat", baseUrl: BASE_URL, apiKey: "sk-relay", defaultModel: MODEL },
        });
        expect(save.status).toBe(200);

        const reloaded = loadConfig();
        expect(reloaded.providers[name]?.defaultModel).toBe(MODEL);
        expect(reloaded.providers[name]?.[field]).toEqual(seed[field]);
        const route = routeModel(reloaded, `${name}/${MODEL}`);
        expect(route.providerName).toBe(name);
        const withSetting = probe(route.provider);
        expect(withSetting).not.toEqual(probe(withoutField(route.provider, field)));
        expect(withSetting).toEqual(probe({ ...withoutField(route.provider, field), ...seed } as OcxProviderConfig));
      });
    });
  }
});

describe("an overwrite that moves the provider carries none of it", () => {
  const stored: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: BASE_URL,
    apiKey: "sk-old",
    apiKeyPool: [{ id: "old", key: "sk-old" }],
    ...Object.assign({}, ...Object.values(CASES).map(entry => entry.seed)),
  };

  for (const [label, moved] of [
    ["a new base URL", { adapter: "openai-chat", baseUrl: "https://other-relay.example/v1" }],
    ["a new adapter", { adapter: "openai-responses", baseUrl: BASE_URL }],
  ] as const) {
    test(label, async () => {
      await withServer({ relay: stored }, async url => {
        const save = await send(url, "/api/providers", "POST", { name: "relay", provider: { ...moved, apiKey: "sk-new" } });
        expect(save.status).toBe(200);
        const saved = loadConfig().providers.relay!;
        for (const field of PROVIDER_COMPAT_CARRY_FIELDS) expect(saved).not.toHaveProperty(field);
        expect(saved.apiKeyPool).toBeUndefined();
      });
    });
  }

  test("the same destination keeps the key pool and every setting", async () => {
    await withServer({ relay: stored }, async url => {
      const save = await send(url, "/api/providers", "POST", {
        name: "relay",
        provider: { adapter: "openai-chat", baseUrl: "https://RELAY.example/v1/", apiKey: "sk-old", defaultModel: MODEL },
      });
      expect(save.status).toBe(200);
      const saved = loadConfig().providers.relay!;
      for (const field of PROVIDER_COMPAT_CARRY_FIELDS) expect(saved[field]).toEqual(stored[field]);
      expect(saved.apiKeyPool?.some(entry => entry.id === stored.apiKeyPool![0]!.id)).toBe(true);
    });
  });

  test("destination identity", () => {
    const row = { adapter: "openai-chat", baseUrl: BASE_URL } as OcxProviderConfig;
    const omitted = sampleProviderOverwrite({ adapter: "openai-chat", baseUrl: BASE_URL });
    const named = sampleProviderOverwrite({ adapter: "openai-chat", baseUrl: BASE_URL, authMode: "forward" });
    expect(providerOverwriteKeepsDestination({ ...row, baseUrl: `${BASE_URL}//` }, row, omitted)).toBe(true);
    expect(providerOverwriteKeepsDestination({ ...row, baseUrl: "https://relay.example/v2" }, row, omitted)).toBe(false);
    // An omitted auth mode is not a move; a named one that differs is.
    expect(providerOverwriteKeepsDestination({ ...row, authMode: undefined }, { ...row, authMode: "forward" }, omitted)).toBe(true);
    expect(providerOverwriteKeepsDestination({ ...row, authMode: "forward" }, row, named)).toBe(false);
    expect(providerOverwriteKeepsDestination({ ...row, authMode: "key" }, row, named)).toBe(true);
    expect(providerOverwriteKeepsDestination(row, undefined, omitted)).toBe(false);
  });
});

describe("PATCH and POST validate the settings they name", () => {
  test("PATCH writes and clears foldDeveloperRoleToSystem and reasoningWireFormat", async () => {
    await withServer({ relay: { adapter: "openai-chat", baseUrl: BASE_URL } }, async url => {
      const set = await send(url, "/api/providers?name=relay", "PATCH", {
        foldDeveloperRoleToSystem: false,
        reasoningWireFormat: WIRE_FORMAT,
      });
      expect(set.status).toBe(200);
      expect(loadConfig().providers.relay).toMatchObject({ foldDeveloperRoleToSystem: false, reasoningWireFormat: WIRE_FORMAT });

      const badFold = await send(url, "/api/providers?name=relay", "PATCH", { foldDeveloperRoleToSystem: "yes" });
      expect(badFold.status).toBe(400);
      const badWire = await send(url, "/api/providers?name=relay", "PATCH", { reasoningWireFormat: "flat" });
      expect(badWire.status).toBe(400);

      const clear = await send(url, "/api/providers?name=relay", "PATCH", { foldDeveloperRoleToSystem: null, reasoningWireFormat: null });
      expect(clear.status).toBe(200);
      const cleared = loadConfig().providers.relay!;
      expect(cleared).not.toHaveProperty("foldDeveloperRoleToSystem");
      expect(cleared).not.toHaveProperty("reasoningWireFormat");
    });
  });

  test("POST refuses a malformed setting instead of storing it", async () => {
    await withServer({}, async url => {
      for (const provider of [
        { foldDeveloperRoleToSystem: "yes" },
        { reasoningWireFormat: "flat" },
        { preserveReasoningContentModels: "relay-thinker" },
      ]) {
        const save = await send(url, "/api/providers", "POST", {
          name: "relay",
          provider: { adapter: "openai-chat", baseUrl: BASE_URL, ...provider },
        });
        expect(save.status).toBe(400);
      }
      expect(loadConfig().providers.relay).toBeUndefined();
    });
  });
});
