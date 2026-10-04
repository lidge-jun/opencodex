import { unifiedPoolSettingsDto } from "../../src/oauth/pool-settings-capability";
/**
 * `apiSurfaces` and `protocols` resolution (src/protocols/settings.ts).
 *
 * The Messages surface must never open because a value was malformed: a mistyped explicit value
 * closes it, and only an absent value inherits the legacy `claudeCode.enabled` meaning. Every
 * protocol rollout switch defaults off.
 */
import { describe, expect, test } from "bun:test";
import {
  protocolPolicyRevision,
  resolveApiSurfaceSettings,
  resolveProtocolSettings,
} from "../../src/protocols/settings";
import { configSchema } from "../../src/config/schema/config-schema";
import { validateConfigCandidate } from "../../src/config/diagnostics";
import type { OcxConfig } from "../../src/types";

function cfg(extra: Record<string, unknown>): OcxConfig {
  return extra as unknown as OcxConfig;
}

describe("API surface resolution", () => {
  test("Responses and Chat are fixed on", () => {
    const surfaces = resolveApiSurfaceSettings(cfg({ apiSurfaces: { messages: { enabled: false } } }));
    expect(surfaces.responses).toEqual({ enabled: true, source: "fixed" });
    expect(surfaces.chat).toEqual({ enabled: true, source: "fixed" });
  });

  test("absent value inherits claudeCode.enabled", () => {
    expect(resolveApiSurfaceSettings(cfg({})).messages).toEqual({ enabled: true, source: "claude-code-legacy" });
    expect(resolveApiSurfaceSettings(cfg({ claudeCode: { enabled: false } })).messages)
      .toEqual({ enabled: false, source: "claude-code-legacy" });
    expect(resolveApiSurfaceSettings(cfg({ apiSurfaces: {} })).messages.source).toBe("claude-code-legacy");
    expect(resolveApiSurfaceSettings(cfg({ apiSurfaces: { messages: {} } })).messages.source).toBe("claude-code-legacy");
  });

  test("an explicit boolean wins over the legacy key in both directions", () => {
    expect(resolveApiSurfaceSettings(cfg({ apiSurfaces: { messages: { enabled: true } }, claudeCode: { enabled: false } })).messages)
      .toEqual({ enabled: true, source: "api-surfaces" });
    expect(resolveApiSurfaceSettings(cfg({ apiSurfaces: { messages: { enabled: false } } })).messages)
      .toEqual({ enabled: false, source: "api-surfaces" });
  });

  test("malformed values close the surface instead of inheriting", () => {
    for (const apiSurfaces of ["on", [], { messages: "yes" }, { messages: { enabled: "false" } }, { messages: { enabled: null } }]) {
      expect(resolveApiSurfaceSettings(cfg({ apiSurfaces })).messages).toEqual({ enabled: false, source: "invalid" });
    }
  });
});

describe("protocol settings resolution", () => {
  test("defaults are legacy policy with every rollout switch off", () => {
    expect(resolveProtocolSettings(cfg({}))).toEqual({
      unrepresentable: "legacy",
      rollout: {
        nativeChatCombos: false,
        managedMessagesNative: false,
        managedMessagesNativeOAuth: false,
        directEncoders: false,
        shadowPlan: false,
      },
    });
  });

  test("only literal true enables a switch and OAuth requires the key-auth switch", () => {
    const settings = resolveProtocolSettings(cfg({
      protocols: { unrepresentable: "reject", rollout: { directEncoders: "true", managedMessagesNativeOAuth: true } },
    }));
    expect(settings.unrepresentable).toBe("reject");
    expect(settings.rollout.directEncoders).toBe(false);
    expect(settings.rollout.managedMessagesNativeOAuth).toBe(false);
  });

  test("policy revision changes with a relevant setting and ignores unrelated config", () => {
    const base = protocolPolicyRevision(cfg({}));
    expect(protocolPolicyRevision(cfg({ port: 1234 }))).toBe(base);
    expect(protocolPolicyRevision(cfg({ protocols: { unrepresentable: "reject" } }))).not.toBe(base);
    expect(protocolPolicyRevision(cfg({ claudeCode: { enabled: false } }))).not.toBe(base);
    expect(base).toMatch(/^p1-[0-9a-f]{8}$/);
  });
});


describe("Anthropic pool native Messages preference", () => {
  test("pool defaults are provider scoped and explicit false always wins", () => {
    const config = cfg({ anthropicAccountPool: { enabled: true } });
    expect(resolveProtocolSettings(config, "anthropic").rollout).toMatchObject({ managedMessagesNative: true, managedMessagesNativeOAuth: true });
    for (const provider of [undefined, "compatible", ""]) expect(resolveProtocolSettings(config, provider).rollout.managedMessagesNative).toBe(false);
    for (const rollout of [
      { managedMessagesNative: false, managedMessagesNativeOAuth: true },
      { managedMessagesNative: false },
      { managedMessagesNative: true, managedMessagesNativeOAuth: false },
      { managedMessagesNativeOAuth: false },
    ]) {
      config.protocols = { rollout };
      expect(resolveProtocolSettings(config, "anthropic").rollout).toMatchObject({
        managedMessagesNative: rollout.managedMessagesNative !== false,
        managedMessagesNativeOAuth: false,
      });
      expect(config.protocols.rollout).toEqual(rollout);
    }
  });
  test("malformed present native policy fails closed", () => {
    for (const protocols of [null, [], "on", { rollout: null }, { rollout: "on" }, { rollout: { managedMessagesNative: null } }, { rollout: { managedMessagesNative: "true" } }]) {
      expect(resolveProtocolSettings(cfg({ protocols, anthropicAccountPool: { enabled: true } }), "anthropic").rollout).toMatchObject({ managedMessagesNative: false, managedMessagesNativeOAuth: false });
    }
    for (const nativeMessages of [null, "true", 1, false]) expect(resolveProtocolSettings(cfg({ anthropicAccountPool: { enabled: true, nativeMessages }, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } }), "anthropic").rollout.managedMessagesNative).toBe(false);
  });
  test("an enabled pool's explicit false selects legacy; true selects native", () => {
    for (const nativeMessages of [false, true]) expect(resolveProtocolSettings(cfg({ anthropicAccountPool: { enabled: true, nativeMessages }, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } }), "anthropic").rollout).toMatchObject({ managedMessagesNative: nativeMessages, managedMessagesNativeOAuth: nativeMessages });
  });
  test("disabled and absent pools retain explicit protocol behavior", () => {
    for (const pool of [undefined, { enabled: false, nativeMessages: true }, { enabled: false, nativeMessages: false }]) {
      expect(resolveProtocolSettings(cfg({ anthropicAccountPool: pool })).rollout.managedMessagesNative).toBe(false);
      expect(resolveProtocolSettings(cfg({ anthropicAccountPool: pool, protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } })).rollout.managedMessagesNativeOAuth).toBe(true);
    }
  });
});


test("the config schema validates nativeMessages as a boolean while retaining pool fields", () => {
  const poolSchema = configSchema.shape.anthropicAccountPool;
  for (const nativeMessages of [true, false]) {
    const result = poolSchema.safeParse({ enabled: true, nativeMessages, stickyLimit: 3 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toMatchObject({ nativeMessages, stickyLimit: 3 });
  }
  for (const nativeMessages of ["false", null, 0]) {
    expect(poolSchema.parse({ enabled: true, nativeMessages, stickyLimit: 3 })).toMatchObject({ nativeMessages: false, stickyLimit: 3 });
    const candidate = validateConfigCandidate({ anthropicAccountPool: { nativeMessages } });
    expect(candidate.ok).toBe(false);
    if (!candidate.ok) expect(candidate.error).toContain("anthropicAccountPool.nativeMessages");
  }
  for (const anthropicAccountPool of [null, "false", 0]) {
    expect(poolSchema.parse(anthropicAccountPool)).toBeUndefined();
    expect(validateConfigCandidate({ anthropicAccountPool }).ok).toBe(false);
  }
});

test("policy revision records explicit native flags even when Anthropic pool defaults mask them", () => {
  const config = { providers: {}, anthropicAccountPool: { enabled: true } } as OcxConfig;
  const before = protocolPolicyRevision(config);
  config.protocols = { rollout: { managedMessagesNative: true } };
  expect(protocolPolicyRevision(config)).not.toBe(before);
});

test("revision retains absent, true, false and invalid inputs masked by other gates", () => {
  const revisions = [undefined, true, false, "on", null].map(value => protocolPolicyRevision(cfg({
    anthropicAccountPool: { enabled: false, ...(value === undefined ? {} : { nativeMessages: value }) },
    protocols: { rollout: { managedMessagesNative: false, ...(value === undefined ? {} : { managedMessagesNativeOAuth: value }) } },
  })));
  // Both malformed forms normalize to invalid; every other input state remains distinct.
  expect(new Set(revisions).size).toBe(4);
});


test("raw pool DTOs resolve absent to true, malformed to false and unsupported to null", () => {
  for (const nativeMessages of [true, false, null, "true", 1]) {
    const config = cfg({ providers: {}, anthropicAccountPool: { nativeMessages } });
    expect(unifiedPoolSettingsDto(config, "anthropic", "anthropic").nativeMessages).toBe(nativeMessages === true);
    expect(unifiedPoolSettingsDto(config, "openai", "codex").nativeMessages).toBeNull();
    expect(unifiedPoolSettingsDto(config, "compatible", "generic").nativeMessages).toBeNull();
  }
  expect(unifiedPoolSettingsDto(cfg({ providers: {} }), "anthropic", "anthropic").nativeMessages).toBe(true);
});
