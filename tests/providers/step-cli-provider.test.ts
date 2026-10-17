import { describe, expect, test } from "bun:test";

import { createStepCliAdapter } from "../../src/adapters/step-cli/adapter";
import { buildStepCliArgs, findStepCliBinary, resolveStepCliProfile, STEP_CLI_PROFILE } from "../../src/adapters/step-cli/profiles";
import { resolveAdapter } from "../../src/server";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  STEP_CLI_MODEL_CONTEXT_WINDOWS,
  STEP_CLI_MODELS,
  STEP_CLI_NO_VISION_MODELS,
  STEP_CLI_REASONING_EFFORTS,
} from "../../src/providers/registry/model-seeds";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const BASE_URL = "https://api.stepfun.com/step_plan";

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "step-cli");
  if (!entry) throw new Error("StepCode registry entry not found");
  return entry;
}

function providerConfig(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return { adapter: "step-cli", baseUrl: BASE_URL, authMode: "key", ...overrides } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "step-5-preview",
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }], tools: [] },
    options: {},
    ...overrides,
  } as unknown as OcxParsedRequest;
}

describe("StepCode provider", () => {
  test("is registered as a keyless-but-key-classified subscription route", () => {
    expect(registryEntry()).toMatchObject({
      id: "step-cli",
      label: "StepCode CLI (subscription)",
      adapter: "step-cli",
      baseUrl: BASE_URL,
      authKind: "key",
      keyOptional: true,
      defaultModel: "step-5-preview",
      liveModels: false,
    });
    // The traffic leaves the machine, so `local` would misreport the row's credential class; it is
    // keyless because the CLI reads the operator's own `step login`.
    expect(registryEntry().authKind).not.toBe("local");
  });

  test("publishes the Step Plan roster with its measured windows and a text-only contract", () => {
    const entry = registryEntry();
    expect(entry.models).toEqual([...STEP_CLI_MODELS]);
    // Speech models the same endpoint returns are absent: a row that routed a text turn into one
    // answers `model_invalid`.
    expect(entry.models?.some(id => id.startsWith("stepaudio"))).toBe(false);
    expect(entry.modelContextWindows).toEqual(STEP_CLI_MODEL_CONTEXT_WINDOWS);
    expect(STEP_CLI_MODEL_CONTEXT_WINDOWS["step-5-preview"]).toBe(1_024_000);
    // Even the models that accept images upstream are published text-only on this route.
    expect(entry.noVisionModels).toEqual(STEP_CLI_NO_VISION_MODELS);
    expect(entry.noVisionModels).toContain("step-5-preview");
  });

  test("advertises only the three reasoning rungs Step actually serves", () => {
    expect(registryEntry().reasoningEfforts).toEqual(STEP_CLI_REASONING_EFFORTS);
    // `xhigh`/`max` are mapped server-side onto `high`; publishing them would let the client believe
    // it chose a depth it did not.
    expect(registryEntry().reasoningEfforts).not.toContain("xhigh");
    expect(registryEntry().reasoningEfforts).not.toContain("max");
  });

  test("is reachable from the derived preset catalog and seeds a usable config", () => {
    const preset = deriveProviderPresets().find(provider => provider.id === "step-cli");
    expect(preset).toMatchObject({ id: "step-cli", adapter: "step-cli", baseUrl: BASE_URL });
    const seed = providerConfigSeed(registryEntry());
    expect(seed.baseUrl).toBe(BASE_URL);
    expect(seed.keyOptional).toBe(true);
  });

  test("resolves through the adapter registry to the step-cli adapter", () => {
    expect(resolveAdapter(providerConfig()).name).toBe("step-cli");
  });

  test("fails closed when the row is pointed away from StepCode's own destination", () => {
    // The CLI owns the credential, so a row repointed elsewhere would spend it against a host the
    // adapter cannot speak to. Refusing is the only safe answer.
    expect(resolveStepCliProfile("https://evil.example/v1")).toBeUndefined();
    expect(resolveStepCliProfile(BASE_URL)).toBe(STEP_CLI_PROFILE);
    expect(resolveStepCliProfile(`${BASE_URL}/`)).toBe(STEP_CLI_PROFILE);
  });

  test("refuses a mismatched destination before any request is built", async () => {
    const adapter = createStepCliAdapter(providerConfig({ baseUrl: "https://evil.example/v1" }));
    const events: unknown[] = [];
    await adapter.runTurn!(parsed(), { headers: new Headers() } as never, event => events.push(event));
    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "step_cli_profile_mismatch", status: 400 }),
    ]);
  });

  test("refuses image input rather than answering a picture blind", async () => {
    const adapter = createStepCliAdapter(providerConfig());
    const events: Array<Record<string, unknown>> = [];
    const withImage = parsed({
      context: {
        messages: [
          { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,AAAA" }], timestamp: 0 },
        ],
        tools: [],
      },
    });
    await adapter.runTurn!(withImage, { headers: new Headers() } as never, event => events.push(event as never));
    expect(events[0]).toMatchObject({ type: "error", code: "unsupported_input_modality", status: 400 });
  });

  test("spawns the CLI with every host-config switch disabled", () => {
    const args = buildStepCliArgs("step-3.7-flash", "medium");
    expect(args[0]).toBe("--sdk-stdio");
    for (const flag of [
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-session",
      "--no-update-check",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("--model");
    expect(args).toContain("step-3.7-flash");
    expect(args).toContain("--thinking");
    expect(args).toContain("medium");
  });

  test("finds the self-installed CLI when PATH does not carry it", () => {
    const absent = findStepCliBinary("step", () => undefined, "/nonexistent-home");
    expect(absent).toBeUndefined();
    // A PATH hit always wins, so an operator who installed it elsewhere keeps their own binary.
    expect(findStepCliBinary("step", () => "/opt/homebrew/bin/step", "/nonexistent-home")).toBe("/opt/homebrew/bin/step");
  });
});
