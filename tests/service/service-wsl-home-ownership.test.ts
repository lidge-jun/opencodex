import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { assertServiceEnvironmentMatchesInstall } from "../../src/service/guards";
import { repairService } from "../../src/service/repair";
import { inspectNativeCodexOwnership } from "../../src/integrations/native/ownership-preflight";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousOpenCodexHome = process.env.OPENCODEX_HOME;
let fixtureHome: string | undefined;

afterEach(() => {
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (fixtureHome) removeTreeWithRetry(fixtureHome);
  fixtureHome = undefined;
});

describe("WSL service ownership after Windows home discovery", () => {
  function fixture(recorded: "linux" | "windows") {
    const root = mkdtempSync(join(tmpdir(), "ocx-wsl-service-home-"));
    fixtureHome = root;
    process.env.OPENCODEX_HOME = root;
    const linuxHome = "/home/fixture/.codex";
    const usersRoot = "/mnt/c/Users";
    const windowsHome = posix.join(usersRoot, "profile", ".codex");
    const recordedHome = recorded === "linux" ? linuxHome : windowsHome;
    const statePath = join(root, "service-state.json");
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      codexHome: recordedHome,
      opencodexHome: root,
    }) + "\n");
    const deps = {
      env: { WSL_DISTRO_NAME: "fixture" },
      platform: "linux" as const,
      homedir: () => "/home/fixture",
      usersRoot,
      existsSync: (path: string) => path === usersRoot || path === posix.join(windowsHome, "config.toml"),
      readdirSync: () => ["profile"],
      // The Linux home is absent: discovery classifies the local home with stat alone.
      statSync: ((path: string) => {
        if (path === join("/home/fixture", ".codex")) throw Object.assign(new Error("absent"), { code: "ENOENT" });
        return { isDirectory: () => true };
      }) as never,
      realpathSync: (path: string) => path,
    };
    return { root, linuxHome, windowsHome, statePath, recordedHome, deps };
  }

  test("stop guard and unattended inspector agree that a different recorded home is foreign", () => {
    const { root, linuxHome, windowsHome, statePath, deps } = fixture("linux");
    expect(() => assertServiceEnvironmentMatchesInstall(deps)).toThrow(
      `Rerun with CODEX_HOME=${linuxHome}`,
    );
    expect(inspectNativeCodexOwnership({
      statePaths: [statePath],
      currentHomes: { codexHome: windowsHome, opencodexHome: root },
    }).ownership).toBe("foreign");
  });

  test("repair refuses a foreign recorded home before any mutation", async () => {
    const { linuxHome, deps } = fixture("linux");
    const touched: string[] = [];
    await expect(repairService({
      platform: "darwin",
      diagnose: () => ({
        supported: true, installed: true, enabled: true, running: true,
        viable: true, startable: true, stale: false, conflict: false,
        backend: "launchd", summary: "installed",
      }),
      readOwnership: () => ({ kind: "none", revision: 0 }),
      assertEnv: () => assertServiceEnvironmentMatchesInstall(deps),
      assertAuth: () => { touched.push("auth"); },
      repairLaunchd: () => { touched.push("repair"); },
      restartLaunchd: () => { touched.push("restart"); },
    })).rejects.toThrow(`Rerun with CODEX_HOME=${linuxHome}`);
    expect(touched).toEqual([]);
  });

  test("exact recorded home remains owned", () => {
    const { deps } = fixture("windows");
    expect(() => assertServiceEnvironmentMatchesInstall(deps)).not.toThrow();
  });

  test("malformed install state is never reported as owned by the unattended inspector", () => {
    const { root, windowsHome, statePath } = fixture("windows");
    writeFileSync(statePath, "{invalid");
    expect(inspectNativeCodexOwnership({
      statePaths: [statePath],
      currentHomes: { codexHome: windowsHome, opencodexHome: root },
    }).ownership).toBe("unknown");
  });
});
