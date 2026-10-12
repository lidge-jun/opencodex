import { describe, expect, test } from "bun:test";
import { gatewayModeExplanation } from "../../src/cli/claude-desktop";
import type { ClientConnectionState } from "../../src/client/state";

const disconnected = { kind: "disconnected" } as ClientConnectionState;
const connected = { kind: "connected" } as unknown as ClientConnectionState;

describe("gateway apply explains the first-party alternative", () => {
  test("a stored gateway marker is named as the reason, with the command that switches", () => {
    const lines = gatewayModeExplanation({
      requestedExplicitly: false,
      config: { claudeCode: { desktopProfile: { appliedFingerprint: "abc123" } } },
      connection: disconnected,
    });

    expect(lines.join("\n")).toContain("previous gateway apply");
    expect(lines.join("\n")).toContain("ocx claude desktop apply --first-party");
  });

  test("an explicit saved desktopMode is named as itself, not as a leftover marker", () => {
    const lines = gatewayModeExplanation({
      requestedExplicitly: false,
      config: { claudeCode: { desktopMode: "gateway" } },
      connection: disconnected,
    });

    expect(lines.join("\n")).toContain("desktopMode saved as gateway");
  });

  test("asking for gateway explicitly says nothing, because the user already chose", () => {
    expect(gatewayModeExplanation({
      requestedExplicitly: true,
      config: { claudeCode: { desktopProfile: { appliedFingerprint: "abc123" } } },
      connection: disconnected,
    })).toEqual([]);
  });

  test("a connected client says nothing, because first-party cannot run there", () => {
    expect(gatewayModeExplanation({
      requestedExplicitly: false,
      config: { claudeCode: { desktopProfile: { appliedFingerprint: "abc123" } } },
      connection: connected,
    })).toEqual([]);
  });

  test("a fresh machine names gateway as the default and pairs the first-party command with the account risk", () => {
    const text = gatewayModeExplanation({
      requestedExplicitly: false,
      config: {},
      connection: disconnected,
    }).join("\n");

    expect(text).toContain("gateway is the default");
    expect(text).toContain("ocx claude desktop apply --first-party");
    expect(text).toContain("Account risk:");
    expect(text).toContain("suspend the account");
  });

  test("every explanation that offers first-party also carries the account risk", () => {
    for (const config of [{}, { claudeCode: { desktopMode: "gateway" as const } }, { claudeCode: { desktopProfile: { appliedFingerprint: "abc123" } } }]) {
      const text = gatewayModeExplanation({ requestedExplicitly: false, config, connection: disconnected }).join("\n");
      expect(text).toContain("--first-party");
      expect(text).toContain("Account risk:");
    }
  });

  test("a disabled intercept says nothing, because first-party cannot run there", () => {
    expect(gatewayModeExplanation({
      requestedExplicitly: false,
      config: { claudeCode: { intercept: { enabled: false } } },
      connection: disconnected,
    })).toEqual([]);
  });
});
