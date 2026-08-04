import { describe, expect, test } from "bun:test";
import { ensureStrictCatalogFields } from "../src/codex/catalog/parsing";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";

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
          // Seeded WITH modalities on purpose: a fixture without them would let the
          // clear-path test pass against a PUT that ignored the field entirely.
          { id: "existing-uuid", provider: "deepseek", modelId: "deepseek-v4", inputModalities: ["text", "image"] },
        ],
      } as unknown as Parameters<typeof handleModelRoutes>[0]["config"],
      // This handler mutates and persists the config object it receives. The
      // fixture must NEVER reach the process-global OPENCODEX_HOME; that exact bug
      // replaced a real 41KB provider config with this `existing-uuid` fixture.
      deps: {
        saveConfigPreservingClaudeCode: () => { persistCalls++; },
      } as Parameters<typeof handleModelRoutes>[0]["deps"],
      refreshCodexCatalogBestEffort: async () => {},
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
