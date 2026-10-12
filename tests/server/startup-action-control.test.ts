import { afterEach, describe, expect, test } from "bun:test";
import {
  resetStartupInstallStateForTests,
  runStartupInstallAction,
  setStartupInstallLaunchForTests,
  startupInstallArgv,
  type StartupInstallAction,
} from "../../src/server/startup-action-control";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

const config = { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig;

afterEach(() => {
  setStartupInstallLaunchForTests(null);
  resetStartupInstallStateForTests();
});

/** Run one install through the real action path and capture the child's argv. */
async function installChildArgv(
  action: StartupInstallAction,
  options: { repair?: boolean; standalone: boolean; fail?: string },
): Promise<{ argv: string[]; outcome: { message: string } | Error }> {
  let argv: string[] = [];
  setStartupInstallLaunchForTests({
    isStandaloneExecutable: options.standalone,
    execFile: ((_file: string, args: readonly string[], _opts: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      argv = [...args];
      if (options.fail) callback(new Error("exit 1"), "", options.fail);
      else callback(null, "ok", "");
      return {} as never;
    }) as never,
  });
  const outcome = await runStartupInstallAction(action, { repair: options.repair }).catch((error: Error) => error);
  return { argv, outcome };
}

describe("startup installer child launch (#6963)", () => {
  test("a compiled ocx gets bare subcommands, not the source entrypoint", async () => {
    const shim = await installChildArgv("install-shim", { standalone: true });
    expect(shim.argv).toEqual(["codex-shim", "install"]);
    expect(shim.outcome).toEqual({ message: "Codex launcher shim installed." });
    const service = await installChildArgv("install-service", { standalone: true, repair: true });
    expect(service.argv).toEqual(["service", "repair"]);
  });

  test("a source install still re-enters through cli/index.ts", async () => {
    const { argv } = await installChildArgv("install-shim", { standalone: false });
    expect(argv).toEqual([repoPath("src", "cli", "index.ts"), "codex-shim", "install"]);
  });

  test("a failing child still rejects with its diagnostic", async () => {
    const { argv, outcome } = await installChildArgv("install-shim", { standalone: true, fail: "Native Codex launcher not found" });
    expect(argv).toEqual(["codex-shim", "install"]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("Native Codex launcher not found");
  });
});

describe("startup install actions", () => {
  test("maps the allowlisted actions to fixed CLI argv", () => {
    expect(startupInstallArgv("install-service")).toEqual(["service", "install"]);
    expect(startupInstallArgv("install-service", { repair: true })).toEqual(["service", "repair"]);
    expect(startupInstallArgv("install-shim")).toEqual(["codex-shim", "install"]);
    expect(startupInstallArgv("install-shim", { repair: true })).toEqual(["codex-shim", "install"]);
  });

  test("management API dispatches an allowlisted install action", async () => {
    const calls: Array<{ action: StartupInstallAction; repair?: boolean }> = [];
    const url = new URL("http://localhost/api/startup-action");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install-service" }),
    }), url, config, {
      runStartupInstallAction: async (action, options) => {
        calls.push({ action, repair: options?.repair });
        return { message: "installed" };
      },
    });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, action: "install-service", repair: false, message: "installed" });
    expect(calls).toEqual([{ action: "install-service", repair: false }]);
  });

  test("management API forwards repair mode for service actions", async () => {
    const calls: Array<{ action: StartupInstallAction; repair?: boolean }> = [];
    const url = new URL("http://localhost/api/startup-action");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "install-service", repair: true }),
    }), url, config, {
      runStartupInstallAction: async (action, options) => {
        calls.push({ action, repair: options?.repair });
        return { message: "repaired" };
      },
    });
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, action: "install-service", repair: true, message: "repaired" });
    expect(calls).toEqual([{ action: "install-service", repair: true }]);
  });

  test("rejects unknown actions before invoking the installer", async () => {
    let called = false;
    const url = new URL("http://localhost/api/startup-action");
    const response = await handleManagementAPI(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "run-anything" }),
    }), url, config, {
      runStartupInstallAction: async () => {
        called = true;
        return { message: "unexpected" };
      },
    });
    expect(response?.status).toBe(400);
    expect(called).toBe(false);
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";
