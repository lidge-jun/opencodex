import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { snapshotComboAdmission } from "../../src/server/responses/combo-admission-snapshot";
import { repoPath } from "../helpers/repo-root";
import { duringDecision, LUNA, SOL, perTurnConfig, resetState, served, turn, unionConfig, type Child } from "../helpers/jev-session-pin";

beforeEach(resetState);
afterEach(() => { mock.restore(); resetState(); });

test("a protocol policy change during the paid decision applies to the next request", async () => {
  const decisions: Record<string, unknown>[] = [];
  const config = perTurnConfig(["sol/gpt-5.6-sol:high"], decisions);
  config.combos!.auto!.targets = [{ ...SOL }];
  config.providers.sol!.adapter = "openai-responses";
  config.protocols = { unrepresentable: "legacy", rollout: { nativeChatCombos: true } };
  duringDecision(config, () => { config.protocols!.unrepresentable = "reject"; });

  const models: string[] = [];
  const chatSource = { model: "jev-auto", messages: [{ role: "user", content: "hello" }], n: 2, stream: false };
  // Admitted under legacy, the in-flight request keeps the bridge it was admitted with.
  expect((await turn(config, { chatSource, models })).status).toBe(200);
  expect(models).toEqual([`${SOL.provider}/${SOL.model}`]);
  // The next request is admitted under reject and refused before any decision.
  expect((await turn(config, { chatSource, models })).status).toBe(400);
  expect(models).toHaveLength(1);
  expect(decisions).toHaveLength(1);
});

test.each(["degrade", "reject"] as const)("a mandatory tool capability change applies to the next request (%s)", async policy => {
  const decisions: Record<string, unknown>[] = [];
  const config = unionConfig(["sol/gpt-5.6-sol:high", "sol/gpt-5.6-sol:high"], decisions);
  const combo = config.combos!.auto!;
  combo.targets = [{ ...SOL }, { ...LUNA }];
  combo.onUnservable = policy;
  config.providers.sol!.inputModalities = ["text", "image"];
  config.providers.luna!.inputModalities = ["text"];
  config.visionSidecar = { enabled: false };
  duringDecision(config, () => { config.providers.sol!.autoToolChoiceOnlyModels = [SOL.model]; });

  const omissions: (boolean | undefined)[] = [];
  const models: string[] = [];
  const request = {
    models,
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
    bodyFields: { tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }], tool_choice: "required" },
    child: ((body, complete, options) => {
      omissions.push(options.comboOmitImages);
      return served(body, complete, options);
    }) satisfies Child,
  };
  // The in-flight request was admitted while sol could keep the mandatory tool and the image.
  expect((await turn(config, request)).status).toBe(200);
  expect(models).toEqual([`${SOL.provider}/${SOL.model}`]);
  // The next one can only reach luna, which cannot take the image.
  expect((await turn(config, request)).status).toBe(policy === "degrade" ? 200 : 400);
  expect(models).toEqual(policy === "degrade"
    ? [`${SOL.provider}/${SOL.model}`, `${LUNA.provider}/${LUNA.model}`] : [`${SOL.provider}/${SOL.model}`]);
  expect(omissions).toEqual(policy === "degrade" ? [undefined, true] : [undefined]);
});

test("admission helper metadata reads are represented in the snapshot", async () => {
  const config = perTurnConfig([], []);
  const { providers, customModels, providerContextCaps, vision } = snapshotComboAdmission({
    ...config, visionSidecar: { enabled: true },
  }, "auto");
  const provider = providers.sol!;
  const gateConfig = { providers, customModels, providerContextCaps, visionSidecar: vision };
  const sources = [
    ["src/combos/request-capability.ts", "provider", provider],
    ["src/adapters/anthropic/advisor-tool.ts", "provider", provider, "advisorServerToolDestination"],
    ["src/protocols/opaque-state.ts", "provider", provider, "credentialDomainFor"],
    ["src/server/responses/combo-required-tool-contract.ts", "provider", provider],
    ["src/server/chat-native-eligibility.ts", "provider", provider],
    ["src/adapters/openai-responses/passthrough.ts", "provider", provider, "requiresPlaintextReasoningReplay"],
    ["src/server/effort-policy.ts", "provider", provider, "supportedLadderFor"],
    ["src/vision/plan.ts", "provider", provider, "requiresVisionPreprocessing"],
    ["src/codex/catalog/metadata.ts", "config", gateConfig, "nativeContextLimits"],
    ["src/combos/request-capability.ts", "config", gateConfig],
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
});

test("admission metadata snapshots skip top-level and nested getters", () => {
  const config = perTurnConfig([], []);
  let calls = 0;
  const getter = { enumerable: true, get() { calls++; return 128_000; } };
  const provider = config.providers.sol!;
  Object.defineProperty(provider, "contextWindow", getter);
  provider.modelContextWindows = { other: 42_000 };
  Object.defineProperty(provider.modelContextWindows, SOL.model, getter);
  const snapshot = snapshotComboAdmission(config, "auto").providers.sol!;
  expect(calls).toBe(0);
  expect(snapshot.contextWindow).toBeUndefined();
  expect(snapshot.modelContextWindows).toEqual({ other: 42_000 });
});
