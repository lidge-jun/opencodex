import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleProviderLifecycleRuntimeCommand as lifecycle } from "../../src/cli/provider-lifecycle-runtime";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

type Call = { url: string; method: string; body?: unknown; redirect?: RequestRedirect };
let home: TempHome;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
let network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
const SENTINEL = "synthetic-private-value";
const preset = { id: "fixture", adapter: "openai-responses", baseUrl: "https://target.example.test", auth: "key", responsesPath: "/responses", defaultModel: "target-model" };
const canonicalSeed = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct", defaultModel: "target-native", models: ["target-native"] };

beforeEach(() => {
  home = createTempHome("ocx-provider-lifecycle-");
  writeFileSync(home.path("config.json"), "local-config-sentinel");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network"); });
});
afterEach(() => {
  expect(readFileSync(home.path("config.json"), "utf8")).toBe("local-config-sentinel");
  expect(network).not.toHaveBeenCalled();
  output.mockRestore(); errors.mockRestore(); network.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});

function fixture(options: { roster?: unknown; presets?: unknown; receipt?: unknown; status?: number; failAt?: number } = {}) {
  const calls: Call[] = [];
  let probes = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { probes++; return { port: probes === 1 ? 32101 : 32102, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      const url = String(input);
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      calls.push({ url, method: init?.method ?? "GET", redirect: init?.redirect,
        ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) });
      if (calls.length === options.failAt) throw new Error(SENTINEL);
      const path = new URL(url).pathname;
      if ((init?.method ?? "GET") === "GET") return Response.json(path === "/api/providers" ? (options.roster ?? []) : (options.presets ?? { providers: [preset] }));
      return Response.json(options.receipt ?? { success: true, name: "fixture", catalogRefresh: null }, { status: options.status ?? 200 });
    }) as typeof fetch,
  };
  return { calls, deps, probes: () => probes };
}
function assertPrivateOutput() {
  expect(JSON.stringify([...output.mock.calls, ...errors.mock.calls])).not.toContain(SENTINEL);
}

describe("explicit live provider lifecycle", () => {
  test("target preset supplies auth/path/default, once-pinned discovery and one POST", async () => {
    const f = fixture();
    expect(await lifecycle("add", ["fixture", "--api-key", SENTINEL, "--set-default", "--json"], f.deps)).toBe(0);
    expect(f.probes()).toBe(1);
    expect(f.calls).toEqual([
      { url: "http://127.0.0.1:32101/api/providers", method: "GET", redirect: "error" },
      { url: "http://127.0.0.1:32101/api/provider-presets", method: "GET", redirect: "error" },
      { url: "http://127.0.0.1:32101/api/providers", method: "POST", redirect: "error", body: {
        name: "fixture", setDefault: true, provider: { adapter: "openai-responses", baseUrl: "https://target.example.test", authMode: "key", responsesPath: "/responses", defaultModel: "target-model", apiKey: SENTINEL },
      } },
    ]);
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual({ success: true, name: "fixture", catalogRefresh: null });
    assertPrivateOutput();
  });

  test("explicit custom fields and inline key override differing preset fields", async () => {
    const f = fixture();
    expect(await lifecycle("add", ["fixture", "--adapter", "anthropic", "--base-url", "https://override.example.test", "--default-model", "override-model", "--responses-path", "/custom", `--api-key=${SENTINEL}`, "--api-key-transport", "bearer", "--auth-mode", "key", "--model", "selected-model", "--text-only", "--json"], f.deps)).toBe(0);
    expect(f.calls[2]?.body).toEqual({ name: "fixture", provider: { adapter: "anthropic", baseUrl: "https://override.example.test", defaultModel: "override-model", responsesPath: "/custom", authMode: "key", apiKey: SENTINEL, apiKeyTransport: "bearer", modelCapabilities: { "selected-model": { inputModalities: ["text"] } } } });
    assertPrivateOutput();
  });

  test("missing preset supports explicit custom fields without local registry seeding", async () => {
    const f = fixture({ presets: { providers: [] } });
    expect(await lifecycle("add", ["custom-fixture", "--adapter", "openai-chat", "--base-url", "https://custom.example.test", "--json"], f.deps)).toBe(0);
    expect(f.calls[2]?.body).toEqual({ name: "custom-fixture", provider: { adapter: "openai-chat", baseUrl: "https://custom.example.test" } });
  });

  test("custom catalog placeholder requires explicit fields and is never sent as a seed", async () => {
    const f = fixture({ presets: { providers: [{ id: "custom", adapter: "openai-chat", baseUrl: "", auth: "key" }] } });
    expect(await lifecycle("add", ["custom", "--adapter", "anthropic", "--base-url", "https://custom.example.test", "--json"], f.deps)).toBe(0);
    expect(f.calls[2]?.body).toEqual({ name: "custom", provider: { adapter: "anthropic", baseUrl: "https://custom.example.test" } });
  });

  test("canonical OpenAI uses the target's complete seed verbatim", async () => {
    const f = fixture({ presets: { providers: [{ id: "openai", provider: canonicalSeed }] } });
    expect(await lifecycle("add", ["openai", "--json"], f.deps)).toBe(0);
    expect(f.calls[2]?.body).toEqual({ name: "openai", provider: canonicalSeed });
  });

  for (const args of [
    ["openai", "--api-key", SENTINEL], ["openai", "--default-model", "other"],
    ["openai", "--allow-private-network"], ["openai", "--text-only"],
    ["fixture", "--sync"], ["fixture", "--json", "--json"],
    ["fixture", "--force", "--force"], ["fixture", "--api-key", SENTINEL, `--api-key=${SENTINEL}`],
    ["fixture", "--api-key"], ["fixture", `--unknown=${SENTINEL}`],
    ["fixture", "--base-url", `https://user:${SENTINEL}@host.test`],
    ["fixture", "--responses-path", `https://host.test/${SENTINEL}`],
    ["fixture", "--auth-mode", SENTINEL], ["fixture", "--api-key-transport", SENTINEL],
    ["fixture", "--google-tool-schema-policy", SENTINEL], ["fixture", "--model", "m"],
    ["__proto__"], ["fixture", "--adapter", ""], ["fixture", "--base-url", "https://a.test", "--base-url", "https://b.test"],
  ]) test(`invalid add grammar refuses before discovery: ${args[1] ?? "name"}`, async () => {
    const f = fixture();
    expect(await lifecycle("add", args, f.deps)).toBe(2);
    expect(f.probes()).toBe(0);
    expect(f.calls).toEqual([]);
    expect(output).not.toHaveBeenCalled();
    assertPrivateOutput();
  });

  test("observed existing provider refuses without force; force permits one upsert", async () => {
    const f = fixture({ roster: [{ name: "fixture" }] });
    expect(await lifecycle("add", ["fixture", "--json"], f.deps)).toBe(5);
    expect(f.calls).toHaveLength(1);
    expect(output).not.toHaveBeenCalled();
    const force = fixture({ roster: [{ name: "fixture" }] });
    expect(await lifecycle("add", ["fixture", "--force", "--json"], force.deps)).toBe(0);
    expect(force.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  for (const presets of [null, {}, { providers: {} }, { providers: [null] }, { providers: [preset, preset] }, { providers: [{ ...preset, auth: 1 }] }, { providers: [{ ...preset, responsesPath: 3 }] }, { providers: [] }]) {
    test("missing/malformed target preset never falls back or posts", async () => {
      const f = fixture({ presets: presets ?? { providers: null } });
      expect(await lifecycle("add", ["fixture", "--json"], f.deps)).toBe(1);
      expect(f.calls.map(call => call.method)).toEqual(["GET", "GET"]);
      expect(output).not.toHaveBeenCalled();
    });
  }
  for (const seed of [undefined, {}, { ...canonicalSeed, apiKey: SENTINEL }, { ...canonicalSeed, baseUrl: "https://wrong.test" }, { ...canonicalSeed, codexAccountMode: "wrong" }]) {
    test("missing/malformed canonical seed cannot fall back to custom flags", async () => {
      const f = fixture({ presets: { providers: [{ id: "openai", provider: seed }] } });
      expect(await lifecycle("add", ["openai", "--json"], f.deps)).toBe(1);
      expect(f.calls).toHaveLength(2);
      expect(output).not.toHaveBeenCalled();
      assertPrivateOutput();
    });
  }
  test("malformed roster is a failure before preset or mutation", async () => {
    const f = fixture({ roster: { providers: [] } });
    expect(await lifecycle("add", ["fixture"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1);
  });
  test("non-key target authentication rejects a supplied key without echo", async () => {
    const f = fixture({ presets: { providers: [{ ...preset, auth: "oauth" }] } });
    expect(await lifecycle("add", ["fixture", "--api-key", SENTINEL], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(2);
    assertPrivateOutput();
  });

  test("Google tool schema policy rejects a non-Google preset without mutation", async () => {
    const f = fixture();
    expect(await lifecycle("add", ["fixture", "--google-tool-schema-policy", "reject-lossy"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(2); expect(output).not.toHaveBeenCalled();
  });
  test("custom Google and local-network opt-in remain explicit body fields", async () => {
    const f = fixture({ presets: { providers: [] } });
    expect(await lifecycle("add", ["custom-google", "--adapter", "google", "--base-url", "http://127.0.0.1:19999", "--allow-private-network", "--google-tool-schema-policy", "compatible", "--text-only", "--default-model", "text-model", "--json"], f.deps)).toBe(0);
    expect(f.calls[2]?.body).toEqual({ name: "custom-google", provider: { adapter: "google", baseUrl: "http://127.0.0.1:19999", allowPrivateNetwork: true, googleToolSchemaPolicy: "compatible", defaultModel: "text-model", modelCapabilities: { "text-model": { inputModalities: ["text"] } } } });
  });
  test("oversize composite POST cannot be sent", async () => {
    const f = fixture();
    expect(await lifecycle("add", ["fixture", "--api-key", "a".repeat(4 * 1024 * 1024), "--json"], f.deps)).toBe(2);
    expect(f.calls).toHaveLength(2); expect(output).not.toHaveBeenCalled();
  });

  test("set-default is one standalone PATCH", async () => {
    const f = fixture({ receipt: { success: true, defaultProvider: "fixture" } });
    expect(await lifecycle("set-default", ["fixture", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:32101/api/providers?name=fixture", method: "PATCH", redirect: "error", body: { setDefault: true } }]);
  });
  test("remove is one DELETE preserving reassignment and cleanup receipt", async () => {
    const receipt = { success: true, defaultProvider: "remaining", droppedCustomModels: 2, dependentShadowIntercept: { model: "fixture/m", enabled: false } };
    const f = fixture({ receipt });
    expect(await lifecycle("remove", ["fixture", "--yes", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ url: "http://127.0.0.1:32101/api/providers?name=fixture", method: "DELETE", redirect: "error" }]);
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual(receipt);
  });
  for (const [sub, args] of [
    ["remove", ["fixture"]], ["remove", ["fixture", "--yes", "--yes"]],
    ["set-default", ["fixture", "--force"]], ["remove", ["fixture", "--yes", `--api-key=${SENTINEL}`]],
  ] as const) test(`${sub} rejects unsafe grammar before target lookup`, async () => {
    const f = fixture();
    expect(await lifecycle(sub, [...args], f.deps)).toBe(2);
    expect(f.probes()).toBe(0); expect(f.calls).toEqual([]); assertPrivateOutput();
  });

  for (const role of ["missing", "client"] as const) test(`${role} proxy cannot mutate or fall back locally`, async () => {
    const f = fixture();
    f.deps.findLiveProxy = async () => role === "missing" ? null : { port: 32101, pid: 1, role: "client", source: "runtime" };
    expect(await lifecycle("remove", ["fixture", "--yes", "--json"], f.deps)).toBe(1);
    expect(f.calls).toEqual([]); expect(output).not.toHaveBeenCalled();
  });
  for (const [status, exit] of [[403, 1], [404, 4], [409, 5], [503, 1]] as const) test(`HTTP ${status} preserves numeric exit without server error echo`, async () => {
    const f = fixture({ status, receipt: { error: { message: SENTINEL }, detail: SENTINEL } });
    expect(await lifecycle("set-default", ["fixture", "--json"], f.deps)).toBe(exit);
    expect(f.calls).toHaveLength(1); expect(output).not.toHaveBeenCalled(); assertPrivateOutput();
  });
  for (const sub of ["add", "remove", "set-default"] as const) test(`${sub} returns partial catalog outcome from shared printer`, async () => {
    const receipt = { success: true, catalogRefresh: { status: "skipped", reason: "busy", retryable: true } };
    const f = fixture({ receipt });
    expect(await lifecycle(sub, ["fixture", "--json", ...(sub === "remove" ? ["--yes"] : [])], f.deps)).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual(receipt);
  });
  test("malformed success receipt cannot leak unknown fields", async () => {
    const f = fixture({ receipt: { success: true, apiKey: SENTINEL } });
    expect(await lifecycle("remove", ["fixture", "--yes", "--json"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); assertPrivateOutput();
  });
  test("unknown write outcome is neither retried nor called success", async () => {
    const f = fixture({ failAt: 3 });
    expect(await lifecycle("add", ["fixture", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(3); expect(output).not.toHaveBeenCalled(); assertPrivateOutput();
  });
  test("redirect refusal is explicit at every request boundary", async () => {
    const f = fixture();
    f.deps.fetchImpl = (async (_input, init) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError(SENTINEL);
    }) as typeof fetch;
    expect(await lifecycle("add", ["fixture", "--json"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); assertPrivateOutput();
  });
});
