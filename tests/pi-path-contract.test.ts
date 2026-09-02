import { describe, expect, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  ompModelsConfigPath,
  piAgentDir,
  piConfigPath,
} from "../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";
import { removeTreeWithRetry } from "./helpers/remove-tree";

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "opencodex-pi-home-"));
  try {
    run(home);
  } finally {
    removeTreeWithRetry(home);
  }
}

describe("Pi path contract", () => {
  test("falls back to ~/.pi/agent when no override is set", () => {
    withTempHome(home => {
      expect(piAgentDir({} as NodeJS.ProcessEnv, home)).toBe(join(home, ".pi", "agent"));
      expect(piConfigPath({} as NodeJS.ProcessEnv, home)).toBe(join(home, ".pi", "agent", "models.json"));
    });
  });

  test("honors PI_CODING_AGENT_DIR", () => {
    withTempHome(home => {
      const env = { PI_CODING_AGENT_DIR: join(home, "elsewhere") } as NodeJS.ProcessEnv;
      expect(piConfigPath(env, home)).toBe(join(home, "elsewhere", "models.json"));
      expect(piAgentDir({ PI_CODING_AGENT_DIR: "~" } as NodeJS.ProcessEnv, home)).toBe(home);
      expect(piAgentDir({ PI_CODING_AGENT_DIR: "~/alt" } as NodeJS.ProcessEnv, home)).toBe(join(home, "alt"));
    });
  });

  test("refuses a relative override", () => {
    withTempHome(home => {
      // The proxy and Pi can run from different working directories, so a
      // relative value would name two different files.
      expect(() => piConfigPath({ PI_CODING_AGENT_DIR: "relative" } as NodeJS.ProcessEnv, home)).toThrow(ClientPathError);
    });
  });

  /**
   * The defect this file exists for: every other client threaded `env` into its
   * destination, and `pi` alone dropped it, so the same variable moved OMP's
   * path and left Pi's on the home default.
   */
  test("the export destination and the integration resolvers all follow the override", () => {
    withTempHome(home => {
      const env = { PI_CODING_AGENT_DIR: join(home, "elsewhere") } as NodeJS.ProcessEnv;
      expect(EXPORT_CLIENTS.pi.destination(env)).toBe(join(home, "elsewhere", "models.json"));
      expect(INTEGRATION_CLIENTS.pi.configPath(env, home)).toBe(join(home, "elsewhere", "models.json"));
      expect(INTEGRATION_CLIENTS.pi.detectDir(env, home)).toBe(join(home, "elsewhere"));
      // Without an override the install signal is unchanged: still the home
      // directory, not the agent directory beneath it.
      expect(INTEGRATION_CLIENTS.pi.detectDir({} as NodeJS.ProcessEnv, home)).toBe(join(home, ".pi"));
    });
  });

  test("Pi and OMP now agree about the variable they already shared", () => {
    withTempHome(home => {
      const env = { PI_CODING_AGENT_DIR: join(home, "elsewhere") } as NodeJS.ProcessEnv;
      // OMP's default profile has always honored it; Pi now does too.
      expect(ompModelsConfigPath(env, home)).toBe(join(home, "elsewhere", "models.yml"));
      expect(piConfigPath(env, home)).toBe(join(home, "elsewhere", "models.json"));
    });
  });
});
