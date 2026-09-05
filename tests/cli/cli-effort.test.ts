import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEffortCommand } from "../../src/cli/effort";
import { dispatchCommand } from "../../src/cli/dispatch";
import type { CliDispatchDeps } from "../../src/cli/dispatch";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

let tempHome: string | null = null;
const savedHome = process.env.OPENCODEX_HOME;
let logOrig = console.log;
let errorOrig = console.error;

beforeEach(() => {
  logOrig = console.log;
  errorOrig = console.error;
  tempHome = mkdtempSync(join(tmpdir(), "ocx-effort-test-"));
  process.env.OPENCODEX_HOME = tempHome;
  const initialConfig: OcxConfig = {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        adapter: "anthropic",
        baseUrl: "https://api.anthropic.com",
        authMode: "oauth",
        models: ["claude-sonnet-5", "claude-haiku-4-5"],
        modelReasoningEfforts: {
          "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
        },
      },
      MyProvider: {
        adapter: "openai-chat",
        baseUrl: "https://my.test/v1",
        models: ["model-1"],
      },
    },
  } as unknown as OcxConfig;
  writeFileSync(join(tempHome, "config.json"), JSON.stringify(initialConfig, null, 2), "utf8");
});

afterEach(() => {
  console.log = logOrig;
  console.error = errorOrig;
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) {
    removeTreeWithRetry(tempHome);
    tempHome = null;
  }
});

function readTestConfig(): OcxConfig {
  return JSON.parse(readFileSync(join(tempHome!, "config.json"), "utf8")) as OcxConfig;
}

function fakeDeps(args: string[] = []): {
  deps: CliDispatchDeps;
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));

  const deps: CliDispatchDeps = {
    args,
    command: "effort",
    head: { kind: "command", command: "effort", args },
    loadConfig: () => readTestConfig(),
    findLiveProxy: async () => null,
    probeHostname: () => "127.0.0.1",
    waitForProxy: async () => null,
    startArgv: () => [],
    spawnDetached: () => {},
    handleStart: async () => {},
    handleStop: async () => true,
    handleEnsure: async () => true,
    handleTrayProxyStart: async () => true,
    handleTrayProxyRestart: async () => {},
    handleRestartStartWhenStopped: async () => true,
    handleProxyRestart: async () => true,
    handleUninstall: async () => {},
    handleStatus: async () => {},
    handleRecoverHistory: async () => {},
    handleReady: async () => 0,
    serviceCommand: async () => {},
  };

  return { deps, logs, errors };
}

describe("ocx effort offline config operations", () => {
  test("ocx effort (bare) prints offline status", async () => {
    const { deps, logs } = fakeDeps([]);
    const code = await handleEffortCommand([], deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Reasoning effort status (offline config)");
    expect(logs.join("\n")).toContain("Main agent effort cap:     (unset — no cap)");
  });

  test("ocx effort status --json returns JSON envelope", async () => {
    const { deps, logs } = fakeDeps(["status", "--json"]);
    const code = await handleEffortCommand(["status", "--json"], deps);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.source).toBe("config");
    expect(parsed.effortCap).toBeNull();
    expect(parsed.subagentEffortCap).toBeNull();
    expect(parsed.efforts).toContain("low");
    expect(parsed.efforts).toContain("ultra");
  });

  test("ocx effort <level> sets main effort cap offline", async () => {
    const { deps, logs } = fakeDeps(["high"]);
    const code = await handleEffortCommand(["high"], deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Main agent effort cap:     high");
    expect(readTestConfig().effortCap).toBe("high");
  });

  test("ocx effort - clears main effort cap offline", async () => {
    const conf = readTestConfig();
    conf.effortCap = "high";
    writeFileSync(join(tempHome!, "config.json"), JSON.stringify(conf, null, 2), "utf8");

    const { deps } = fakeDeps(["-"]);
    const code = await handleEffortCommand(["-"], deps);
    expect(code).toBe(0);
    expect(readTestConfig().effortCap).toBeUndefined();
  });

  test("ocx effort set --main and --subagent sets both caps", async () => {
    const { deps } = fakeDeps(["set", "--main", "max", "--subagent", "medium"]);
    const code = await handleEffortCommand(["set", "--main", "max", "--subagent", "medium"], deps);
    expect(code).toBe(0);
    const updated = readTestConfig();
    expect(updated.effortCap).toBe("max");
    expect(updated.subagentEffortCap).toBe("medium");
  });

  test("ocx effort clear unsets both caps but preserves injection effort", async () => {
    const conf = readTestConfig();
    conf.effortCap = "high";
    conf.subagentEffortCap = "low";
    conf.injectionEffort = "max";
    writeFileSync(join(tempHome!, "config.json"), JSON.stringify(conf, null, 2), "utf8");

    const { deps } = fakeDeps(["clear"]);
    const code = await handleEffortCommand(["clear"], deps);
    expect(code).toBe(0);
    const updated = readTestConfig();
    expect(updated.effortCap).toBeUndefined();
    expect(updated.subagentEffortCap).toBeUndefined();
    expect(updated.injectionEffort).toBe("max");
  });

  test("ocx effort set --injection - clears injection without changing caps", async () => {
    const conf = readTestConfig();
    conf.effortCap = "high";
    conf.subagentEffortCap = "low";
    conf.injectionEffort = "max";
    writeFileSync(join(tempHome!, "config.json"), JSON.stringify(conf, null, 2), "utf8");

    const { deps } = fakeDeps(["set", "--injection", "-"]);
    const code = await handleEffortCommand(["set", "--injection", "-"], deps);
    expect(code).toBe(0);
    const updated = readTestConfig();
    expect(updated.effortCap).toBe("high");
    expect(updated.subagentEffortCap).toBe("low");
    expect(updated.injectionEffort).toBeUndefined();
  });

  test("ocx effort rejects unknown effort level with usage error 2", async () => {
    const { deps, errors } = fakeDeps(["super-hyper-max"]);
    const code = await handleEffortCommand(["super-hyper-max"], deps);
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain('unknown effort command or level "super-hyper-max"');
  });

  test("ocx effort model inspects configured model reasoning metadata", async () => {
    const { deps, logs } = fakeDeps(["model", "anthropic/claude-sonnet-5"]);
    const code = await handleEffortCommand(["model", "anthropic/claude-sonnet-5"], deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Reasoning effort configuration for anthropic/claude-sonnet-5");
    expect(logs.join("\n")).toContain("Supported ladder:   low, medium, high, xhigh, max");
  });

  test("selector regression: malformed leading or trailing slash selectors are rejected with usage error 2", async () => {
    const { deps: deps1, errors: errors1 } = fakeDeps(["/claude-sonnet-5"]);
    const code1 = await handleEffortCommand(["/claude-sonnet-5"], deps1);
    expect(code1).toBe(2);
    expect(errors1.join("\n")).toContain("invalid model selector");

    const { deps: deps2, errors: errors2 } = fakeDeps(["anthropic/"]);
    const code2 = await handleEffortCommand(["anthropic/"], deps2);
    expect(code2).toBe(2);
    expect(errors2.join("\n")).toContain("invalid model selector");
  });

  test("shorthand selector regression: mixed-case provider key is preserved in shorthand", async () => {
    const { deps, logs } = fakeDeps(["MyProvider/model-1"]);
    const code = await handleEffortCommand(["MyProvider/model-1"], deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("Reasoning effort configuration for MyProvider/model-1");
  });
});

describe("ocx effort online live-proxy integration & negative regressions", () => {
  test("live status read failures never substitute offline config", async () => {
    const { logs, errors } = fakeDeps(["status", "--json"]);
    const configBefore = readTestConfig();
    const code = await handleEffortCommand(["status", "--json"], {
      baseUrl: "http://127.0.0.1:10100",
      findLiveProxy: async () => null,
      fetchImpl: async () => new Response(JSON.stringify({ error: "permission_denied" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    });
    expect(code).not.toBe(0);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("permission_denied");
    expect(readTestConfig()).toEqual(configBefore);
  });

  test("ocx effort uses live management API when proxy is active", async () => {
    const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(url.toString());
        requests.push({
          path: u.pathname,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        if (u.pathname === "/api/effort-caps") {
          return new Response(JSON.stringify({
            effortCap: "xhigh",
            subagentEffortCap: "medium",
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/injection-model") {
          return new Response(JSON.stringify({ effort: "high" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    };

    const code = await handleEffortCommand(["status", "--json"], runtimeDeps);
    expect(code).toBe(0);
    expect(requests.some(r => r.path === "/api/effort-caps")).toBe(true);
  });

  test("ocx effort set communicates mutation to live management API", async () => {
    let liveCaps: { effortCap: string | null; subagentEffortCap: string | null } = {
      effortCap: null,
      subagentEffortCap: null,
    };
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(url.toString());
        if (u.pathname === "/api/effort-caps" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          liveCaps.effortCap = body.effortCap ?? null;
          liveCaps.subagentEffortCap = body.subagentEffortCap ?? null;
          return new Response(JSON.stringify({
            ok: true,
            effortCap: liveCaps.effortCap,
            subagentEffortCap: liveCaps.subagentEffortCap,
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/effort-caps" && (init?.method === "GET" || !init?.method)) {
          return new Response(JSON.stringify({
            effortCap: liveCaps.effortCap,
            subagentEffortCap: liveCaps.subagentEffortCap,
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/injection-model") {
          return new Response(JSON.stringify({ effort: null }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    };

    const code = await handleEffortCommand(["set", "--main", "high", "--subagent", "low", "--json"], runtimeDeps);
    expect(code).toBe(0);
    expect(liveCaps.effortCap).toBe("high");
    expect(liveCaps.subagentEffortCap).toBe("low");
  });

  test("negative regression 1: live 4xx/5xx fails non-zero and never falls through to saveConfig", async () => {
    const configBefore = readTestConfig();
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async () => {
        return new Response(JSON.stringify({ error: "permission_denied: invalid admin token" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      },
    };

    const code = await handleEffortCommand(["set", "--main", "high"], runtimeDeps);
    expect(code).not.toBe(0);
    // Persisted config must NOT have changed under a live failure
    expect(readTestConfig().effortCap).toBe(configBefore.effortCap);
  });

  test("negative regression 2: failure after caps PUT succeeds identifies partial application and fails non-zero", async () => {
    let capsCommitted = false;
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (url: string | URL | Request) => {
        const u = new URL(url.toString());
        if (u.pathname === "/api/effort-caps") {
          capsCommitted = true;
          return new Response(JSON.stringify({ ok: true, effortCap: "high" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/injection-model") {
          return new Response(JSON.stringify({ error: "subagent injection template unwriteable" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      },
    };

    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));

    const code = await handleEffortCommand(["set", "--main", "high", "--injection", "medium"], runtimeDeps);
    expect(code).not.toBe(0);
    expect(capsCommitted).toBe(true);
    expect(errors.join("\n")).toContain("effort caps were updated on live proxy, but injection effort failed");
  });

  test("negative regression 3: successful PUT followed by failed status GET wraps with explicit verification error and fails non-zero", async () => {
    let capsCommitted = false;
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(url.toString());
        if (u.pathname === "/api/effort-caps" && init?.method === "PUT") {
          capsCommitted = true;
          return new Response(JSON.stringify({ ok: true, effortCap: "high" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/effort-caps" && (init?.method === "GET" || !init?.method)) {
          // Status verification GET fails with 500
          return new Response(JSON.stringify({ error: "internal telemetry failure" }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      },
    };

    const errors: string[] = [];
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));

    const code = await handleEffortCommand(["set", "--main", "high"], runtimeDeps);
    expect(code).not.toBe(0);
    expect(capsCommitted).toBe(true);
    expect(errors.join("\n")).toContain("live state was updated, but verifying live status failed");
  });

  test("negative regression 4: unreachable-before-mutation offline fallback when live proxy probe throws or returns null", async () => {
    const { deps, logs } = fakeDeps(["high"]);
    deps.findLiveProxy = async () => {
      throw new Error("daemon socket closed");
    };

    const code = await handleEffortCommand(["high"], deps);
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("[offline] Effort caps updated in config.json");
    expect(readTestConfig().effortCap).toBe("high");
  });

  test("negative regression 5: injection-only update preserves existing caps without fabricating null", async () => {
    let recordedInjection = "";
    const runtimeDeps = {
      baseUrl: "http://127.0.0.1:10100",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        const u = new URL(url.toString());
        if (u.pathname === "/api/injection-model" && init?.method === "PUT") {
          const body = JSON.parse(init.body as string);
          recordedInjection = body.effort;
          return new Response(JSON.stringify({ ok: true, effort: body.effort }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/effort-caps") {
          return new Response(JSON.stringify({
            effortCap: "high",
            subagentEffortCap: "medium",
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (u.pathname === "/api/injection-model") {
          return new Response(JSON.stringify({ effort: recordedInjection || "low" }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("{}", { status: 200 });
      },
    };

    const logs: string[] = [];
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));

    const code = await handleEffortCommand(["set", "--injection", "max", "--json"], runtimeDeps);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.effortCap).toBe("high");
    expect(parsed.subagentEffortCap).toBe("medium");
    expect(parsed.injectionEffort).toBe("max");
  });

  test("ocx effort dispatches through top-level dispatchCommand", async () => {
    const argv = ["effort", "medium"];
    const { deps } = fakeDeps(argv);
    const code = await dispatchCommand({ kind: "command", command: "effort", args: argv }, deps);
    expect(code).toBe(0);
    expect(readTestConfig().effortCap).toBe("medium");
  });
});
