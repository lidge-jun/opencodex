import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { runGatewayClientCommand, runGatewayClientFromArgs, type GatewayClientCommandDeps } from "../../src/cli/gateway-client-command";
import type { GatewayClientContext } from "../../src/integrations/gateway-clients";
import type { OcxConfig } from "../../src/types";

let root: string;
let ctx: GatewayClientContext;
const offline = (): GatewayClientCommandDeps => ({
  findLiveProxy: async () => null,
  context: () => ctx,
  loadConfig: () => ({ port: 10100, providers: {} }) as unknown as OcxConfig,
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a) => { out.push(a.join(" ")); });
  const error = spyOn(console, "error").mockImplementation((...a) => { err.push(a.join(" ")); });
  return { out, err, restore: () => { log.mockRestore(); error.mockRestore(); } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-gw-cli-"));
  mkdirSync(join(root, "home"));
  ctx = { home: join(root, "home"), platform: "linux", env: { SHELL: "/bin/bash" }, stateDir: join(root, "state"), adminSettingsPath: join(root, "admin_settings.json") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ocx connect|disconnect antigravity|agy", () => {
  test("dispatch sends the client operand to the gateway command and never reaches the hub connect", async () => {
    const hub = spyOn(await import("../../src/cli/connect"), "handleConnectCommand").mockResolvedValue(99);
    const gateway = spyOn(await import("../../src/cli/gateway-client-command"), "runGatewayClientFromArgs").mockResolvedValue(0);
    try {
      for (const operand of ["agy", "antigravity"]) {
        const args = ["connect", operand, "status", "--json"];
        expect(await dispatchCommand({ kind: "command", command: "connect", args }, { args } as unknown as CliDispatchDeps)).toBe(0);
        expect(gateway).toHaveBeenLastCalledWith("connect", [operand, "status", "--json"], expect.anything());
      }
      expect(hub).not.toHaveBeenCalled();
    } finally { hub.mockRestore(); gateway.mockRestore(); }
  });

  test("with no running proxy connect and disconnect run locally and restore the file", async () => {
    const io = capture();
    try {
      expect(await runGatewayClientFromArgs("connect", ["antigravity", "--model", "gemini-3", "--json"], offline())).toBe(0);
      const body = JSON.parse(io.out.join("\n"));
      expect(body).toMatchObject({ ok: true, id: "antigravity", action: "connect", status: { state: "connected" } });
      expect(JSON.parse(readFileSync(join(ctx.home, ".antigravity", "settings.json"), "utf8")).models.defaultModelId).toBe("gemini-3");
      io.out.length = 0;
      expect(await runGatewayClientFromArgs("connect", ["antigravity", "status", "--json"], offline())).toBe(0);
      expect(JSON.parse(io.out.join("\n"))).toMatchObject({ id: "antigravity", state: "connected" });
      expect(await runGatewayClientFromArgs("disconnect", ["antigravity"], offline())).toBe(0);
      expect(existsSync(join(ctx.home, ".antigravity"))).toBe(false);
      expect(io.out.join("\n")).toContain("restore: exact");
    } finally { io.restore(); }
  });

  test("with no running proxy and port 0, connect is refused before any file is written", async () => {
    const io = capture();
    try {
      const deps = { ...offline(), loadConfig: () => ({ port: 0, providers: {} }) as unknown as OcxConfig };
      expect(await runGatewayClientFromArgs("connect", ["antigravity"], deps)).toBe(5);
      expect(await runGatewayClientFromArgs("connect", ["agy"], deps)).toBe(5);
      expect(io.err.join("\n")).toContain("port is 0");
      expect(existsSync(join(ctx.home, ".antigravity"))).toBe(false);
      expect(existsSync(join(ctx.home, ".bashrc"))).toBe(false);
      expect(existsSync(join(ctx.stateDir, "gateway-clients"))).toBe(false);
      expect(await runGatewayClientFromArgs("disconnect", ["agy"], deps)).toBe(0);
    } finally { io.restore(); }
  });

  test("a running proxy gets the POST, and a 409 refusal exits 5 with the message", async () => {
    const io = capture();
    const calls: { url: string; method?: string; body?: unknown }[] = [];
    const reply = (status: number, json: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    };
    try {
      const ok = { ok: true, id: "agy", action: "connect", changed: true, changedFiles: ["/h/.bashrc"], message: "The agy command now starts on the OpenCodex gateway.", notes: [], status: { id: "agy", label: "agy CLI", state: "connected", files: [], overrides: [], notes: [] } };
      expect(await runGatewayClientCommand("connect", "agy", ["--model", "m1"], { baseUrl: "http://127.0.0.1:10100", fetchImpl: reply(200, ok) as typeof fetch })).toBe(0);
      expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:10100/api/gateway-clients/agy/connect", method: "POST", body: { model: "m1" } });
      const refused = { ok: false, code: "requires-admission-token", message: "needs a credential" };
      expect(await runGatewayClientCommand("connect", "agy", [], { baseUrl: "http://127.0.0.1:10100", fetchImpl: reply(409, refused) as typeof fetch })).toBe(5);
      expect(io.err.join("\n")).toContain("needs a credential");
    } finally { io.restore(); }
  });

  test("bad arguments are a usage error", async () => {
    const io = capture();
    try {
      expect(await runGatewayClientCommand("disconnect", "agy", ["--model", "x"], offline())).toBe(2);
      expect(await runGatewayClientCommand("connect", "agy", ["--model", "  "], offline())).toBe(2);
    } finally { io.restore(); }
  });
});
