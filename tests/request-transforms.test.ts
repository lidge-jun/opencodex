import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyRequestTransforms, clearTransformCacheForTests, resolveTransformPath } from "../src/transforms";
import { validateConfigCandidate } from "../src/config";
import { providerManagementConfigError } from "../src/server/auth-cors";
import { providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../src/types";

describe("requestTransforms", () => {
  let testDir: string;

  beforeEach(() => {
    clearTransformCacheForTests();
    testDir = join(tmpdir(), "ocx-test-transforms-" + Math.random().toString(36).slice(2));
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (_err) {
      void _err;
    }
  });

  test("resolveTransformPath resolves relative to configDir and absolute paths", () => {
    const fileInConfig = join(testDir, "custom.ts");
    writeFileSync(fileInConfig, "export default () => {};");

    const resolved = resolveTransformPath("custom.ts", testDir);
    expect(resolved).toBe(fileInConfig);

    const absPath = fileInConfig;
    expect(resolveTransformPath(absPath, testDir)).toBe(absPath);
  });

  test("applyRequestTransforms runs global and provider transforms and marks applied", async () => {
    const transform1Path = join(testDir, "t1.ts");
    const transform2Path = join(testDir, "t2.ts");

    writeFileSync(
      transform1Path,
      `export default function (parsed, ctx) {
        parsed.context.messages.push({
          role: "user",
          content: "transformed-by-t1 (" + ctx.providerName + ":" + ctx.modelId + ")",
          timestamp: Date.now(),
        });
      };`,
    );

    writeFileSync(
      transform2Path,
      `export function transform(parsed, ctx) {
        parsed.context.messages.push({
          role: "assistant",
          content: "transformed-by-t2 (acceptsImage:" + ctx.acceptsImageInput + ")",
          timestamp: Date.now(),
        });
        return parsed;
      };`,
    );

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://example.com",
          requestTransforms: [transform2Path],
        },
      },
      requestTransforms: [transform1Path],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gemini-3.1-pro",
      context: {
        messages: [],
      },
      stream: true,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "google-antigravity",
      modelId: "gemini-3.1-pro",
      providerConfig: config.providers["google-antigravity"],
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
    expect(result.context.messages.length).toBe(2);
    expect((result.context.messages[0] as any).content).toContain("transformed-by-t1 (google-antigravity:gemini-3.1-pro)");
    expect((result.context.messages[1] as any).content).toContain("transformed-by-t2");

    // Running again does not duplicate executions (single run per turn)
    await applyRequestTransforms({
      parsed: result,
      providerName: "google-antigravity",
      modelId: "gemini-3.1-pro",
      providerConfig: config.providers["google-antigravity"],
      config,
    });
    expect(result.context.messages.length).toBe(2);
  });

  test("gracefully handles failing or throwing transforms without crashing", async () => {
    const failingTransformPath = join(testDir, "failing.ts");
    writeFileSync(failingTransformPath, "export default () => { throw new Error(\"boom\"); };");

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://example.com" },
      },
      requestTransforms: [failingTransformPath, "non-existent-module-xyz"],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      context: { messages: [] },
      stream: false,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "openai",
      modelId: "gpt-5.5",
      providerConfig: config.providers.openai,
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
  });

  test("rejects malformed replacement objects like {} and retains current request", async () => {
    const invalidTransformPath = join(testDir, "invalid.ts");
    writeFileSync(invalidTransformPath, "export default () => { return {}; };");

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "openai",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://example.com" },
      },
      requestTransforms: [invalidTransformPath],
    };

    const initialParsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      context: { messages: [{ role: "user", content: "original-message", timestamp: 123 }] },
      stream: false,
      options: {},
    };

    const result = await applyRequestTransforms({
      parsed: initialParsed,
      providerName: "openai",
      modelId: "gpt-5.5",
      providerConfig: config.providers.openai,
      config,
    });

    expect(result._requestTransformsApplied).toBe(true);
    expect(result.modelId).toBe("gpt-5.5");
    expect(result.context.messages.length).toBe(1);
    expect((result.context.messages[0] as any).content).toBe("original-message");
  });

  test("configSchema and providerConfigSchema validate requestTransforms correctly", () => {
    const valid = validateConfigCandidate({
      port: 10100,
      defaultProvider: "openai",
      requestTransforms: ["./transforms/pxpipe.ts"],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://example.com",
          requestTransforms: ["./transforms/provider-transform.ts"],
        },
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.config.requestTransforms).toEqual(["./transforms/pxpipe.ts"]);
      expect(valid.config.providers.openai.requestTransforms).toEqual(["./transforms/provider-transform.ts"]);
    }
  });

  test("providerManagementConfigError validates canonical openai with requestTransforms", () => {
    const entry = getProviderRegistryEntry("openai");
    if (!entry) return;
    const seed = providerConfigSeed(entry);

    const validCandidate = { ...seed, codexAccountMode: "pool" as const, requestTransforms: ["./custom.ts"] };
    expect(providerManagementConfigError("openai", validCandidate)).toBeNull();

    const invalidCandidate = { ...seed, codexAccountMode: "pool" as const, requestTransforms: [""] };
    expect(providerManagementConfigError("openai", invalidCandidate))
      .toBe("provider openai requestTransforms.0 must be a nonblank string");
  });
});
