import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeManagingClis } from "../../src/service/managing-cli";
import type { ServiceInstallState } from "../../src/service/state";
import { createTempHome } from "../helpers/temp-home";

describe("Windows managing CLI selection", () => {
  test("PATHEXT precedes an extensionless file", () => {
    if (process.platform !== "win32") return;
    const home = createTempHome("ocx-managing-cli-");
    try {
      const directory = home.path("tools");
      mkdirSync(directory);
      const selected = join(directory, "ocx.EXE");
      writeFileSync(selected, "");
      writeFileSync(join(directory, "ocx"), "");
      const commands: string[] = [];
      const spawn = ((command: string) => {
        commands.push(command);
        return { status: 0, stdout: "2.61.0", stderr: "" };
      }) as unknown as typeof spawnSync;
      const result = observeManagingClis(null, {
        platform: "win32", env: { PATH: directory, PATHEXT: ".EXE;.CMD" },
        execPath: home.path("self.exe"), exists: existsSync, spawn,
      });
      expect(result.path.status).toBe("observed");
      if (result.path.status === "observed") {
        expect(result.path.identity.toLowerCase()).toBe(selected.toLowerCase());
      }
      expect(commands.map(command => command.toLowerCase())).toEqual([selected.toLowerCase()]);
    } finally { home.remove(); }
  });

  test("a selected directory is unknown and is never probed", () => {
    if (process.platform !== "win32") return;
    const home = createTempHome("ocx-managing-cli-");
    try {
      const directory = home.path("tools");
      mkdirSync(directory);
      mkdirSync(join(directory, "ocx.CMD"));
      let spawns = 0;
      const spawn = (() => {
        spawns++;
        return { status: 0, stdout: "2.61.0", stderr: "" };
      }) as unknown as typeof spawnSync;
      const result = observeManagingClis(null, {
        platform: "win32", env: { PATH: directory, PATHEXT: ".CMD" },
        execPath: home.path("self.exe"), exists: existsSync, spawn,
      });
      expect(result.path.status).toBe("unknown");
      expect(spawns).toBe(0);
    } finally { home.remove(); }
  });

  test("unsafe command shim paths never reach cmd.exe", () => {
    if (process.platform !== "win32") return;
    const home = createTempHome("ocx-managing-cli-");
    try {
      for (const character of ["&", "|", "<", ">", "^", "%", "!", '"', "(", ")"]) {
        const directory = home.path(`unsafe${character}`);
        if (!["|", "<", ">", '"'].includes(character)) {
          mkdirSync(directory);
          writeFileSync(join(directory, "ocx.CMD"), "@echo off\n");
        }
        let spawns = 0;
        const spawn = (() => {
          spawns++;
          return { status: 0, stdout: "2.61.0", stderr: "" };
        }) as unknown as typeof spawnSync;
        const result = observeManagingClis(null, {
          platform: "win32", env: { PATH: directory, PATHEXT: ".CMD" },
          execPath: home.path("self.exe"),
          exists: candidate => candidate.toLowerCase() === join(directory, "ocx.CMD").toLowerCase(),
          spawn,
        });
        expect(result.path.status).toBe("unknown");
        expect(spawns).toBe(0);
      }
    } finally { home.remove(); }
  });

  test("an unsafe recorded CLI argument never reaches a command shim", () => {
    if (process.platform !== "win32") return;
    const home = createTempHome("ocx-managing-cli-");
    try {
      const tools = home.path("tools");
      const packageDir = home.path("package&name");
      mkdirSync(tools);
      mkdirSync(packageDir);
      const shim = join(tools, "manager.cmd");
      const cliPath = join(packageDir, "cli.ts");
      writeFileSync(shim, "@echo off\n");
      writeFileSync(cliPath, "");
      const state: ServiceInstallState = {
        version: 2, backend: "scheduler", codexHome: home.codexHome,
        opencodexHome: home.configDir, revision: 1,
        bunPath: shim, cliPath,
      };
      let spawns = 0;
      const spawn = (() => {
        spawns++;
        return { status: 0, stdout: "2.61.0", stderr: "" };
      }) as unknown as typeof spawnSync;
      const result = observeManagingClis(state, {
        platform: "win32", env: { PATH: "" },
        execPath: home.path("self.exe"), spawn,
      });
      expect(result["service-registration"].status).toBe("unknown");
      expect(spawns).toBe(0);
    } finally { home.remove(); }
  });
});

describe("managing CLI self observation", () => {
  test("POSIX differing case probes the selected executable", () => {
    const selected = "/opt/ocx";
    const commands: string[] = [];
    const spawn = ((command: string) => {
      commands.push(command);
      return { status: 0, stdout: "2.62.0", stderr: "" };
    }) as unknown as typeof spawnSync;
    const result = observeManagingClis(null, {
      platform: "linux", env: { PATH: "/opt" }, execPath: "/opt/OCX",
      exists: path => path === selected, isFile: () => true,
      ownVersion: () => "2.61.0", spawn,
    });
    expect(result.path).toMatchObject({ status: "observed", version: "2.62.0", identity: selected });
    expect(commands).toEqual([selected]);
  });

  test("Windows differing case still recognizes the running CLI", () => {
    let spawns = 0;
    const spawn = (() => {
      spawns++;
      return { status: 0, stdout: "2.62.0", stderr: "" };
    }) as unknown as typeof spawnSync;
    const result = observeManagingClis(null, {
      platform: "win32", env: { PATH: "C:\\opt", PATHEXT: ".EXE" },
      execPath: "C:\\OPT\\OCX.EXE", exists: path => path === "C:\\opt\\ocx.EXE",
      isFile: () => true, ownVersion: () => "2.61.0", spawn,
    });
    expect(result.path).toMatchObject({ status: "observed", version: "2.61.0" });
    expect(spawns).toBe(0);
  });
});
