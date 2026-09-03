/**
 * Meta Model API direct provider (`meta-model`).
 *
 * Muse Spark reached opencodex through resellers first (Command Code, OpenCode Zen).
 * This entry adds Meta's own endpoint, built entirely from published spec — no API key
 * was issued, so every value here is a documented claim rather than a probe result.
 *
 * Three of these tests exist because a registry-shape assertion alone would have passed
 * while the runtime was wrong:
 *
 * - the provider id would have captured a LIVE reseller model namespace at route time;
 * - the advertised `minimal` effort would have been rewritten to `low` on the wire;
 * - the note carrying the billing disclosure had no regression at all.
 */
import { describe, expect, test } from "bun:test";
import { createResponsesPassthroughAdapter as createResponsesPassthroughAdapterProduction } from "../src/adapters/openai-responses";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createResponsesPassthroughAdapter = (...args: Parameters<typeof createResponsesPassthroughAdapterProduction>) =>
  withTestTranslatorBudget(createResponsesPassthroughAdapterProduction(...args));

const META_MODELS = ["muse-spark-1.3", "muse-spark-1.3-contributor"] as const;

function entry() {
  const found = getProviderRegistryEntry("meta-model");
  if (!found) throw new Error("missing meta-model registry entry");
  return found;
}

describe("Meta Model API provider (meta-model)", () => {
  test("routes to the published OpenAI-compatible Responses base URL", () => {
    expect(entry().baseUrl).toBe("https://api.meta.ai/v1");
    expect(entry().adapter).toBe("openai-responses");
    expect(entry().authKind).toBe("key");
    expect(entry().defaultModel).toBe("muse-spark-1.3");
  });

  test("advertises exactly the vendor's effort ladder", () => {
    for (const id of META_MODELS) {
      expect(entry().modelReasoningEfforts?.[id]).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    }
  });

  test("never advertises an effort the vendor rejects", () => {
    // `none` returns HTTP 400 on Muse Spark; `max`/`ultra` are absent from the
    // published set entirely, and an unauthenticated Zen probe rejected all three.
    const efforts = entry().modelReasoningEfforts?.["muse-spark-1.3"] ?? [];
    for (const forbidden of ["none", "max", "ultra"]) expect(efforts).not.toContain(forbidden);
  });

  test("declares the published 1M window and text+image only", () => {
    for (const id of META_MODELS) {
      expect(entry().modelContextWindows?.[id]).toBe(1_048_576);
      // Meta also documents video, audio and PDF; the catalog modality enum is
      // text/image and over-advertising poisons the exported client config.
      expect(entry().modelInputModalities?.[id]).toEqual(["text", "image"]);
    }
  });

  test("claims no max-output limit, because the vendor publishes none", () => {
    expect(entry().defaultMaxOutputTokens).toBeUndefined();
  });

  test("keeps live discovery off until an authenticated roster is observed", () => {
    // The only contact with /v1/models was an unauthenticated 401. Meta serves image
    // and voice families on this same base URL, so discovery would publish rows this
    // Responses-agent provider cannot drive.
    expect(entry().liveModels).toBeFalsy();
    expect(entry().models).toEqual([...META_MODELS]);
  });

  test("the seed survives derive() intact", () => {
    const seed = providerConfigSeed(entry());
    expect(seed.baseUrl).toBe("https://api.meta.ai/v1");
    expect(seed.modelContextWindows?.["muse-spark-1.3"]).toBe(1_048_576);
    expect(seed.modelReasoningEfforts?.["muse-spark-1.3"]).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
  });

  /*
   * The namespace-theft regression. `meta/muse-spark-1.3` is a live Command Code
   * selector; the router resolves a `<provider>/<model>` prefix against configured
   * providers, so an id of `meta` would have silently redirected an already-working
   * model reference to a different vendor and a different bill.
   */
  test("meta/muse-spark-1.3 still reaches command-code with the direct provider configured", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "command-code",
      providers: {
        "command-code": { adapter: "command-code", baseUrl: "https://api.commandcode.ai", apiKey: "cc-test-key", authMode: "key" },
        "meta-model": { adapter: "openai-responses", baseUrl: "https://api.meta.ai/v1", apiKey: "meta-test-key", authMode: "key" },
      },
    };
    const route = routeModel(config, "meta/muse-spark-1.3");
    expect(route.providerName).toBe("command-code");
    expect(route.modelId).toBe("meta/muse-spark-1.3");

    // The direct provider is still reachable under its own prefix.
    expect(routeModel(config, "meta-model/muse-spark-1.3").providerName).toBe("meta-model");
  });

  /*
   * The wire-serialization regression. src/reasoning-effort.ts rewrites `minimal` to
   * `low` unless a model-scoped wire map says otherwise — so this asserts the built
   * request body, not the registry array that looked correct throughout.
   */
  test("minimal reaches the wire as minimal, not low", () => {
    const provider = { ...providerConfigSeed(entry()), apiKey: "meta-test-key" } as OcxProviderConfig;
    const request = createResponsesPassthroughAdapter(provider).buildRequest({
      modelId: "muse-spark-1.3",
      context: { messages: [] },
      stream: false,
      options: { reasoning: "minimal" },
      _rawBody: { model: "muse-spark-1.3", input: "ping", reasoning: { effort: "minimal" } },
    }, { headers: new Headers() });
    const body = JSON.parse(request.body) as { reasoning?: { effort?: string } };
    expect(body.reasoning?.effort).toBe("minimal");
  });

  /*
   * A user may already own a custom provider under this id pointing elsewhere.
   * preserveCustomDestination stops registry canonicalization from retargeting it and
   * sending their saved key to Meta.
   */
  test("a same-named custom provider keeps its own destination", () => {
    expect(entry().preserveCustomDestination).toBe(true);
    const custom: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://internal.example/v1",
      apiKey: "someone-elses-key",
      authMode: "key",
    } as OcxProviderConfig;
    enrichProviderFromRegistry("meta-model", custom);
    expect(custom.baseUrl).toBe("https://internal.example/v1");
    expect(custom.apiKey).toBe("someone-elses-key");
  });

  /*
   * The note is load-bearing, not decoration. A user holding a Muse Code subscription
   * will otherwise assume it applies here and get billed pay-as-you-go instead; Meta
   * scopes that credential to its own CLI. Deleting this text removes the only
   * in-product warning.
   */
  test("the note discloses the subscription boundary and the Contributor training tradeoff", () => {
    const note = entry().note ?? "";
    expect(note).toContain("Muse Code subscription does NOT work here");
    expect(note).toContain("metered per token");
    expect(note.toLowerCase()).toContain("trains on your prompts");
  });
});
