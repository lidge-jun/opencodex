import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { configSchema } from "../../src/config/schema/config-schema";
import { resolveNativeReasoningRetention } from "../../src/config/schema/native-reasoning-retention";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const off = { modelSwitch: false, accountSwitch: false };
const invalid = [null, [], true, "on", { modelSwitch: "true" }, { accountSwitch: 1 },
  { modelSwitch: true, accountSwitch: null }, { modelSwitch: true, endpointSwitch: true }];

describe("native reasoning retention configuration", () => {
  test("absent allowances stay off and valid partial booleans are preserved", () => {
    expect(getDefaultConfig().nativeReasoningRetention).toBeUndefined();
    expect(resolveNativeReasoningRetention(getDefaultConfig())).toEqual(off);
    for (const policy of [{}, { modelSwitch: true }, { accountSwitch: true },
      { modelSwitch: false, accountSwitch: true }, { modelSwitch: true, accountSwitch: true }]) {
      const candidate = { ...getDefaultConfig(), nativeReasoningRetention: policy };
      const parsed = validateConfigCandidate(candidate);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.config.nativeReasoningRetention).toEqual(policy);
        expect(resolveNativeReasoningRetention(parsed.config)).toEqual({
          modelSwitch: "modelSwitch" in policy && policy.modelSwitch === true,
          accountSwitch: "accountSwitch" in policy && policy.accountSwitch === true,
        });
      }
    }
  });

  test("invalid writes reject the whole block while invalid disk values disable both allowances", () => {
    for (const policy of invalid) {
      const candidate = { ...getDefaultConfig(), nativeReasoningRetention: policy };
      const result = validateConfigCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("nativeReasoningRetention");
      const parsed = configSchema.parse(candidate);
      expect(parsed.nativeReasoningRetention).toBeUndefined();
      expect(parsed.providers).toEqual(candidate.providers);
      expect(resolveNativeReasoningRetention(parsed)).toEqual(off);
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify(candidate));
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings?.join(" ")).toContain("nativeReasoningRetention ignored");
      expect(diagnostics.config.providers).toEqual(candidate.providers);
    }
  });

  test("load warns without discarding unrelated configuration", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-native-retention-config-"));
    process.env.OPENCODEX_HOME = home;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const candidate = { ...getDefaultConfig(), nativeReasoningRetention: { modelSwitch: true, accountSwitch: "true" } };
      writeFileSync(getConfigPath(), JSON.stringify(candidate), "utf8");
      const loaded = loadConfig();
      expect(loaded.nativeReasoningRetention).toBeUndefined();
      expect(loaded.providers).toEqual(candidate.providers);
      expect(warning.mock.calls.some(call => String(call[0]).includes("invalid nativeReasoningRetention"))).toBe(true);
    } finally {
      warning.mockRestore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });
});
