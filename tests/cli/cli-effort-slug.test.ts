import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEffortCommand } from "../../src/cli/effort";
import { COMMAND_CODE_MODEL_REASONING_EFFORTS } from "../../src/providers/command-code-efforts";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { encodeRoutedModelId } from "../../src/providers/slug-codec";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Codex-facing slug and native id for the Command Code routes named in #5096. The slug form is
 * the one the Codex catalog shows (inner "/" encoded by `encodeRoutedModelId`), and the native
 * form is the key the provider ladder is registered under.
 */
const ROUTED_MODELS = [
  { native: "deepseek/deepseek-v4.1-flash", codexSlug: "deepseek-deepseek-v4.1-flash" },
  { native: "z-ai/glm-5.3-flashx", codexSlug: "z-ai-glm-5.3-flashx" },
  { native: "google/gemini-3.8-flash", codexSlug: "google-gemini-3.8-flash" },
] as const;

const COMMAND_CODE = "command-code";

/** Ladder read from the SSOT rather than restated, so no tier is invented here. */
function ladderFor(nativeId: string): string[] {
  const ladder = COMMAND_CODE_MODEL_REASONING_EFFORTS[nativeId];
  if (!ladder) throw new Error(`Command Code reasoning ladder missing for ${nativeId}`);
  return ladder;
}

let tempHome: string | null = null;
const savedHome = process.env.OPENCODEX_HOME;
let logOrig = console.log;
let errorOrig = console.error;

beforeEach(() => {
  logOrig = console.log;
  errorOrig = console.error;
  tempHome = mkdtempSync(join(tmpdir(), "ocx-effort-slug-test-"));
  process.env.OPENCODEX_HOME = tempHome;
  // Transport fields mirror the registry entry, and the ladder is the registry's own table:
  // this is the row a signed-in Command Code provider resolves to.
  const initialConfig: OcxConfig = {
    port: 10100,
    defaultProvider: COMMAND_CODE,
    providers: {
      [COMMAND_CODE]: {
        adapter: "command-code",
        baseUrl: "https://api.commandcode.ai",
        authMode: "oauth",
        modelReasoningEfforts: COMMAND_CODE_MODEL_REASONING_EFFORTS,
      },
    },
  } as unknown as OcxConfig;
  writeFileSync(join(tempHome, "config.json"), JSON.stringify(initialConfig, null, 2), "utf8");
});

afterEach(() => {
  console.log = logOrig;
  console.error = errorOrig;
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) {
    removeTreeWithRetry(tempHome);
    tempHome = null;
  }
});

async function inspect(target: string, json: boolean): Promise<{ code: number; out: string; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(" ")); };
  console.error = (...parts: unknown[]) => { errors.push(parts.map(String).join(" ")); };
  const argv = json ? ["model", target, "--json"] : ["model", target];
  const code = await handleEffortCommand(argv, {});
  return { code, out: logs.join("\n"), errors };
}

async function inspectJson(target: string): Promise<Record<string, unknown>> {
  const { code, out, errors } = await inspect(target, true);
  expect(errors).toEqual([]);
  expect(code).toBe(0);
  return JSON.parse(out) as Record<string, unknown>;
}

describe("ocx effort model routed-slug resolution", () => {
  test("the #5096 slug literals are what the codec encodes these native ids to", () => {
    for (const { native, codexSlug } of ROUTED_MODELS) {
      expect(encodeRoutedModelId(native)).toBe(codexSlug);
    }
  });

  test("the configured Command Code row matches the registry transport and ladder", () => {
    const entry = getProviderRegistryEntry(COMMAND_CODE);
    expect(entry?.adapter).toBe("command-code");
    expect(entry?.baseUrl).toBe("https://api.commandcode.ai");
    expect(entry?.modelReasoningEfforts).toEqual(COMMAND_CODE_MODEL_REASONING_EFFORTS);
  });

  for (const { native, codexSlug } of ROUTED_MODELS) {
    test(`${COMMAND_CODE}/${codexSlug} resolves to ${native} and reports its registry ladder`, async () => {
      const result = await inspectJson(`${COMMAND_CODE}/${codexSlug}`);
      expect(result.model).toBe(native);
      expect(result.requestedModel).toBe(codexSlug);
      expect(result.supportedEfforts).toEqual(ladderFor(native));
    });

    test(`${COMMAND_CODE}/${native} reports the same ladder without a resolution note`, async () => {
      const result = await inspectJson(`${COMMAND_CODE}/${native}`);
      expect(result.model).toBe(native);
      expect(result.requestedModel).toBeUndefined();
      expect(result.supportedEfforts).toEqual(ladderFor(native));
    });
  }

  test("text output names the resolved id and the slug it came from", async () => {
    const { native, codexSlug } = ROUTED_MODELS[0];
    const { code, out } = await inspect(`${COMMAND_CODE}/${codexSlug}`, false);
    expect(code).toBe(0);
    expect(out).toContain(`Reasoning effort configuration for ${COMMAND_CODE}/${native}:`);
    expect(out).toContain(`  Resolved from: ${codexSlug}`);
    expect(out).toContain(`Supported ladder:   ${ladderFor(native).join(", ")}`);
  });

  test("a native id in text output carries no resolution note", async () => {
    const { native } = ROUTED_MODELS[0];
    const { code, out } = await inspect(`${COMMAND_CODE}/${native}`, false);
    expect(code).toBe(0);
    expect(out).toContain(`Reasoning effort configuration for ${COMMAND_CODE}/${native}:`);
    expect(out).not.toContain("Resolved from:");
  });

  test("an unresolvable id keeps today's output: no ladder, no requestedModel", async () => {
    const result = await inspectJson(`${COMMAND_CODE}/not-a-real-model`);
    expect(result.model).toBe("not-a-real-model");
    expect(result.requestedModel).toBeUndefined();
    expect(result.supportedEfforts).toBeNull();
  });
});

