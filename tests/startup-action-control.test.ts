import { describe, expect, test } from "bun:test";
import { startupInstallArgv, type StartupInstallAction } from "../src/server/startup-action-control";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const config = { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig;

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
import { ManagementRequest as Request } from "./helpers/management-auth";
