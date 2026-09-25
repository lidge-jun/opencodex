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
