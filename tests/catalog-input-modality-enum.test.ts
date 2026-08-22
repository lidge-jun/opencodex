import { beforeEach, describe, expect, test } from "bun:test";
import { ensureStrictCatalogFields } from "../src/codex/catalog/parsing";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import type { OcxConfig } from "../src/types";

/**
 * Codex parses `input_modalities` as a closed enum of text | image | audio. A single out-of-enum
 * value makes its config loader reject the WHOLE catalog file, and because that file is referenced
 * from config, the failure cascades: plugins, apps and MCP servers all stop loading.
 *
 * This actually happened — zenmux advertises "video" on meta-muse-spark-1.1, which we wrote through
 * verbatim and the Codex app reported `unknown variant 'video'` while showing zero apps.
 */
describe("catalog input_modalities stay inside the enum Codex accepts", () => {
  test("an out-of-enum modality is dropped rather than written through", () => {
    const entry = ensureStrictCatalogFields(
      { slug: "zenmux/meta-muse-spark-1.1", input_modalities: ["text", "image", "audio", "video"] },
      {},
    );
    expect(entry.input_modalities).toEqual(["text", "image", "audio"]);
  });

  test("an entry left with nothing acceptable falls back to text, never an empty list", () => {
    // A modality-less entry would be worse than a text-only one: Codex would have no way to know
    // the model takes prompts at all.
    const entry = ensureStrictCatalogFields({ slug: "p/only-video", input_modalities: ["video"] }, {});
    expect(entry.input_modalities).toEqual(["text"]);
  });

  test("accepted modalities survive untouched", () => {
    const entry = ensureStrictCatalogFields({ slug: "p/vision", input_modalities: ["text", "image"] }, {});
    expect(entry.input_modalities).toEqual(["text", "image"]);
  });

  test("preserveExactInputModalities still cannot smuggle a rejected value through", () => {
    // That option exists to stop us inventing a default, not to bypass the enum.
    const entry = ensureStrictCatalogFields(
      { slug: "p/exact", input_modalities: ["text", "video"] },
      { preserveExactInputModalities: true },
    );
    expect(entry.input_modalities).toEqual(["text"]);
  });

  test("provider metadata is filtered at the source as well", () => {
    const hints = catalogHintsFromModelsApiItem("zenmux", {
      id: "meta-muse-spark-1.1",
      input_modalities: ["text", "image", "audio", "video"],
    } as Parameters<typeof catalogHintsFromModelsApiItem>[1]);
    expect(hints.inputModalities).toEqual(["text", "image", "audio"]);
  });
});

/*
 * The management API is the third ingress, and it was the one still open: the catalog writer
 * normalized on the way out, but a rejected value stored through /api/custom-models was handed
 * back to the GUI and CLI as if it were real, while the offline `ocx models add` path already
 * refused it. All three now agree.
 */
describe("custom-model API rejects out-of-enum input modalities", () => {
  let persistCalls = 0;
  // Shared fixture: the PUT/POST handlers mutate and persist the config object they
  // receive, so seed requests and their follow-ups must see the SAME object (a fresh
  // object per call would discard the seeded default before the follow-up asserts on it).
  const fixtureConfig = {
    providers: { deepseek: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1" } },
    customModels: [] as Array<{ id: string; provider: string; modelId: string; inputModalities?: string[] }>,
  } as unknown as OcxConfig;

  beforeEach(() => {
    // Seeded WITH modalities on purpose: a fixture without them would let the
    // clear-path test pass against a PUT that ignored the field entirely.
    fixtureConfig.customModels = [
      { id: "existing-uuid", provider: "deepseek", modelId: "deepseek-v4", inputModalities: ["text", "image"] },
    ];
  });

  async function callCustomModels(
    method: "POST" | "PUT",
    body: unknown,
    pathname = "/api/custom-models",
  ): Promise<Response | null> {
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleModelRoutes({
      req,
      url,
      config: fixtureConfig,
      // This handler mutates and persists the config object it receives. The
      // fixture must NEVER reach the process-global OPENCODEX_HOME; that exact bug
      // replaced a real 41KB provider config with this `existing-uuid` fixture.
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("POST refuses a rejected modality with 400 instead of storing it", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v5",
      inputModalities: ["text", "video"],
    });
    expect(res?.status).toBe(400);
    const payload = await res!.json() as { error?: string };
    // The message has to name the offending value; "invalid request" would leave the caller guessing.
    expect(payload.error).toContain("video");
    expect(persistCalls).toBe(0);
  });

  test("PUT refuses a rejected modality too — edit was the path still open", async () => {
    persistCalls = 0;
    const res = await callCustomModels("PUT", { inputModalities: ["video"] }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(400);
    const payload = await res!.json() as { error?: string };
    expect(payload.error).toContain("video");
    expect(persistCalls).toBe(0);
  });

  test("an accepted modality set still passes", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      inputModalities: ["text", "image"],
    });
    expect(res?.status).not.toBe(400);
    expect(persistCalls).toBe(1);
  });

  /*
   * Filtering non-strings out instead of rejecting them was the subtler half of the same bug:
   * a POST of ["text", 42] answered 201 and stored ["text"], and a PUT of [42] would have
   * cleared the stored modalities while answering 200 — the opposite of what a validator that
   * returns 400 is supposed to promise.
   */
  test("a non-string member is rejected, not quietly filtered away", async () => {
    persistCalls = 0;
    const posted = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v7",
      inputModalities: ["text", 42],
    });
    expect(posted?.status).toBe(400);
    expect((await posted!.json() as { error?: string }).error).toContain("strings");

    const put = await callCustomModels("PUT", { inputModalities: [42] }, "/api/custom-models/existing-uuid");
    expect(put?.status).toBe(400);
    expect(persistCalls).toBe(0);
  });

  // `ocx models edit --modalities -` sends an empty array. That must clear the field, not 400.
  test("an empty array still clears the field rather than being rejected", async () => {
    persistCalls = 0;
    // The fixture starts with ["text", "image"], so this asserts a real clear, not a no-op.
    const res = await callCustomModels("PUT", { inputModalities: [] }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { inputModalities?: unknown };
    expect(payload.inputModalities).toBeUndefined();
    expect(persistCalls).toBe(1);
  });
});

/*
 * The same closed-enum argument applies to the reasoning ladder: a label outside the Codex
 * ladder (low..ultra) stored through /api/custom-models would surface in a catalog the
 * upstream never accepts, and the GUI's effort checkboxes are only as honest as the API
 * that validates them. Unlike modalities, an EMPTY ladder is meaningful here — it is the
 * explicit "no reasoning" override that hides the effort control (#883) — so `[]` is
 * stored, not cleared, and `null` is the only way a PUT restores inheritance.
 */
describe("custom-model API validates reasoning-effort ladders", () => {
  let persistCalls = 0;

  async function callCustomModels(
    method: "POST" | "PUT",
    body: unknown,
    pathname = "/api/custom-models",
  ): Promise<Response | null> {
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleModelRoutes({
      req,
      url,
      config: {
        providers: { deepseek: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1" } },
        customModels: [
          // Seeded WITH a ladder on purpose: the null-clear test needs a stored value to
          // remove, and the explicit-empty test needs to prove `[]` is NOT a clear.
          { id: "existing-uuid", provider: "deepseek", modelId: "deepseek-v4", reasoningEfforts: ["low", "high"] },
        ],
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("POST refuses an effort outside the Codex ladder, naming the offending value", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v5",
      reasoningEfforts: ["low", "deep"],
    });
    expect(res?.status).toBe(400);
    expect((await res!.json() as { error?: string }).error).toContain("deep");
    expect(persistCalls).toBe(0);
  });

  test("POST refuses a non-string member instead of filtering it away", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v5",
      reasoningEfforts: ["low", 42],
    });
    expect(res?.status).toBe(400);
    expect((await res!.json() as { error?: string }).error).toContain("strings");
    expect(persistCalls).toBe(0);
  });

  test("POST accepts a valid ladder with a member default and dedupes", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      reasoningEfforts: ["low", "high", "high"],
      defaultReasoningEffort: "high",
    });
    expect(res?.status).toBe(201);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toEqual(["low", "high"]);
    expect(payload.defaultReasoningEffort).toBe("high");
    expect(persistCalls).toBe(1);
  });

  test("POST stores an explicit empty ladder as the no-reasoning override", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      reasoningEfforts: [],
    });
    expect(res?.status).toBe(201);
    const payload = await res!.json() as { reasoningEfforts?: string[] };
    expect(payload.reasoningEfforts).toEqual([]);
    expect(persistCalls).toBe(1);
  });

  test("POST accepts the none/minimal sentinels, canonicalized first", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      reasoningEfforts: ["max", "none", "low", "minimal"],
      defaultReasoningEffort: "none",
    });
    expect(res?.status).toBe(201);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toEqual(["none", "minimal", "low", "max"]);
    expect(payload.defaultReasoningEffort).toBe("none");
    expect(persistCalls).toBe(1);
  });

  test("POST refuses a default effort outside the declared ladder", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "max",
    });
    expect(res?.status).toBe(400);
    expect((await res!.json() as { error?: string }).error).toContain("max");
    expect(persistCalls).toBe(0);
  });

  test("POST refuses a default effort without any ladder", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      defaultReasoningEffort: "high",
    });
    expect(res?.status).toBe(400);
    expect((await res!.json() as { error?: string }).error).toContain("reasoningEfforts");
    expect(persistCalls).toBe(0);
  });

  test("PUT stores an explicit empty ladder instead of clearing it", async () => {
    persistCalls = 0;
    const res = await callCustomModels("PUT", { reasoningEfforts: [] }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[] };
    expect(payload.reasoningEfforts).toEqual([]);
    expect(persistCalls).toBe(1);
  });

  test("PUT null restores inheritance by clearing the stored ladder", async () => {
    persistCalls = 0;
    const res = await callCustomModels("PUT", { reasoningEfforts: null }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[] };
    expect(payload.reasoningEfforts).toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  test("PUT clears the default when the ladder is removed", async () => {
    persistCalls = 0;
    const res = await callCustomModels(
      "PUT",
      { reasoningEfforts: null, defaultReasoningEffort: null },
      "/api/custom-models/existing-uuid",
    );
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toBeUndefined();
    expect(payload.defaultReasoningEffort).toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  // POST rejects a default outside the ladder; PUT must not be able to produce that state
  // on its own. A ladder shrink/clear on a row that was created with a default (CLI) must
  // drop the stale default — otherwise it re-applies itself onto the inherited ladder in
  // the generated catalog (GUI toggle-off path sends only reasoningEfforts).
  test("PUT ladder shrink drops a stored default that is no longer a member", async () => {
    persistCalls = 0;
    const seededRes = await callCustomModels("PUT", {
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "max",
    }, "/api/custom-models/existing-uuid");
    expect(seededRes?.status).toBe(200);
    const seeded = await seededRes!.json() as { defaultReasoningEffort?: string };
    expect(seeded.defaultReasoningEffort).toBe("max");

    persistCalls = 0;
    const res = await callCustomModels("PUT", { reasoningEfforts: ["low"] }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toEqual(["low"]);
    expect(payload.defaultReasoningEffort).toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  test("PUT null-clear drops a stored default even when the body does not mention it", async () => {
    persistCalls = 0;
    const seededRes = await callCustomModels("PUT", {
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }, "/api/custom-models/existing-uuid");
    expect(seededRes?.status).toBe(200);

    persistCalls = 0;
    const res = await callCustomModels("PUT", { reasoningEfforts: null }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toBeUndefined();
    expect(payload.defaultReasoningEffort).toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  test("PUT explicit empty ladder also drops a stored default", async () => {
    persistCalls = 0;
    const seededRes = await callCustomModels("PUT", {
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    }, "/api/custom-models/existing-uuid");
    expect(seededRes?.status).toBe(200);

    persistCalls = 0;
    const res = await callCustomModels("PUT", { reasoningEfforts: [] }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { reasoningEfforts?: string[]; defaultReasoningEffort?: string };
    expect(payload.reasoningEfforts).toEqual([]);
    expect(payload.defaultReasoningEffort).toBeUndefined();
    expect(persistCalls).toBe(1);
  });

  test("POST and PUT canonicalize the ladder into Codex order", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "deepseek-v6",
      reasoningEfforts: ["max", "low", "high", "low"],
    });
    expect(res?.status).toBe(201);
    const payload = await res!.json() as { reasoningEfforts?: string[] };
    expect(payload.reasoningEfforts).toEqual(["low", "high", "max"]);
    expect(persistCalls).toBe(1);
  });
});

describe("custom-model API allows slash model ids", () => {
  let persistCalls = 0;

  async function callCustomModels(
    method: "POST" | "PUT",
    body: unknown,
    pathname = "/api/custom-models",
  ): Promise<Response | null> {
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL(`http://127.0.0.1:10199${pathname}`);
    const req = new Request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return handleModelRoutes({
      req,
      url,
      config: {
        providers: { deepseek: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1" } },
        customModels: [
          { id: "existing-uuid", provider: "deepseek", modelId: "deepseek-v4", inputModalities: ["text", "image"] },
        ],
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
  }

  test("POST accepts slash model ids", async () => {
    persistCalls = 0;
    const res = await callCustomModels("POST", {
      provider: "deepseek",
      modelId: "openai/gpt-5.5",
    });
    expect(res?.status).toBe(201);
    const payload = await res!.json() as { modelId?: string };
    expect(payload.modelId).toBe("openai/gpt-5.5");
    expect(persistCalls).toBe(1);
  });

  test("PUT accepts slash model ids", async () => {
    persistCalls = 0;
    const res = await callCustomModels("PUT", { modelId: "openai/gpt-5.5" }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(200);
    const payload = await res!.json() as { modelId?: string };
    expect(payload.modelId).toBe("openai/gpt-5.5");
    expect(persistCalls).toBe(1);
  });

  test("PUT still rejects displayName with slash", async () => {
    persistCalls = 0;
    const res = await callCustomModels("PUT", { displayName: "foo/bar" }, "/api/custom-models/existing-uuid");
    expect(res?.status).toBe(400);
    expect(persistCalls).toBe(0);
  });

  test("POST rejects a slash id that encodes to an existing native id", async () => {
    persistCalls = 0;
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL("http://127.0.0.1:10199/api/custom-models");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", modelId: "openai/gpt-5.5" }),
    });
    const res = await handleModelRoutes({
      req,
      url,
      config: {
        providers: {
          deepseek: {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            models: ["openai-gpt-5.5"],
          },
        },
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    expect(res?.status).toBe(409);
    const payload = await res!.json() as { error?: string };
    expect(payload.error).toContain("ambiguous");
    expect(persistCalls).toBe(0);
  });

  test("PUT rejects renaming onto a colliding native id", async () => {
    persistCalls = 0;
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL("http://127.0.0.1:10199/api/custom-models/existing-uuid");
    const req = new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "a/b-c" }),
    });
    const res = await handleModelRoutes({
      req,
      url,
      config: {
        providers: {
          deepseek: {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            models: ["a-b/c"],
          },
        },
        customModels: [
          { id: "existing-uuid", provider: "deepseek", modelId: "deepseek-v4" },
        ],
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    expect(res?.status).toBe(409);
    const payload = await res!.json() as { error?: string };
    expect(payload.error).toContain("ambiguous");
    expect(persistCalls).toBe(0);
  });

  test("POST rejects a slash id that encodes to defaultModel only", async () => {
    persistCalls = 0;
    const { handleModelRoutes } = await import("../src/server/management/model-routes");
    const url = new URL("http://127.0.0.1:10199/api/custom-models");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "deepseek", modelId: "openai/gpt-5.5" }),
    });
    const res = await handleModelRoutes({
      req,
      url,
      config: {
        providers: {
          deepseek: {
            adapter: "openai-chat",
            baseUrl: "https://example.invalid/v1",
            defaultModel: "openai-gpt-5.5",
          },
        },
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      convergeCodexCatalog: async () => ({
        status: "committed",
        changed: false,
        degraded: false,
        notices: [],
      }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });
    expect(res?.status).toBe(409);
    const payload = await res!.json() as { error?: string };
    expect(payload.error).toContain("ambiguous");
    expect(persistCalls).toBe(0);
  });
});
