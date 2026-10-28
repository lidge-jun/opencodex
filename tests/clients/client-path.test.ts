import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { absoluteClientPath, ClientPathError } from "../../src/clients/client-path";
import {
  clineConfigPath, commandCodeUserHome, dshHomeDir, mcodeHomeDir, ompAgentDir,
  omoAgentDir, openclawConfigPath, piAgentDir, primeAgentDir, qoderConfigPath,
  zcodeHomeDir, zcodeProviderStorePath,
} from "../../src/clients/config-export";
import { agentHomeDir } from "../../src/clients/config-export/agent-clients";
import { gentleShellPaths } from "../../src/clients/gentle-shell-path";

describe("fully qualified client paths", () => {
  test.each(["\\Users\\me\\.codex", "/client/.codex", "\\", "/", "C:relative", "relative", "\\\\server"])(
    "refuses Windows current-drive/cwd-dependent path %s on every CI host", raw => {
      expect(() => absoluteClientPath(raw, "C:\\Users\\me", "CLIENT_DIR", "win32"))
        .toThrow(ClientPathError);
      expect(() => absoluteClientPath(raw, "C:\\Users\\me", "CLIENT_DIR", "win32"))
        .toThrow(/CLIENT_DIR must be an absolute path/);
    },
  );

  test.each(["C:\\Users\\me\\.codex", "D:/client", "\\\\server\\share\\client", "//server/share/client", "\\\\?\\C:\\client", "\\\\?\\UNC\\server\\share\\client"])(
    "preserves a Windows drive or UNC-qualified path %s", raw => {
      expect(absoluteClientPath(raw, "C:\\Users\\me", "CLIENT_DIR", "win32")).toBe(raw);
    },
  );

  test("explains the missing Windows drive and expands tilde with the selected platform", () => {
    expect(() => absoluteClientPath("\\Users\\me", "C:\\home", "CLIENT_DIR", "win32"))
      .toThrow(/drive letter or UNC/);
    expect(absoluteClientPath("~/agent", "C:\\home", "CLIENT_DIR", "win32")).toBe("C:\\home\\agent");
    expect(absoluteClientPath("~", "C:\\home", "CLIENT_DIR", "win32")).toBe("C:\\home");
    expect(absoluteClientPath("/client", "/home/me", "CLIENT_DIR", "linux")).toBe("/client");
    expect(absoluteClientPath("~/agent", "/home/me", "CLIENT_DIR", "darwin")).toBe("/home/me/agent");
    expect(() => absoluteClientPath("relative", "/home/me", "CLIENT_DIR", "linux")).toThrow(ClientPathError);
  });

  const home = join(homedir(), "ocx-path-fixture");
  const dependent = process.platform === "win32" ? "\\ocx-path-fixture" : "relative-client";
  const resolvers: Array<[string, (env: Record<string, string>) => unknown]> = [
    ["PI_CODING_AGENT_DIR", env => piAgentDir(env, home)],
    ["PI_CODING_AGENT_DIR", env => ompAgentDir(env, home)],
    ["OPENCLAW_HOME", env => openclawConfigPath(env, home)],
    ["OPENCLAW_STATE_DIR", env => openclawConfigPath(env, home)],
    ["OPENCLAW_CONFIG_PATH", env => openclawConfigPath(env, home)],
    ["MINIMAX_DATA_DIR", env => mcodeHomeDir(env, home)],
    ["MAVIS_DATA_DIR", env => mcodeHomeDir(env, home)],
    ["ZCODE_DATA_DIR", env => zcodeHomeDir(env, home)],
    ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", env => zcodeProviderStorePath(env, home)],
    ["PRIME_AGENT_CODING_AGENT_DIR", env => primeAgentDir(env, home)],
    ...["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR"].map(key =>
      [key, (env: Record<string, string>) => omoAgentDir(env, home)] as [string, (env: Record<string, string>) => unknown]),
    ...["CLINE_PROVIDER_SETTINGS_PATH", "CLINE_DATA_DIR", "CLINE_DIR"].map(key =>
      [key, (env: Record<string, string>) => clineConfigPath(env, home)] as [string, (env: Record<string, string>) => unknown]),
    ["QODER_CONFIG_DIR", env => qoderConfigPath(env, home)],
    ["QODERCN_CONFIG_DIR", env => agentHomeDir("qoder-cn", env, home)],
    ["WORKBUDDY_CONFIG_DIR", env => agentHomeDir("workbuddy", env, home)],
    ["CODEBUDDY_CONFIG_DIR", env => agentHomeDir("workbuddy-ai", env, home)],
    ["DSH_HOME", env => dshHomeDir(env, home)],
    ["GENTLE_SHELL_CONFIG", env => gentleShellPaths(env, home)],
    ["GENTLE_SHELL_HOME", env => gentleShellPaths(env, home)],
    ["GENTLE_SHELL_USER_PI_HOME", env => gentleShellPaths(env, home)],
  ];
  test.each(resolvers)("%s refuses a drive/cwd-dependent override", (key, resolve) => {
    expect(() => resolve({ [key]: dependent })).toThrow(ClientPathError);
  });

  test("ZCode refuses a drive/cwd-dependent bootstrap root", () => {
    expect(() => zcodeHomeDir({}, home, { readText: () => ({ kind: "text", text: JSON.stringify({ dataBaseDir: dependent }) }) }))
      .toThrow(/absolute dataBaseDir/);
  });

  test("Command Code does not adopt a drive-less Windows home on any CI host", () => {
    expect(commandCodeUserHome({ HOME: "\\Users\\me" }, homedir(), "win32")).toBe(homedir());
    expect(commandCodeUserHome({ HOME: "D:\\Users\\me" }, homedir(), "win32")).toBe("D:\\Users\\me");
  });
});
