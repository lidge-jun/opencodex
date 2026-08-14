import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  dshConfigPath,
  dshHomeDir,
} from "../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";

const HOME = join(tmpdir(), "ocx-dsh-path-home");

describe("DSH 0.1.0-rc.6 path contract", () => {
  test("blank or absent DSH_HOME falls back to ~/.dsh", () => {
    for (const value of [undefined, "", "   ", "\t\n"]) {
      const env = value === undefined ? {} : { DSH_HOME: value };
      expect(dshHomeDir(env, HOME)).toBe(join(HOME, ".dsh"));
      expect(dshConfigPath(env, HOME)).toBe(join(HOME, ".dsh", "settings.yaml"));
    }
  });

  test("supports exact ~, slash and backslash home forms", () => {
    expect(dshHomeDir({ DSH_HOME: "~" }, HOME)).toBe(HOME);
    expect(dshHomeDir({ DSH_HOME: "~/profiles/work" }, HOME)).toBe(join(HOME, "profiles", "work"));
    expect(dshHomeDir({ DSH_HOME: "~\\profiles\\work" }, HOME)).toBe(join(HOME, "profiles\\work"));
  });

  test("preserves a nonblank raw absolute value instead of trimming it", () => {
    const absolute = join(tmpdir(), "dsh home");
    expect(dshHomeDir({ DSH_HOME: absolute }, HOME)).toBe(absolute);
    expect(dshHomeDir({ DSH_HOME: `${absolute} ` }, HOME)).toBe(`${absolute} `);
    expect(dshHomeDir({ DSH_HOME: join(absolute, "..", "normalized") }, HOME)).toBe(
      join(tmpdir(), "normalized"),
    );
    expect(() => dshHomeDir({ DSH_HOME: ` ${absolute}` }, HOME)).toThrow(ClientPathError);
  });

  test("refuses other relative selectors", () => {
    for (const value of [".dsh", "profiles/work", "../dsh"]) {
      expect(() => dshHomeDir({ DSH_HOME: value }, HOME)).toThrow(ClientPathError);
    }
  });

  test("export and integration registries resolve the same settings file and detect directory", () => {
    const env = { DSH_HOME: "~/profiles/work" };
    const expectedHome = join(HOME, "profiles", "work");
    expect(INTEGRATION_CLIENTS.dsh.detectDir(env, HOME)).toBe(expectedHome);
    expect(INTEGRATION_CLIENTS.dsh.configPath(env, HOME)).toBe(join(expectedHome, "settings.yaml"));
    expect(EXPORT_CLIENTS.dsh.filename).toBe("settings.yaml");
    expect(EXPORT_CLIENTS.dsh.destination(env)).toBe(dshConfigPath(env));
  });

  test("checked-in fixture is a secret-free parseable rc.6 settings namespace", () => {
    const text = readFileSync(new URL("./fixtures/dsh-settings-0.1.0-rc.6.yaml", import.meta.url), "utf8");
    const parsed = Bun.YAML.parse(text) as Record<string, unknown>;
    expect(parsed).toHaveProperty("llm-pi-ai.providers.acme-gateway.api", "openai-completions");
    expect(parsed).toHaveProperty("llm-pi-ai.providers.acme-gateway.models.1.reasoningEfforts.max", "ultra");
    expect(text).not.toContain("Bearer ");
    // Env references are allowed (`apiKeyEnv`); literal credential fields are not.
    expect(text).not.toMatch(/^\s*api[-_]?key\s*:/imu);
    expect(text).not.toMatch(/\bsk-[a-z0-9]/iu);
  });
});
