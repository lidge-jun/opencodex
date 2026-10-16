import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITIES as BASE } from "../../src/cli/capabilities-base";
import { OBSERVE_SYSTEM_CAPABILITIES } from "../../src/cli/capabilities-observe-system";
import { handleObserveCommand } from "../../src/cli/observe";
import { handleStorageCommand } from "../../src/cli/storage";
import { handleSystemCommand } from "../../src/cli/system-command";
import { handleCompanionCommand } from "../../src/cli/companion";
import { handleConfigCommand } from "../../src/cli/config-command";
import { planServiceCommand } from "../../src/service/cli";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { repoPath } from "../helpers/repo-root";

const envKeys = ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let savedEnv: Array<string | undefined>;
let home: string;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-capability-operations-"));
  for (const key of envKeys) process.env[key] = home;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  envKeys.forEach((key, index) => {
    const value = savedEnv[index];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  rmSync(home, { recursive: true, force: true });
});
function capability(key: string) {
  const value = OBSERVE_SYSTEM_CAPABILITIES.find(row => row.command.join(" ") === key);
  if (!value) throw new Error(`Missing capability: ${key}`);
  return value;
}
function transport(payload: unknown = {}) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const deps: RuntimeApiDeps = {
    baseUrl: "http://capability.invalid",
    fetchImpl: async (input, init) => {
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      const url = new URL(String(input));
      requests.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(payload);
    },
  };
  return { requests, deps };
}

describe("operation capability workflows use existing handlers", () => {
  test.each([
    ["observe memory", "memory", "/api/system/memory"],
    ["observe debug", "debug", "/api/debug"],
    ["observe claude-inbound", "claude-inbound", "/api/claude/inbound-debug"],
    ["observe injection", "injection", "/api/debug/injection-logs"],
    ["observe storage", "storage", "/api/storage"],
  ])("%s snapshot forwards its limit", async (key, sub, path) => {
    const leaf = capability(key);
    expect(leaf.routes).toEqual([{ method: "GET", path }]);
    expect(leaf.flags.map(flag => flag.name)).toContain("--limit");
    expect(leaf.mutates).toBe(false);
    const io = transport();
    expect(await handleObserveCommand([sub, "--limit", "7", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "GET", path: path + "?limit=7", body: null }]);
  });
  test("logs retains exact filters and explain encodes one request ID", async () => {
    const io = transport({ logs: [] });
    expect(capability("observe logs").routes).toEqual([{ method: "GET", path: "/api/logs" }]);
    expect(await handleObserveCommand(["logs", "--provider", "fixture", "--conversationId", "c/1", "--account", "main", "--limit", "3", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "GET", path: "/api/logs?provider=fixture&conversationId=c%2F1&account=main&limit=3", body: null }]);
    const explain = transport();
    expect(capability("logs explain").usage).toBe("ocx logs explain <request-id> [--json]");
    expect(capability("logs explain").routes).toEqual([{ method: "GET", path: "/api/request-history/{id}/route-decision" }]);
    expect(await handleObserveCommand(["logs", "explain", "req/1", "--json"], explain.deps)).toBe(0);
    expect(explain.requests).toEqual([{ method: "GET", path: "/api/request-history/req%2F1/route-decision", body: null }]);
  });
  test("usage keeps surface and custom bounds in the actual request", async () => {
    const io = transport({ customWindow: true, since: 1000, until: 2000 });
    expect(capability("observe usage").flags.map(flag => flag.name)).toContain("--surface");
    expect(await handleObserveCommand(["usage", "--range", "7d", "--surface", "claude", "--since", "1000", "--until", "2000", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "GET", path: "/api/usage?range=7d&surface=claude&since=1000&until=2000", body: null }]);
  });
  test("system settings distinguishes read from submitted field writes", async () => {
    const leaf = capability("system settings");
    expect(leaf.mutates).toBe(true);
    expect(leaf.routes).toEqual([{ method: "GET", path: "/api/settings" }, { method: "PUT", path: "/api/settings" }]);
    const io = transport();
    expect(await handleSystemCommand(["settings", "--json"], io.deps)).toBe(0);
    expect(await handleSystemCommand(["settings", "--auto-start", "off", "--desktop-authless", "on", "--client-compaction", "off", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([
      { method: "GET", path: "/api/settings", body: null },
      { method: "PUT", path: "/api/settings", body: { codexAutoStart: false, codexDesktopAuthless: true, codexClientCompaction: false } },
    ]);
  });
  test.each([
    ["system startup health", ["startup", "health", "--json"], "/api/startup-health"],
    ["system diagnostics", ["diagnostics", "--json"], "/api/diagnostics/project-config"],
    ["system update check", ["update", "check", "--channel", "preview", "--json"], "/api/update/check?tag=preview"],
    ["system update status", ["update", "status", "job/1", "--json"], "/api/update/status?jobId=job%2F1"],
  ] as const)("%s follows the real read contract", async (key, args, path) => {
    const io = transport();
    expect(capability(key).routes).toEqual([{ method: "GET", path: path.split("?")[0]! }]);
    expect(await handleSystemCommand([...args], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "GET", path, body: null }]);
  });
  test("system status is a CLI envelope over exactly three reads", async () => {
    const io = transport();
    expect(capability("system status").json).toBe("envelope");
    expect(await handleSystemCommand(["status", "--json"], io.deps)).toBe(0);
    expect(io.requests.map(request => request.path).sort()).toEqual(["/api/settings", "/api/startup-health", "/api/system/memory"]);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({ settings: {}, startup: {}, memory: {} });
  });
  test("companion family requires show when JSON is requested", async () => {
    expect(BASE.find(row => row.command.join(" ") === "companion")?.usage).toStartWith("ocx companion show [--json]");
    const io = transport({ settings: {} });
    expect(await handleCompanionCommand(["--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
    expect(await handleCompanionCommand(["show", "--json"], io.deps)).toBe(0);
    expect(io.requests).toHaveLength(1);
  });
  test("companion leaves never claim or request timeline data", async () => {
    const io = transport();
    for (const sub of ["show", "set", "reset"]) {
      expect(capability("companion " + sub).routes).toEqual([{ method: sub === "show" ? "GET" : "PUT", path: "/api/companion/settings" }]);
      expect(await handleCompanionCommand([sub, ...(sub === "set" ? ["showChart=false", "models=null"] : []), "--json"], io.deps)).toBe(0);
    }
    expect(io.requests).toEqual([
      { method: "GET", path: "/api/companion/settings", body: null },
      { method: "PUT", path: "/api/companion/settings", body: { settings: { showChart: false, models: null } } },
      { method: "PUT", path: "/api/companion/settings", body: { reset: true } },
    ]);
  });
  test("storage policy set keeps nested target semantics", async () => {
    const io = transport();
    expect(capability("storage policy set").routes).toEqual([{ method: "PUT", path: "/api/storage/cleanup-policy" }]);
    expect(await handleStorageCommand(["policy", "set", "--enabled", "false", "--percent", "12", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "PUT", path: "/api/storage/cleanup-policy", body: { enabled: false, target: { removeOldestPercent: 12 } } }]);
  });
  test.each([
    ["storage trash restore", ["trash", "restore", "fixture-entry"]],
    ["storage policy run", ["policy", "run"]],
  ] as const)("%s refuses without confirmation before transport", async (key, args) => {
    expect(capability(key).flags.find(flag => flag.name === "--yes")?.required).toBe(true);
    const io = transport();
    expect(await handleStorageCommand([...args], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
  });
  test("update run refuses before any install request", async () => {
    const io = transport();
    expect(capability("system update run").mutates).toBe(true);
    expect(await handleSystemCommand(["update", "run", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
  });
  test.each(["protect", "unprotect", "repair", "compact"])("Log Guard %s rejects an invalid mode before mutation", async action => {
    const leaf = capability("storage codex-logs " + action);
    expect(leaf.routes).toEqual([{ method: "POST", path: "/api/storage/codex-logs/" + action }]);
    expect(leaf.mutates).toBe(true);
    const io = transport();
    expect(await handleStorageCommand(["codex-logs", action, "--mode", "invalid", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
  });
  test("index inspection is conservatively local and mutating", async () => {
    const io = transport();
    for (const action of ["index-status", "rebuild-index"]) {
      expect(capability("logs " + action).routes).toEqual([]);
      expect(capability("logs " + action).mutates).toBe(true);
      expect(await handleObserveCommand(["logs", action, "--invalid"], io.deps)).toBe(2);
    }
    expect(io.requests).toEqual([]);
    const source = readFileSync(repoPath("src/routing/history/indexer.ts"), "utf8");
    expect(source).toMatch(/requestHistoryIndexStatus\(\)[\s\S]*?return openRequestHistoryIndex\(\)/);
  });
  test("local config metadata keeps secret export separate and missing operands refuse", async () => {
    for (const action of ["get", "set", "unset", "export", "import"]) {
      expect(capability("config " + action).routes).toEqual([]);
      expect(await handleConfigCommand([action])).toBe(2);
    }
    expect(capability("config export").mutates).toBe(true);
    expect(capability("config export").details?.join(" ")).toContain("raw credentials");
  });
  test("service backend flags have platform and subcommand limits without execution", () => {
    expect(capability("service install").routes).toEqual([]);
    expect(capability("service install").json).toBe("none");
    expect(planServiceCommand(["install", "--native"], { platform: "linux" }).ok).toBe(false);
    expect(planServiceCommand(["repair", "--native"], { platform: "win32" }).ok).toBe(false);
    const plan = planServiceCommand(["install", "--native"], { platform: "win32" });
    expect(plan.ok && plan.command).toBe("install");
    for (const key of ["service repair", "service restart", "codex-shim install", "tray install"]) {
      expect(capability(key).routes).toEqual([]);
      expect(capability(key).mutates).toBe(true);
    }
    expect(capability("tray install").flags.map(flag => flag.name)).toEqual(["--no-start", "--json"]);
    const tray = readFileSync(repoPath("src/tray/windows.ts"), "utf8");
    expect(tray).toContain('args.includes("--no-start") && sub !== "install"');
    expect(tray).toContain('process.platform !== "win32"');
    const dispatch = readFileSync(repoPath("src/cli/dispatch.ts"), "utf8");
    expect(dispatch).toContain('case "install": {\n        const r = installCodexShim();');
  });
});


test.each(["running", "restarting", "succeeded", "failed"])("human update reports job ID, %s state and exact progress command", async status => {
  const io = transport({ ok: true, job: { id: "123-fixture", status } });
  expect(await handleSystemCommand(["update", "run", "--yes"], io.deps)).toBe(0);
  expect(output.mock.calls.flat().join("\n")).toBe(`Update job 123-fixture: ${status} (latest).\nCheck progress: ocx system update status 123-fixture`);
  expect(io.requests).toEqual([{ path: "/api/update/run", method: "POST", body: { tag: "latest", restart: true } }]);
});

test("JSON update keeps its original response shape", async () => {
  const body = { ok: true, job: { id: "123-fixture", status: "running", extra: "retained" } };
  expect(await handleSystemCommand(["update", "run", "--yes", "--json"], transport(body).deps)).toBe(0);
  expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(body);
});

test.each([{ ok: true, skipped: true }, { ok: true }, { ok: true, job: { id: "unsafe;command\u001b", status: "running" } }])("missing or unsafe update job handles never claim started or print server text", async body => {
  expect(await handleSystemCommand(["update", "run", "--yes"], transport(body).deps)).toBe(0);
  const text = output.mock.calls.flat().join("\n");
  expect(text).not.toContain("Update started"); expect(text).not.toContain("unsafe;command");
  expect(text).toContain("ocx system update check");
});
