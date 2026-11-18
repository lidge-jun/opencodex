import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveProtocolSettings } from "../../src/protocols/settings";
import { snapshotComboAdmission } from "../../src/server/responses/combo-admission-snapshot";
import { repoPath } from "../helpers/repo-root";

import type { OcxConfig } from "../../src/types";
import { LUNA, SOL, perTurnConfig, resetState, served, turn } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(resetState);

function changeDuringReadmission(config: OcxConfig, change: () => void): void {
  const decide = config.providers.jev!.fetch!;
  const provider = config.providers.sol!;
  config.providers.jev!.fetch = (async (input, init) => {
    Object.defineProperty(provider, "contextWindow", {
      configurable: true,
      enumerable: true,
      get() {
        Object.defineProperty(provider, "contextWindow", { value: 128_000, writable: true });
        queueMicrotask(change);
        return 128_000;
      },
    });
    return decide(input, init);
  }) as typeof fetch;
}

test("a protocol policy change returns the same refusal as ingress", async () => {
  const decisions: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], decisions);
  config.combos!.auto!.targets = [{ ...SOL }];
  config.providers.sol!.adapter = "openai-responses";
  config.protocols = { unrepresentable: "legacy", rollout: { nativeChatCombos: true } };
  changeDuringReadmission(config, () => { config.protocols!.unrepresentable = "reject"; });

  const models: string[] = [];
  const chatSource = { model: "jev-auto", messages: [{ role: "user", content: "hello" }], n: 2, stream: false };
  const response = await turn(config, { chatSource, models });
  expect(response.status).toBe(400);
  const ingress = await turn(config, { chatSource, models });
  expect(ingress.status).toBe(400);
  expect(await response.json()).toEqual(await ingress.json());
  expect(models).toEqual([]);
  expect(decisions).toHaveLength(1);
});

test.each(["degrade", "reject"] as const)("mandatory tool capability changes replan image policy (%s)", async policy => {
  const decisions: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], decisions);
  const combo = config.combos!.auto!;
  combo.targets = [{ ...SOL }, { ...LUNA }];
  combo.capabilityPolicy = "union";
  combo.onUnservable = policy;
  config.providers.sol!.inputModalities = ["text", "image"];
  config.providers.luna!.inputModalities = ["text"];
  changeDuringReadmission(config, () => { config.providers.sol!.autoToolChoiceOnlyModels = [SOL.model]; });

  const omissions: (boolean | undefined)[] = [];
  const models: string[] = [];
  const response = await turn(config, {
    models,
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
    bodyFields: { tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }], tool_choice: "required" },
    child(body, complete, options) {
      omissions.push(options.comboOmitImages);
      return served(body, complete, options);
    },
  });
  expect(response.status).toBe(policy === "degrade" ? 200 : 400);
  expect(models).toEqual(policy === "degrade" ? [`${LUNA.provider}/${LUNA.model}`] : []);
  expect(omissions).toEqual(policy === "degrade" ? [true] : []);
  expect(decisions).toHaveLength(1);
});

test("admission helper metadata reads are represented in the snapshot", async () => {
  const config = perTurnConfig([], []);
  const { providers, routing, protocols, vision } = snapshotComboAdmission({
    ...config, visionSidecar: { enabled: true },
  }, "auto");
  const provider = providers.sol!;
  const sources = [
    ["src/combos/request-capability.ts", "provider", provider],
    ["src/adapters/anthropic/advisor-tool.ts", "provider", provider, "advisorServerToolDestination"],
    ["src/protocols/opaque-state.ts", "provider", provider, "credentialDomainFor"],
    ["src/server/responses/combo-required-tool-contract.ts", "provider", provider],
    ["src/server/chat-native-eligibility.ts", "provider", provider],
    ["src/adapters/openai-responses/passthrough.ts", "provider", provider, "requiresPlaintextReasoningReplay"],
    ["src/server/effort-policy.ts", "provider", provider, "supportedLadderFor"],
    ["src/vision/plan.ts", "provider", provider, "requiresVisionPreprocessing"],
    ["src/codex/account-namespaces.ts", "config", routing, "codexAccountNamespaceEntries"],
    ["src/codex/catalog/metadata.ts", "config", { providers, ...routing }, "nativeContextLimits"],
    ["src/combos/request-capability.ts", "config", { providers, visionSidecar: vision, ...routing }],
  ] as const;
  for (const [path, receiver, metadata, helper] of sources) {
    const source = await Bun.file(repoPath(path)).text();
    const body = helper ? source.split(`function ${helper}(`)[1]?.split(/^}/m)[0] : source;
    expect(body, path).toBeDefined();
    const reads = [...body!.matchAll(new RegExp(`\\b${receiver}\\??\\.([a-zA-Z]\\w*)`, "g"))];
    expect(reads.length, path).toBeGreaterThan(0);
    const missing = [...new Set(reads.map(([, field]) => field!))].filter(field => !Object.hasOwn(metadata, field));
    expect(missing, helper ?? path).toEqual([]);
  }
  // The settings resolver projects policy from the raw block and discards unknown fields.
  expect(protocols).toEqual(resolveProtocolSettings(config));
  config.protocols = { unrepresentable: "reject", rollout: { nativeChatCombos: true } };
  expect(snapshotComboAdmission(config, "auto").protocols).toMatchObject({
    unrepresentable: "reject", rollout: { nativeChatCombos: true },
  });
});
