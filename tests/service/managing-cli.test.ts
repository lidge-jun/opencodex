import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { observeManagingClis } from "../../src/service/managing-cli";
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
});
