import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoEligiblePolicyCandidateError, routeModel } from "../src/router";
import { isValidProviderName } from "../src/config";
import { getRoutingProfile } from "../src/routing/profile";
import { evidenceFromBody } from "../src/routing/request-evidence";
import type { OcxConfig } from "../src/types";

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-policy-exec-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: {
        adapter: "openai-chat",
        baseUrl: "https://a.example/v1",
        apiKey: "ka",
        models: ["m1"],
        modelContextWindows: { m1: 200_000 },
        modelInputModalities: { m1: ["text", "image"] },
        parallelToolCalls: true,
      },
      b: {
        adapter: "openai-chat",
        baseUrl: "https://b.example/v1",
        apiKey: "kb",
        models: ["m2"],
        modelContextWindows: { m2: 64_000 },
        modelInputModalities: { m2: ["text"] },
      },
      openai: { adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
    routingProfiles: {
      fast: {
        alias: "ocx/fast",
        candidates: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
        require: { tools: true, minContextWindow: 128000 },
        unknownEvidence: { capability: "exclude", health: "penalize", quota: "penalize", cost: "penalize" },
      },
    },
    ...overrides,
  };
}

describe("policy execution (RI-05)", () => {
  test("explicit policy/<id> request executes the evaluator and routes the winner", () => {
    const config = baseConfig();
    const route = routeModel(config, "policy/fast");
    expect(route.routeKind).toBe("policy");
    expect(route.providerName).toBe("a");
    expect(route.modelId).toBe("m1");
    const trace = route.routeDecision!;
    expect(trace.routeKind).toBe("policy");
    expect(trace.profile).toEqual({ id: "fast", revision: getRoutingProfile(config, "fast")!.revision });
    expect(trace.candidates.length).toBe(2);
    expect(trace.candidates[0]).toMatchObject({ provider: "a", model: "m1", eligible: true });
    expect(trace.candidates[1]).toMatchObject({ provider: "b", model: "m2", eligible: false });
    expect(trace.candidates[1]!.exclusions[0]!.code).toBe("capability-unsatisfied");
    expect(trace.selected.provider).toBe("a");
    expect(trace.selected.model).toBe("m1");
    expect(trace.candidates[0]!.score).toEqual({ total: 1, components: { configuredPriority: 1 } });
  });

  test("profile alias executes the same policy", () => {
    const route = routeModel(baseConfig(), "ocx/fast");
    expect(route.routeKind).toBe("policy");
    expect(route.providerName).toBe("a");
    expect(route.modelId).toBe("m1");
  });

  test("existing explicit, combo, native and default routes are unchanged", () => {
    const config = baseConfig();
    expect(routeModel(config, "a/m1")).toMatchObject({ routeKind: "explicit-provider", providerName: "a", modelId: "m1" });
    expect(routeModel(config, "combo/free")).toMatchObject({ routeKind: "combo", combo: { comboId: "free" } });
    expect(routeModel(config, "gpt-5.6")).toMatchObject({ routeKind: "native", providerName: "openai", modelId: "gpt-5.6" });
    expect(routeModel(config, "totally-unknown")).toMatchObject({ routeKind: "default-provider", providerName: "a" });
  });

  test("all candidates excluded throws NoEligiblePolicyCandidateError", () => {
    const config = baseConfig({
      routingProfiles: {
        strict: {
          candidates: [{ provider: "b", model: "m2" }],
          require: { minContextWindow: 128000 },
        },
      },
    });
    expect(() => routeModel(config, "policy/strict")).toThrow(NoEligiblePolicyCandidateError);
  });

  test("unknown capability follows the profile unknownEvidence (exclude default)", () => {
    // Provider "b" has no parallelToolCalls and no catalog row: tools unknown.
    const config = baseConfig({
      routingProfiles: {
        toolsOnly: {
          candidates: [{ provider: "b", model: "m2" }],
          require: { tools: true },
        },
      },
    });
    expect(() => routeModel(config, "policy/toolsOnly")).toThrow(NoEligiblePolicyCandidateError);

    const permissive = baseConfig({
      routingProfiles: {
        toolsOnly: {
          candidates: [{ provider: "b", model: "m2" }],
          require: { tools: true },
          unknownEvidence: { capability: "allow", health: "penalize", quota: "penalize", cost: "penalize" },
        },
      },
    });
    const route = routeModel(permissive, "policy/toolsOnly");
    expect(route.providerName).toBe("b");
    expect(route.modelId).toBe("m2");
  });

  test("request evidence constrains candidates: image input excludes non-image models", () => {
    const config = baseConfig({
      routingProfiles: {
        image: { candidates: [{ provider: "b", model: "m2" }] },
      },
    });
    // No image in the request: the request requirement is absent; b is eligible.
    const plain = routeModel(config, "policy/image");
    expect(plain.providerName).toBe("b");
    // Image request: b's modalities are text-only -> excluded.
    expect(() => routeModel(config, "policy/image", { imageInputRequired: true })).toThrow(NoEligiblePolicyCandidateError);
  });

  test("request tools requirement is enforced when provably needed", () => {
    const config = baseConfig({
      routingProfiles: {
        tools: { candidates: [{ provider: "b", model: "m2" }] },
      },
    });
    expect(routeModel(config, "policy/tools")).toMatchObject({ providerName: "b", modelId: "m2" });
    // b's tools support is unknown -> request requiring tools excludes it.
    expect(() => routeModel(config, "policy/tools", { toolsRequired: true })).toThrow(NoEligiblePolicyCandidateError);
  });

  test("policy selection is deterministic across calls", () => {
    const config = baseConfig();
    const first = routeModel(config, "policy/fast");
    const second = routeModel(config, "policy/fast");
    expect(first.providerName).toBe(second.providerName);
    expect(first.modelId).toBe(second.modelId);
    expect(first.routeDecision!.selected).toEqual(second.routeDecision!.selected);
  });

  test("evidenceFromBody detects nested image parts in real request shapes", () => {
    // Responses-shaped body: image block nested under input[].content[].
    const responses = {
      model: "policy/image",
      input: [
        {
          role: "user",
          type: "message",
          content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: "https://example.test/x.png" },
          ],
        },
      ],
    };
    expect(evidenceFromBody(responses)).toEqual({ imageInputRequired: true });

    // Chat-shaped body: image block nested under messages[].content[].
    const chat = {
      model: "policy/image",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "https://example.test/x.png" } },
          ],
        },
      ],
    };
    expect(evidenceFromBody(chat)).toEqual({ imageInputRequired: true });

    // Tools remain a top-level signal.
    expect(evidenceFromBody({ model: "policy/t", tools: [{ type: "function", function: { name: "f" } }] }))
      .toEqual({ toolsRequired: true });

    // Plain text-only bodies produce no evidence.
    expect(evidenceFromBody({
      model: "policy/x",
      input: [{ role: "user", type: "message", content: [{ type: "input_text", text: "hi" }] }],
    })).toEqual({});
  });

  test("compact-style policy dispatch applies request evidence", () => {
    const config = baseConfig({
      routingProfiles: {
        image: { candidates: [{ provider: "b", model: "m2" }] },
      },
    });
    // Mirrors src/server/responses/compact.ts: routeModel(config, raw.model, evidenceFromBody(raw)).
    const compactBody = {
      model: "policy/image",
      input: [{
        role: "user",
        type: "message",
        content: [{ type: "input_image", image_url: "https://example.test/x.png" }],
      }],
    };
    // b/m2 is text-only, so a provably-image request must be excluded - the
    // evidence has to reach the first policy evaluation.
    expect(() => routeModel(config, compactBody.model as string, evidenceFromBody(compactBody)))
      .toThrow(NoEligiblePolicyCandidateError);
  });

  test("no-eligible policy error carries the evaluation trace", () => {
    const config = baseConfig({
      routingProfiles: {
        strict: {
          candidates: [{ provider: "b", model: "m2" }],
          require: { minContextWindow: 128000 },
        },
      },
    });
    let caught: NoEligiblePolicyCandidateError | undefined;
    try {
      routeModel(config, "policy/strict");
    } catch (err) {
      caught = err as NoEligiblePolicyCandidateError;
    }
    expect(caught).toBeDefined();
    expect(caught!.profileId).toBe("strict");
    expect(caught!.trace).toBeDefined();
    expect(caught!.trace!.selected.reason).toBe("no-eligible-candidate");
    expect(caught!.trace!.candidates).toHaveLength(1);
    expect(caught!.trace!.candidates![0]!.exclusions[0]!.code).toBe("capability-unsatisfied");
  });

  test("policy provider name is a reserved routing namespace (combo stays usable)", () => {
    expect(isValidProviderName("policy")).toBe(false);
    // A physical provider named `combo` is a supported pattern (combo aliases
    // hosted on the combo provider); only the policy namespace is reserved.
    expect(isValidProviderName("combo")).toBe(true);
    expect(isValidProviderName("openai")).toBe(true);
    expect(isValidProviderName("my-provider_2")).toBe(true);
  });
});
