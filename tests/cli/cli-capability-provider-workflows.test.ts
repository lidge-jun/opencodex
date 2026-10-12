import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROVIDER_MODEL_CAPABILITIES } from "../../src/cli/capabilities-provider-models";
import { CAPABILITIES as BASE } from "../../src/cli/capabilities-base";
import { handleProviderRuntimeCommand } from "../../src/cli/provider-runtime";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { handleAliasCommand } from "../../src/cli/alias";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { repoPath } from "../helpers/repo-root";

type Request = { method: string; path: string; body?: unknown };
let home: TempHome;
let previousToken: string | undefined;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-capability-provider-");
  previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  output.mockRestore(); errors.mockRestore();
  if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken;
  home.remove();
});

function fake(calls: Request[], payload: unknown = { success: true }): RuntimeApiDeps {
  return {
    baseUrl: "http://127.0.0.1:1",
    fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search,
        ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      return Response.json(payload);
    }) as typeof fetch,
  };
}

function capability(key: string) {
  const row = PROVIDER_MODEL_CAPABILITIES.find(row => row.command.join(" ") === key);
  expect(row).toBeDefined();
  return row!;
}

describe("provider/model discovery follows existing handlers", () => {
  test("new leaves are unique, separate from baseline, and have complete usage", () => {
    const keys = PROVIDER_MODEL_CAPABILITIES.map(row => row.command.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of PROVIDER_MODEL_CAPABILITIES) {
      expect(BASE.some(base => base.command.join(" ") === row.command.join(" "))).toBe(false);
      expect(row.usage?.startsWith(`ocx ${row.command.join(" ")}`)).toBe(true);
      expect(row.flags.some(flag => flag.name === "--live")).toBe(["provider add", "provider remove", "provider set-default", "models add", "models remove"].includes(row.command.join(" ")));
    }
  });

  test("local provider and custom-model commands do not acquire fictitious management routes", () => {
    for (const key of ["provider show", "models list", "models list-custom"]) {
      expect(capability(key).routes).toEqual([]);
    }
    expect(capability("models add").json).toBe("envelope");
    expect(capability("models remove").flags.map(flag => flag.name)).toEqual(["--yes", "--live", "--json"]);
    // Compare the source's actual public usage constants, without executing local mutation/sync.
    const source = readFileSync(repoPath("src", "cli", "models.ts"), "utf8");
    const removeUsage = /const REMOVE_USAGE = "Usage: ([^"]+)"/.exec(source)?.[1];
    expect(capability("models remove").usage).toBe(removeUsage);
    const listUsage = /const LIST_CUSTOM_USAGE = "Usage: ([^"]+)"/.exec(source)?.[1];
    expect(capability("models list-custom").usage).toBe(listUsage);
  });

  test("provider edit keeps scalar clears, JSON nulls and inverse xAI routing distinct", async () => {
    const row = capability("provider edit");
    expect(row.routes).toEqual([{ method: "PATCH", path: "/api/providers" }]);
    expect(row.flags.find(flag => flag.name === "--enabled")?.value).toBe("string");
    const calls: Request[] = [];
    expect(await handleProviderRuntimeCommand("edit", ["xai", "--default-model", "-", "--headers", "-", "--retain-models", "-", "--enabled", "off", "--xai-chat", "off", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "PATCH", path: "/api/providers?name=xai", body: {
      xaiResponsesOptIn: true, defaultModel: "", headers: null, disabled: true, retainModels: null,
    } }]);
  });

  test.each([
    { key: "provider account-mode", sub: "account-mode", args: ["direct", "--json"], expected: { method: "PATCH", path: "/api/providers?name=openai", body: { codexAccountMode: "direct" } } },
    { key: "provider selected", sub: "selected", args: ["fixture", "--clear", "--json"], expected: { method: "PUT", path: "/api/selected-models", body: { provider: "fixture", models: [] } } },
    { key: "provider presets", sub: "presets", args: ["--json"], expected: { method: "GET", path: "/api/provider-presets" } },
    { key: "provider quota", sub: "quota", args: ["--refresh", "--json"], expected: { method: "GET", path: "/api/provider-quotas?refresh=1" } },
  ])("$key declares the real request", async ({ key, sub, args, expected }) => {
    expect(capability(key).routes).toContainEqual({ method: expected.method, path: expected.path.split("?")[0] });
    const calls: Request[] = [];
    expect(await handleProviderRuntimeCommand(sub, args, fake(calls))).toBe(0);
    expect(calls).toEqual([expected]);
  });

  test.each([
    { key: "provider selected", handler: handleProviderRuntimeCommand },
    { key: "models selected", handler: handleModelsRuntimeCommand },
  ])("$key declares an envelope and emits provider-specific read arrays", async ({ key, handler }) => {
    expect(capability(key).json).toBe("envelope");
    const calls: Request[] = [];
    const deps = fake(calls, {
      selected: { fixture: ["selected-model"], other: ["other-selection"] },
      available: { fixture: ["selected-model", "available-model"], other: ["other-model"] },
      serverOnly: "not part of the CLI read view",
    });
    expect(await handler("selected", ["fixture", "--json"], deps)).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/selected-models" }]);
    expect(output.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({
      provider: "fixture", selected: ["selected-model"], available: ["selected-model", "available-model"],
    });
    expect(await handler("selected", ["missing", "--json"], deps)).toBe(0);
    expect(calls).toEqual([
      { method: "GET", path: "/api/selected-models" },
      { method: "GET", path: "/api/selected-models" },
    ]);
    expect(output.mock.calls).toHaveLength(2);
    expect(JSON.parse(String(output.mock.calls[1]?.[0]))).toEqual({ provider: "missing", selected: [], available: [] });
  });

  test.each([
    { key: "provider selected", handler: handleProviderRuntimeCommand },
    { key: "models selected", handler: handleModelsRuntimeCommand },
  ])("$key preserves the server receipt for writes", async ({ key, handler }) => {
    expect(capability(key).json).toBe("envelope");
    const calls: Request[] = [];
    expect(await handler("selected", ["fixture", "--clear", "--json"], fake(calls, {
      ok: true, selected: { fixture: [] }, saved: true,
    }))).toBe(0);
    expect(calls).toEqual([{ method: "PUT", path: "/api/selected-models", body: { provider: "fixture", models: [] } }]);
    expect(output.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: true, selected: { fixture: [] }, saved: true });
  });

  test.each([
    { key: "models context status", args: ["context", "status", "--json"], expected: { method: "GET", path: "/api/provider-context-caps" } },
    { key: "models context value", args: ["context", "value", "128_000", "--set-all", "--json"], expected: { method: "PUT", path: "/api/provider-context-caps", body: { value: 128000, setAll: true } } },
    { key: "models context provider", args: ["context", "provider", "fixture", "on", "--value", "64000", "--json"], expected: { method: "PUT", path: "/api/provider-context-caps", body: { provider: "fixture", enabled: true, value: 64000 } } },
    { key: "models context all", args: ["context", "all", "off", "--json"], expected: { method: "PUT", path: "/api/provider-context-caps", body: { setAll: false } } },
    { key: "models shadow status", args: ["shadow", "status", "--json"], expected: { method: "GET", path: "/api/shadow-call-settings" } },
    { key: "models shadow set", args: ["shadow", "set", "-", "--enabled", "off", "--json"], expected: { method: "PUT", path: "/api/shadow-call-settings", body: { model: "", enabled: false } } },
    { key: "models selected", args: ["selected", "fixture", "--clear", "--json"], expected: { method: "PUT", path: "/api/selected-models", body: { provider: "fixture", models: [] } } },
    { key: "models preset show", args: ["preset", "show", "--json"], expected: { method: "GET", path: "/api/model-presets" } },
    { key: "models preset apply", args: ["preset", "apply", "fixture", "--all", "--json"], expected: { method: "PUT", path: "/api/model-presets", body: { provider: "fixture", mode: "all" } } },
    { key: "models new-policy", args: ["new-policy", "off", "--provider", "fixture", "--json"], expected: { method: "PUT", path: "/api/model-discovery", body: { policy: "off", provider: "fixture" } } },
    { key: "models enable", args: ["enable", "fixture/upstream/model", "--json"], expected: { method: "PUT", path: "/api/model-visibility", body: { scope: "models", provider: "fixture", enabled: true, targets: [{ id: "upstream/model", native: false }] } } },
    { key: "models disable", args: ["disable", "native-model", "--native", "--json"], expected: { method: "PUT", path: "/api/model-visibility", body: { scope: "models", provider: "openai", enabled: false, targets: [{ id: "native-model", native: true }] } } },
  ])("$key keeps exact operands and body", async ({ key, args, expected }) => {
    expect(capability(key).routes).toContainEqual({ method: expected.method, path: expected.path });
    const calls: Request[] = [];
    expect(await handleModelsRuntimeCommand(args[0]!, args.slice(1), fake(calls))).toBe(0);
    expect(calls).toEqual([expected]);
  });

  test("custom edit clears a definition, not discovered-model settings or names", async () => {
    expect(capability("models edit").routes).toEqual([{ method: "PUT", path: "/api/custom-models/{id}" }]);
    const calls: Request[] = [];
    expect(await handleModelsRuntimeCommand("edit", ["custom/id", "--display-name", "-", "--context-window", "0", "--modalities", "-", "--reasoning-efforts", "", "--default-reasoning-effort", "-", "--json"], fake(calls))).toBe(0);
    expect(calls).toEqual([{ method: "PUT", path: "/api/custom-models/custom%2Fid", body: {
      displayName: "", contextWindow: null, inputModalities: [], reasoningEfforts: [], defaultReasoningEffort: null,
    } }]);
  });

  test("live filtering and provider-wide visibility use the actual catalog", async () => {
    const calls: Request[] = [];
    const rows = [{ provider: "fixture", id: "free", pricingStatus: "free" }, { provider: "fixture", id: "unknown" }, { provider: "other", id: "else", pricingStatus: "free" }];
    expect(capability("models live").routes).toEqual([{ method: "GET", path: "/api/models" }]);
    expect(await handleModelsRuntimeCommand("live", ["--provider", "fixture", "--free-only", "--json"], fake(calls, rows))).toBe(0);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual([rows[0]]);
    expect(capability("models provider").routes).toEqual([{ method: "GET", path: "/api/models" }, { method: "PUT", path: "/api/model-visibility" }]);
    expect(await handleModelsRuntimeCommand("provider", ["fixture", "off", "--json"], fake(calls, rows))).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "PUT", path: "/api/model-visibility", body: { scope: "provider", provider: "fixture", enabled: false, targets: [{ id: "free", native: false }, { id: "unknown", native: false }] } });
  });

  test("new arrivals is a projection of discovery state", async () => {
    const calls: Request[] = [];
    expect(capability("models new-arrivals").routes).toEqual([{ method: "GET", path: "/api/model-discovery" }]);
    expect(await handleModelsRuntimeCommand("new-arrivals", ["--json"], fake(calls, { recentArrivals: { fixture: [{ id: "new", at: "2026-10-04", state: "off" }] } }))).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/model-discovery" }]);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual({ fixture: [{ id: "new", at: "2026-10-04", state: "off" }] });
  });

  test.each([
    { key: "alias list", args: ["list", "--json"], expected: { method: "GET", path: "/api/aliases" } },
    { key: "alias set", args: ["set", "fixture/upstream/model", "friendly", "--json"], expected: { method: "PUT", path: "/api/providers/fixture/model-aliases", body: { set: { "upstream/model": "friendly" } } } },
    { key: "alias rm", args: ["rm", "fixture", "--json"], expected: { method: "PUT", path: "/api/providers/fixture/alias", body: { alias: null } } },
    { key: "alias defaults", args: ["defaults", "off", "--provider", "fixture", "--json"], expected: { method: "PUT", path: "/api/default-aliases", body: { enabled: false, provider: "fixture" } } },
  ])("$key exposes the existing alias request", async ({ key, args, expected }) => {
    expect(capability(key).json).toBe("payload");
    const calls: Request[] = [];
    expect(await handleAliasCommand(args, fake(calls))).toBe(0);
    expect(calls).toEqual([expected]);
  });

  test("invalid grammar is refused without contacting any provider", async () => {
    const calls: Request[] = [];
    const deps = fake(calls);
    expect(capability("models context provider").usage).toBe("ocx models context provider <provider> <on|off> [--value <tokens>] [--json]");
    expect(await handleModelsRuntimeCommand("context", ["provider", "fixture", "off", "--value", "64000"], deps)).not.toBe(0);
    expect(await handleModelsRuntimeCommand("selected", ["fixture", "--set", "m", "--clear"], deps)).not.toBe(0);
    expect(await handleModelsRuntimeCommand("edit", ["id", "--context-window", "-"], deps)).not.toBe(0);
    expect(await handleProviderRuntimeCommand("test", [], deps)).not.toBe(0);
    expect(capability("provider test").routes).toEqual([{ method: "POST", path: "/api/providers/test" }]);
    expect(await handleProviderRuntimeCommand("edit", ["other", "--xai-chat", "on"], deps)).not.toBe(0);
    expect(calls).toEqual([]);
  });
});
