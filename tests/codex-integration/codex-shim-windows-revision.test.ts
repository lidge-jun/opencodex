/**
 * An installed Windows CMD or PowerShell wrapper from before the bypass-token fix loads the
 * service token before honoring OCX_SHIM_BYPASS. Those wrappers carry the shim marker but no
 * Windows revision, so explicit install and auto-restore must rewrite them in place over the same
 * backing launcher, never report them healthy or "already installed". No Windows shell runs here:
 * process.platform is overridden and the wrappers are only written and read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoRestoreCodexShim, installCodexShim } from "../../src/codex/shim";
import { buildWindowsCodexShim, buildWindowsPowerShellCodexShim, WINDOWS_SHIM_REVISION_MARKER } from "../../src/codex/shim-templates";
import { isolateCodexShimEnvironment } from "../helpers/codex-shim-install-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

isolateCodexShimEnvironment();

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const previousHome = process.env.OPENCODEX_HOME;
let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "ocx-win-shim-revision-"));
  process.env.OPENCODEX_HOME = dir;
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(dir);
});

/** The pre-fix template: no Windows revision line, and the token load ahead of the bypass check. */
function previousTemplate(flavor: "cmd" | "ps1", backing: string): string {
  const current = flavor === "cmd"
    ? buildWindowsCodexShim(backing, "C:\\bun.exe", "C:\\cli.ts", "process")
    : buildWindowsPowerShellCodexShim(backing, "C:\\bun.exe", "C:\\cli.ts", "process");
  const lines = current.split("\n").filter(line => !line.includes(WINDOWS_SHIM_REVISION_MARKER));
  if (flavor === "cmd") {
    const bypass = lines.findIndex(line => line.includes('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex'));
    const load = lines.findIndex(line => line.includes("set /p OPENCODEX_API_AUTH_TOKEN="));
    [lines[bypass], lines[load]] = [lines[load]!, lines[bypass]!];
    return lines.join("\n");
  }
  return lines.join("\n").replace("-not $env:OCX_SHIM_BYPASS -and ", "");
}

function seed(flavor: "cmd" | "ps1"): { wrapper: string; backing: string; previous: string } {
  const wrapper = join(dir, `codex.${flavor}`), backing = `${wrapper}.opencodex-real`;
  const previous = previousTemplate(flavor, backing);
  fs.writeFileSync(wrapper, previous);
  fs.writeFileSync(backing, "native fixture launcher");
  fs.writeFileSync(join(dir, "codex-shim.json"), JSON.stringify({ platform: "win32", originalPath: wrapper, wrapperPath: wrapper, backupPath: backing }));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return { wrapper, backing, previous };
}

function expectCurrent(flavor: "cmd" | "ps1", wrapper: string, backing: string): void {
  const text = fs.readFileSync(wrapper, "utf8");
  expect(text).toContain(WINDOWS_SHIM_REVISION_MARKER);
  if (flavor === "cmd") {
    expect(text.indexOf("set /p OPENCODEX_API_AUTH_TOKEN=")).toBeGreaterThan(text.indexOf('if not "%OCX_SHIM_BYPASS%"=="" goto run_codex'));
  } else {
    expect(text).toContain("-not $env:OCX_SHIM_BYPASS -and -not $env:OPENCODEX_API_AUTH_TOKEN");
  }
  expect(fs.readFileSync(backing, "utf8")).toBe("native fixture launcher");
}

describe("obsolete Windows shims are upgraded", () => {
  for (const flavor of ["cmd", "ps1"] as const) {
    test(`explicit install rewrites a previous ${flavor} wrapper`, () => {
      const { wrapper, backing, previous } = seed(flavor);
      const result = installCodexShim();
      expect(result.installed).toBe(true);
      expect(fs.readFileSync(wrapper, "utf8")).not.toBe(previous);
      expectCurrent(flavor, wrapper, backing);
      // Now current: a second install is a no-op.
      expect(installCodexShim().installed).toBe(false);
    });

    test(`auto-restore rewrites a previous ${flavor} wrapper instead of reporting it healthy`, () => {
      const { wrapper, backing } = seed(flavor);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("restored");
      expectCurrent(flavor, wrapper, backing);
      expect(autoRestoreCodexShim({ enabled: () => true, stabilitySleep: () => {} }).status).toBe("healthy");
    });
  }
});
