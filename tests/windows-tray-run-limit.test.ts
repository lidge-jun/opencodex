import { describe, expect, test } from "bun:test";
import {
  buildWindowsTrayRunCommand,
  buildWindowsTrayPowerShellCommand,
} from "../src/tray/windows";

describe("windows tray Run registration (#696)", () => {
  test("short wscript Run command stays within the 260-character Windows limit under long paths", () => {
    const longHome = "C:\\Users\\VeryLongWindowsUserNameForTestingPaths\\AppData\\Roaming\\npm\\node_modules\\@bitkyc08\\opencodex";
    const entry = {
      bun: `${longHome}\\node_modules\\bun\\bin\\bun.exe`,
      cli: `${longHome}\\src\\cli\\index.ts`,
      script: "C:\\Users\\VeryLongWindowsUserNameForTestingPaths\\.opencodex\\opencodex-tray.ps1",
      codexHome: "C:\\Users\\VeryLongWindowsUserNameForTestingPaths\\.codex",
      opencodexHome: "C:\\Users\\VeryLongWindowsUserNameForTestingPaths\\.opencodex",
      launcherPath: "C:\\Users\\VeryLongWindowsUserNameForTestingPaths\\.opencodex\\opencodex-tray.vbs",
    };
    const runCommand = buildWindowsTrayRunCommand(entry);
    expect(runCommand.length).toBeLessThanOrEqual(260);
    expect(runCommand.toLowerCase()).toContain("wscript.exe");
    expect(runCommand).toContain("opencodex-tray.vbs");
    // The long PowerShell form still exists for the VBS body, but must not be the Run value.
    expect(buildWindowsTrayPowerShellCommand(entry).length).toBeGreaterThan(260);
  });
});
