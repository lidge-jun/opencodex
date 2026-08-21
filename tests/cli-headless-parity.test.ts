import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAccessCommand } from "../src/cli/access";
import { handleAgentCommand } from "../src/cli/agent";
import { handleComboCommand } from "../src/cli/combo";
import { handleConfigCommand } from "../src/cli/config-command";
import { handleClientIntegrationCommand, handleGrokCommand } from "../src/cli/integrations";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";
import { handleProviderRuntimeCommand } from "../src/cli/provider-runtime";

type Recorded = { path: string; method: string; body: unknown };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

describe("ocx agent sidecar --list (#2188)", () => {
  test("web --list prints the server's webSearchModels — the GUI's exact list", async () => {
    const { requests, deps } = fakeRuntime(req => {
      const url = new URL(req.url);
      if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
        return {
          webSearchModels: [
            { value: "gpt-5.6-luna", label: "gpt-5.6-luna", model: "gpt-5.6-luna", backend: "openai", authSlot: true },
            { value: "gpt-5.6-terra", label: "gpt-5.6-terra", model: "gpt-5.6-terra", backend: "openai" },
          ],
          visionModels: [],
        };
      }
      return undefined;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await handleAgentCommand(["sidecar", "web", "--list"], deps);
      expect(code).toBe(0);
      // Read-only: exactly one GET of the settings route, never a PUT.
      expect(requests).toHaveLength(1);
      expect(requests[0]!.method).toBe("GET");
      expect(requests[0]!.path).toBe("/api/sidecar-settings");
      const out = logSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(out).toContain("gpt-5.6-luna [openai] (auth slot)");
      expect(out).toContain("gpt-5.6-terra [openai]");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("--list combined with a write flag is a usage error, not a silent ignore", async () => {
    const { requests, deps } = fakeRuntime();
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const code = await handleAgentCommand(["sidecar", "web", "--list", "--model", "x"], deps);
      expect(code).toBe(2);
      expect(requests).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("web --model persists the exact backend/model pair offered by the server", async () => {
    const { requests, deps } = fakeRuntime((req, body) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
        return {
          webSearch: { model: "gpt-5.6-luna", backend: "openai" },
          webSearchModels: [
            { value: "claude-haiku-4-5", label: "claude-haiku-4-5", model: "claude-haiku-4-5", backend: "anthropic", authSlot: true },
          ],
          visionModels: [],
        };
      }
      if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
        return { ok: true, saved: body };
      }
      return undefined;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleAgentCommand(["sidecar", "web", "--model", "claude-haiku-4-5"], deps)).toBe(0);
      expect(requests).toEqual([
        { path: "/api/sidecar-settings", method: "GET", body: null },
        {
          path: "/api/sidecar-settings",
          method: "PUT",
          body: { webSearch: { model: "claude-haiku-4-5", backend: "anthropic" } },
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("web --model preserves an explicit backend clear", async () => {
    const { requests, deps } = fakeRuntime((req, body) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
        return {
          webSearchModels: [
            { value: "gpt-5.6-luna", label: "gpt-5.6-luna", model: "gpt-5.6-luna", backend: "openai" },
          ],
          visionModels: [],
        };
      }
      if (url.pathname === "/api/sidecar-settings" && req.method === "PUT") {
        return { ok: true, saved: body };
      }
      return undefined;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleAgentCommand([
        "sidecar", "web", "--model", "gpt-5.6-luna", "--backend", "-",
      ], deps)).toBe(0);
      expect(requests).toEqual([
        { path: "/api/sidecar-settings", method: "GET", body: null },
        {
          path: "/api/sidecar-settings",
          method: "PUT",
          body: { webSearch: { model: "gpt-5.6-luna", backend: null } },
        },
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("web --model surfaces the server's backend/model pair rejection", async () => {
    const { requests, deps } = fakeRuntime(req => {
      const url = new URL(req.url);
      if (req.method === "GET") {
        return {
          webSearchModels: [
            { value: "claude-haiku-4-5", label: "claude-haiku-4-5", model: "claude-haiku-4-5", backend: "anthropic" },
          ],
          visionModels: [],
        };
      }
      if (req.method === "PUT") {
        return Response.json({ error: 'webSearch.model: backend/model pair "anthropic/claude-haiku-4-5" is not a web-search sidecar candidate' }, { status: 400 });
      }
      return undefined;
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await handleAgentCommand(["sidecar", "web", "--model", "claude-haiku-4-5"], deps)).toBe(1);
      expect(requests.map(request => request.method)).toEqual(["GET", "PUT"]);
      expect(errorSpy.mock.calls.map(call => String(call[0])).join("\n")).toContain(
        'backend/model pair "anthropic/claude-haiku-4-5"',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("vision --list prints visionModels with backend tags; empty set names the reason", async () => {
    const { deps } = fakeRuntime(req => {
      const url = new URL(req.url);
      if (url.pathname === "/api/sidecar-settings" && req.method === "GET") {
        return { webSearchModels: [], visionModels: [{ value: "claude-haiku-4-5", label: "claude-haiku-4-5", backend: "anthropic", baseline: true }] };
      }
      return undefined;
    });
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await handleAgentCommand(["sidecar", "vision", "--list"], deps)).toBe(0);
      const visionOut = logSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(visionOut).toContain("claude-haiku-4-5 [anthropic] (baseline)");
      logSpy.mockClear();
      expect(await handleAgentCommand(["sidecar", "web", "--list"], deps)).toBe(0);
      const webOut = logSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(webOut).toContain("no runnable web-search sidecar models");
    } finally {
      logSpy.mockRestore();
    }
  });
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  process.exitCode = 0;
});

function fakeRuntime(responder?: (req: Request, body: unknown) => unknown) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? null : await req.json().catch(() => null);
      requests.push({ path: `${url.pathname}${url.search}`, method: req.method, body });
      const custom = responder?.(req, body);
      if (custom instanceof Response) return custom;
      if (custom !== undefined) return Response.json(custom);
      return Response.json({ ok: true });
    },
  });
  servers.push(server);
  return { requests, deps: { baseUrl: `http://127.0.0.1:${server.port}` } };
}

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe("headless GUI parity CLI", () => {
  test("every GUI management endpoint belongs to a documented CLI resource", () => {
    const guiRoot = join(import.meta.dir, "..", "gui", "src");
    const endpoints = new Set<string>();
    for (const path of sourceFiles(guiRoot)) {
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/\/api\/[A-Za-z0-9_./-]+/g)) {
        endpoints.add(match[0].replace(/\.+$/, "").replace(/\/$/, ""));
      }
    }
    const coverage: Array<[string, string]> = [
      ["/api/claude-code", "ocx claude config"],
      ["/api/claude-desktop", "ocx claude desktop"],
      ["/api/claude/", "ocx observe"],
      ["/api/codex-auth", "ocx account"],
      // GUI-only affordance: starring the repo from the sidebar. There is deliberately
      // no CLI mirror — the headless surface has nothing to gain from a one-click
      // social action, and inventing `ocx github star` would be a command nobody asked
      // for. Listed here so the parity sweep stays exhaustive rather than silently
      // skipping the endpoint.
      ["/api/github/star", "(none — GUI-only)"],
      ["/api/oauth", "ocx account"],
      ["/api/providers/keys", "ocx account"],
      ["/api/providers", "ocx provider"],
      ["/api/provider-", "ocx provider/models"],
      ["/api/selected-models", "ocx models"],
      ["/api/custom-models", "ocx models"],
      ["/api/model", "ocx models"],
      ["/api/combos", "ocx combo"],
      ["/api/client-config", "ocx export"],
      ["/api/client-integrations", "ocx integration client"],
      // GUI-only for now: the overview card switches for Claude Code and Grok.
      // Their effect is already reachable from the CLI by other names —
      // `ocx grok apply` regenerates the fence and `ocx stop` strips it, and
      // the Claude flag flips through `ocx claude config` — so a dedicated
      // `ocx integration native` verb would duplicate existing commands rather
      // than add a capability. Listed so the sweep stays exhaustive.
      ["/api/native-integrations", "(none — GUI-only)"],
      ["/api/debug", "ocx debug/observe"],
      ["/api/diagnostics", "ocx system"],
      ["/api/effort", "ocx agent"],
      ["/api/grok", "ocx grok"],
      ["/api/injection", "ocx agent"],
      ["/api/keys", "ocx access"],
      ["/api/logs", "ocx observe"],
      ["/api/lab", "ocx lab"],
      ["/api/config", "ocx config"],
      ["/api/settings", "ocx system"],
      // Routing Intelligence (RI-04..RI-10): profiles + dry-run are mirrored by
      // `ocx route policy`. Analytics is GUI-first for now; the same request
      // history remains available through observe/index tooling.
      ["/api/routing-profiles", "ocx route policy"],
      ["/api/routing-analytics", "(none — GUI analytics surface; history via ocx observe/logs)"],
      ["/api/shadow", "ocx models"],
      ["/api/sidecar", "ocx agent"],
      ["/api/startup", "ocx system"],
      ["/api/stop", "ocx stop"],
      ["/api/storage", "ocx observe"],
      ["/api/subagent", "ocx agent"],
      ["/api/sync", "ocx system sync"],
      ["/api/system", "ocx observe/system"],
      ["/api/update", "ocx system update"],
      ["/api/usage", "ocx observe usage"],
      ["/api/v2", "ocx v2/agent"],
      ["/api/windows-tray", "ocx tray"],
    ];
    const uncovered = [...endpoints].filter(endpoint => !coverage.some(([prefix]) => endpoint === prefix || endpoint.startsWith(prefix)));
    expect(uncovered).toEqual([]);
  });

  test("provider edit reuses the management provider patch", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", [
      "ark", "--base-url", "https://example.test/v1", "--api-key-transport", "bearer", "--enabled", "off", "--live-models", "on", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/providers?name=ark",
      method: "PATCH",
      body: { baseUrl: "https://example.test/v1", apiKeyTransport: "bearer", disabled: true, liveModels: true },
    }]);
  });

  test("provider edit --headers sends the parsed block and - clears it", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", [
      "agw", "--headers", '{"x-app":"cli","anthropic-version":"2023-06-01"}', "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests).toEqual([{
      path: "/api/providers?name=agw",
      method: "PATCH",
      body: { headers: { "x-app": "cli", "anthropic-version": "2023-06-01" } },
    }]);

    const clearRuntime = fakeRuntime();
    const clearCode = await handleProviderRuntimeCommand("edit", ["agw", "--headers", "-", "--json"], clearRuntime.deps);
    expect(clearCode).toBe(0);
    expect(clearRuntime.requests[0]?.body).toEqual({ headers: null });
  });

  test("provider edit rejects malformed --headers JSON without a request", async () => {
    const runtime = fakeRuntime();
    const code = await handleProviderRuntimeCommand("edit", ["agw", "--headers", "{not json"], runtime.deps);
    expect(code).toBe(2);
    expect(runtime.requests).toEqual([]);

    const arrayRuntime = fakeRuntime();
    const arrayCode = await handleProviderRuntimeCommand("edit", ["agw", "--headers", '["x-app"]'], arrayRuntime.deps);
    expect(arrayCode).toBe(2);
    expect(arrayRuntime.requests).toEqual([]);
  });

  test("provider edit usage errors redact --headers values", async () => {
    const errorSpy = spyOn(console, "error");
    try {
      // `--headers={...}` is not consumed by takeOption, so the value lands in the
      // leftovers rejectArgs reports. Header values can carry tokens, so they must
      // never be echoed to stderr.
      const runtime = fakeRuntime();
      const code = await handleProviderRuntimeCommand(
        "edit",
        ["agw", "--headers={\"x-app\":\"cli\",\"X-Token\":\"sk-leak-value\"}"],
        runtime.deps,
      );
      expect(code).toBe(2);
      expect(runtime.requests).toEqual([]);
      const stderr = errorSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(stderr).toContain("--headers=<redacted>");
      expect(stderr).not.toContain("sk-leak-value");
      expect(stderr).not.toContain("X-Token");

      errorSpy.mockClear();
      // Repeating the option leaves the second flag AND its value in the leftovers.
      const repeatRuntime = fakeRuntime();
      const repeatCode = await handleProviderRuntimeCommand(
        "edit",
        ["agw", "--headers", "{\"X-Token\":\"sk-leak-value\"}", "--headers", "{\"X-Other\":\"v\"}"],
        repeatRuntime.deps,
      );
      expect(repeatCode).toBe(2);
      const repeatStderr = errorSpy.mock.calls.map(call => String(call[0])).join("\n");
      expect(repeatStderr).toContain("--headers <redacted>");
      expect(repeatStderr).not.toContain("sk-leak-value");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("provider test treats a static catalog as neutral", async () => {
    const runtime = fakeRuntime(() => ({ applicable: false, reason: "static_catalog", latencyMs: 0 }));
    const code = await handleProviderRuntimeCommand("test", ["google-antigravity", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(process.exitCode).not.toBe(1);
    expect(runtime.requests).toEqual([{
      path: "/api/providers/test?name=google-antigravity",
      method: "POST",
      body: null,
    }]);
  });

  test("model context all maps to the atomic GUI endpoint", async () => {
    const runtime = fakeRuntime();
    const code = await handleModelsRuntimeCommand("context", ["all", "on", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { setAll: true } });
  });

  test("model context value maps with an explicit set-all flag", async () => {
    const runtime = fakeRuntime();
    const code = await handleModelsRuntimeCommand("context", ["value", "128_000", "--set-all", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { value: 128_000, setAll: true } });

    // Without --set-all only the shared default changes.
    const defaultRuntime = fakeRuntime();
    const defaultCode = await handleModelsRuntimeCommand("context", ["value", "256_000", "--json"], defaultRuntime.deps);
    expect(defaultCode).toBe(0);
    expect(defaultRuntime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { value: 256_000 } });
  });

  test("model context provider maps to the atomic GUI endpoint with an optional value", async () => {
    const runtime = fakeRuntime();
    const code = await handleModelsRuntimeCommand("context", ["provider", "openai", "on", "--value", "128_000", "--json"], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { provider: "openai", enabled: true, value: 128_000 } });

    const offRuntime = fakeRuntime();
    const offCode = await handleModelsRuntimeCommand("context", ["provider", "openai", "off", "--json"], offRuntime.deps);
    expect(offCode).toBe(0);
    expect(offRuntime.requests[0]).toEqual({ path: "/api/provider-context-caps", method: "PUT", body: { provider: "openai", enabled: false } });

    // --value is only valid with `on`; the rejected form must not send any request.
    const rejectedRuntime = fakeRuntime();
    const rejectedCode = await handleModelsRuntimeCommand("context", ["provider", "openai", "off", "--value", "128_000", "--json"], rejectedRuntime.deps);
    expect(rejectedCode).toBe(2);
    expect(rejectedRuntime.requests).toEqual([]);
  });

  test("combo set parses ordered weighted targets", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand([
      "set", "fast", "--targets", "ark/model-a:2,openai/gpt-5.5", "--strategy", "failover", "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests.find(request => request.method === "PUT")?.body).toEqual({
      id: "fast",
      combo: {
        strategy: "failover",
        stickyLimit: 1,
        targets: [
          { provider: "ark", model: "model-a", weight: 2 },
          { provider: "openai", model: "gpt-5.5" },
        ],
      },
    });
  });

  test("combo set forwards the explicit native-alias compatibility contract", async () => {
    const runtime = fakeRuntime();
    const code = await handleComboCommand([
      "set", "nova-sol",
      "--targets", "Nova1/codex/gpt-5.6-sol",
      "--alias", "gpt-5.6-sol",
      "--native-alias",
      "--display-name", "Nova1 - codex-gpt-5.6-sol",
      "--json",
    ], runtime.deps);
    expect(code).toBe(0);
    expect(runtime.requests.find(request => request.method === "PUT")?.body).toMatchObject({
      id: "nova-sol",
      combo: {
        alias: "gpt-5.6-sol",
        nativeAlias: true,
        displayName: "Nova1 - codex-gpt-5.6-sol",
        targets: [{ provider: "Nova1", model: "codex/gpt-5.6-sol" }],
      },
    });
  });

  test("combo set round-trips an existing disabled image-input capability", async () => {
    let persisted: Record<string, unknown> = {
      id: "text-only",
      imageInput: "disabled",
      targets: [{ provider: "ark", model: "old-model" }],
    };
    const runtime = fakeRuntime((req, body) => {
      if (req.method === "GET") return { combos: [persisted] };
      if (req.method === "PUT") {
        const update = body as { id: string; combo: Record<string, unknown> };
        persisted = { id: update.id, ...update.combo };
        return { combo: persisted };
      }
      return undefined;
    });

    expect(await handleComboCommand([
      "set", "text-only", "--targets", "ark/new-model", "--json",
    ], runtime.deps)).toBe(0);
    expect(await handleComboCommand(["show", "text-only", "--json"], runtime.deps)).toBe(0);

    expect(persisted).toMatchObject({
      id: "text-only",
      imageInput: "disabled",
      targets: [{ provider: "ark", model: "new-model" }],
    });
    expect(runtime.requests.map(request => request.method)).toEqual(["GET", "PUT", "GET"]);
  });

  test("agent effort and roster use the same live mutation routes as GUI", async () => {
    const runtime = fakeRuntime();
    expect(await handleAgentCommand(["effort", "set", "--main", "high", "--subagent", "medium", "--json"], runtime.deps)).toBe(0);
    expect(await handleAgentCommand(["subagents", "set", "a/model,b/model", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests.map(row => [row.path, row.body])).toEqual([
      ["/api/effort-caps", { effortCap: "high", subagentEffortCap: "medium" }],
      ["/api/subagent-models", { models: ["a/model", "b/model"] }],
    ]);
  });

  test("API key create returns the one-time key through the access command", async () => {
    const runtime = fakeRuntime((req) => new URL(req.url).pathname === "/api/keys"
      ? { id: "key-1", name: "deploy", key: "ocx_secret" }
      : undefined);
    expect(await handleAccessCommand(["key", "create", "deploy", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[0]).toEqual({ path: "/api/keys", method: "POST", body: { name: "deploy" } });
  });

  test("Grok include edits the persisted exclusion set before apply", async () => {
    const runtime = fakeRuntime((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/api/grok" && req.method === "GET") return { excluded: ["a", "b"] };
      return undefined;
    });
    expect(await handleGrokCommand(["include", "a", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests[1]).toEqual({ path: "/api/grok/selection", method: "PUT", body: { excluded: ["b"] } });
  });

  test("client integration toggles hit the exact management routes", async () => {
    const runtime = fakeRuntime();
    expect(await handleClientIntegrationCommand(["enable", "--client", "hermes", "--json"], runtime.deps)).toBe(0);
    expect(await handleClientIntegrationCommand(["disable", "--client", "hermes", "--json"], runtime.deps)).toBe(0);
    expect(runtime.requests.map(row => [row.path, row.method, row.body])).toEqual([
      ["/api/client-integrations/hermes", "PUT", { enabled: true }],
      ["/api/client-integrations/hermes", "PUT", { enabled: false }],
    ]);
  });

  test("restore refuses to guess about drift, and forwards the confirmation when given", async () => {
    /*
     * Replacing edits a user made after the snapshot is their decision, so the
     * flag has to travel exactly as typed. Defaulting it to true would make
     * the headless path quietly more destructive than the GUI.
     */
    const runtime = fakeRuntime();
    expect(await handleClientIntegrationCommand(["restore", "--op", "op-1", "--json"], runtime.deps)).toBe(0);
    expect(await handleClientIntegrationCommand(
      ["restore", "--op", "op-1", "--confirm-drift", "--json"],
      runtime.deps,
    )).toBe(0);
    expect(runtime.requests.map(row => row.body)).toEqual([
      { opId: "op-1", confirmDrift: false },
      { opId: "op-1", confirmDrift: true },
    ]);
  });

  test("a client integration command without its required target fails instead of guessing", async () => {
    const runtime = fakeRuntime();
    // No `--client`: picking one for the user would write a config they never named.
    expect(await handleClientIntegrationCommand(["enable", "--json"], runtime.deps)).not.toBe(0);
    expect(await handleClientIntegrationCommand(["restore", "--json"], runtime.deps)).not.toBe(0);
    expect(runtime.requests).toEqual([]);
  });

  test("config set validates the complete candidate before the atomic write", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-config-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({
        port: 10100,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
      }));
      expect(await handleConfigCommand(["set", "codexAutoStart", "false", "--json"])).toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).codexAutoStart).toBe(false);
      expect(await handleConfigCommand(["set", "port", "-1", "--json"])).not.toBe(0);
      expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).port).toBe(10100);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config set and import reject an invalid app-owned memory budget without persisting the normalized default", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-memory-budget-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const configPath = join(home, "config.json");
      const importPath = join(home, "invalid-import.json");
      const original = JSON.stringify({
        port: 10100,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
        appOwnedMemoryBudgetMb: 128,
      });
      writeFileSync(configPath, original);
      writeFileSync(importPath, JSON.stringify({
        ...JSON.parse(original),
        appOwnedMemoryBudgetMb: 4097,
      }));

      expect(await handleConfigCommand(["set", "appOwnedMemoryBudgetMb", "63", "--json"])).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(await handleConfigCommand(["import", importPath, "--yes", "--json"])).not.toBe(0);
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });


  test("config set applies onto the disk state, not a snapshot read before the lock (#1835)", async () => {
    // The read used to happen outside the mutation lock, so a concurrent edit landing
    // between it and the whole-snapshot save was silently reverted.
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-set-race-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const configPath = join(home, "config.json");
    const base = {
      port: 10100,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai",
    };
    try {
      writeFileSync(configPath, JSON.stringify(base));
      expect(await handleConfigCommand(["set", "autoSwitchThreshold", "50", "--json"])).toBe(0);

      // A competing writer adds a provider the CLI never saw.
      const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      onDisk.providers.competitor = {
        adapter: "openai-chat",
        baseUrl: "https://competitor.example/v1",
        apiKey: "competitor-key",
      };
      writeFileSync(configPath, JSON.stringify(onDisk));

      expect(await handleConfigCommand(["set", "autoSwitchThreshold", "70", "--json"])).toBe(0);

      const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(after.autoSwitchThreshold).toBe(70);
      // The competing edit survives: the mutation was applied to the fresh disk state.
      expect(Object.keys(after.providers)).toEqual(expect.arrayContaining(["openai", "competitor"]));
      expect(after.providers.competitor).toMatchObject({ apiKey: "competitor-key" });
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("config unset actually removes the key through the mutation primitive (#1835)", async () => {
    // A merge-only callback cannot delete, so unset would report success and change nothing.
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-unset-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const configPath = join(home, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({
        port: 10100,
        providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
        defaultProvider: "openai",
        autoSwitchThreshold: 50,
      }));
      expect(await handleConfigCommand(["unset", "autoSwitchThreshold", "--json"])).toBe(0);

      const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      expect(Object.hasOwn(after, "autoSwitchThreshold")).toBe(false);
      expect(after.providers.openai).toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("config set releases the manual pin when it writes the selection order", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cli-priority-pin-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    const configPath = join(home, "config.json");
    const base = {
      port: 10100,
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      defaultProvider: "openai",
      activeCodexAccountPinned: "work",
    };
    const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));
    const readPin = () => readConfig().activeCodexAccountPinned;
    try {
      // The whole map, one entry, and a removal are all the operator restating the
      // order, so each releases the pin -- otherwise it keeps capping the tier
      // ceiling at "work" and the order just written has no visible effect.
      for (const { argv, expected } of [
        { argv: ["set", "codexAccountPriorities", '{"work":1}'], expected: { work: 1 } },
        { argv: ["set", "codexAccountPriorities.work", "2"], expected: { work: 2 } },
        { argv: ["unset", "codexAccountPriorities"], expected: undefined },
      ]) {
        writeFileSync(configPath, JSON.stringify({ ...base, codexAccountPriorities: { work: 0 } }));
        expect(await handleConfigCommand([...argv, "--json"])).toBe(0);
        expect(readPin()).toBeUndefined();
        expect(readConfig().codexAccountPriorities).toEqual(expected);
      }

      // An unrelated field is not a statement about ordering, so the pin survives.
      writeFileSync(configPath, JSON.stringify({ ...base, codexAccountPriorities: { work: 1 } }));
      expect(await handleConfigCommand(["set", "autoSwitchThreshold", "50", "--json"])).toBe(0);
      expect(readPin()).toBe("work");
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
