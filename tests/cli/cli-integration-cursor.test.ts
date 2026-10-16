import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { handleCursorIntegrationCommand } from "../../src/cli/integration-cursor";
import { handleIntegrationCommand } from "../../src/cli/inspect";
import type { CursorIntegrationStatus } from "../../src/server/management/cursor-integration-routes";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const realFetch = globalThis.fetch;
let home: TempHome, output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let admin: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-cursor-cli-"); mkdirSync(home.codexHome, { recursive: true });
  admin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN; delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {}); errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = admin;
  home.remove();
});
function status(apiKeyMode: "credential" | "placeholder" = "placeholder"): CursorIntegrationStatus {
  return { privateInference: { installed: false, path: null, version: null }, regularCursor: { installed: true, path: "/fixture/Cursor" },
    gateway: { baseUrl: "http://127.0.0.1:15801/v1", apiKeyMode, placeholder: "opencodex-loopback" }, lastSeen: null,
    effortTable: { source: "static", version: null, families: null }, models: [{ id: "fixture/model", reasoning: ["low", "high"], family: "fixture", tableLess: false,
      effortRows: ["fixture/model~high"], context: { defaultWindow: 100000, longWindow: 1000000 } }],
    guideUrl: "https://lidge-jun.github.io/opencodex/guides/cursor-private-inference/" };
}
function fixture(reply: unknown = status()) {
  const calls: { path: string; method: string; body: unknown }[] = []; let discoveries = 0;
  const deps: RuntimeApiDeps = { findLiveProxy: async () => { discoveries++; return { pid: null, port: 15801, source: "runtime" }; },
    fetchImpl: async (input, init) => { expect(init?.redirect).toBe("error"); calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body });
      return reply instanceof Response ? reply : Response.json(reply); } };
  return { deps, calls, discoveries: () => discoveries };
}
const stdout = () => output.mock.calls.flat().join("\n");
const stderr = () => errors.mock.calls.flat().join("\n");
const json = () => JSON.parse(stdout());

describe("Cursor CLI read-only integration", () => {
  test("public native dispatcher routes Cursor reads and preserves operation and usage failures", async () => {
    const f = fixture({ available: false, url: null, version: null, reason: null });
    expect(await handleIntegrationCommand(["native", "cursor", "local-installer", "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/native-integrations/cursor/local-installer", method: "GET", body: undefined }]);
    output.mockClear();
    expect(await handleIntegrationCommand(["native", "cursor", "on"], f.deps)).toBe(2); expect(f.calls).toHaveLength(1);
    const refused = fixture(Response.json({ error: "private-fixture" }, { status: 503 }));
    expect(await handleIntegrationCommand(["native", "cursor", "status", "--json"], refused.deps)).toBe(1);
    expect(refused.calls[0]!.path).toBe("/api/native-integrations/cursor"); expect(stdout()).toBe("");
  });
  test.each([[], ["status"]].map(args => [args]))("default and status issue exactly one fixed GET", async args => {
    const f = fixture(); expect(await handleCursorIntegrationCommand([...args, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ path: "/api/native-integrations/cursor", method: "GET", body: undefined }]); expect(json()).toEqual(status());
  });
  test.each(["credential", "placeholder"] as const)("credential distinction is preserved in human and JSON modes", async mode => {
    const f = fixture({ ...status(mode), apiKey: "private-fixture", gateway: { ...status(mode).gateway, apiKey: "private-fixture" } });
    expect(await handleCursorIntegrationCommand([], f.deps)).toBe(0);
    expect(stdout()).toContain(mode === "credential" ? "existing proxy credential is required" : "API key placeholder"); expect(stdout()).not.toContain("private-fixture");
    output.mockClear(); expect(await handleCursorIntegrationCommand(["--json"], f.deps)).toBe(0);
    expect(json()).toEqual(status(mode)); expect(stdout()).not.toContain("private-fixture");
  });
  test("installed/last-seen/bundle model state is public and terminal-safe", async () => {
    const raw = status(); raw.privateInference = { installed: true, path: "/fixture/CursorLocal", version: "1.0" };
    raw.lastSeen = { at: 42, userAgent: "Cursor/1.0" }; raw.effortTable = { source: "bundle", version: "1.0", families: 2 };
    raw.models[0]!.id = "fixture/model\u001b[31m"; raw.models[0]!.reasoning = null; raw.models[0]!.family = null; raw.models[0]!.context = null; raw.models[0]!.tableLess = true;
    const f = fixture(raw); expect(await handleCursorIntegrationCommand([], f.deps)).toBe(0); expect(stdout()).not.toContain("\u001b"); expect(stdout()).toContain("Cursor/1.0");
    output.mockClear(); expect(await handleCursorIntegrationCommand(["--json"], f.deps)).toBe(0); expect(json()).toEqual(raw);
  });
  test("empty model inventory is successful observation", async () => {
    const f = fixture({ ...status(), models: [] }); expect(await handleCursorIntegrationCommand([], f.deps)).toBe(0); expect(stdout()).toContain("Models: 0");
  });
  test("installer lookup prints a URL without fetching it", async () => {
    const raw = { available: true, url: "https://downloads.cursor.com/local-mode/fixture/installer.dmg", version: "1.0", reason: null };
    const f = fixture({ ...raw, token: "private-fixture" }); expect(await handleCursorIntegrationCommand(["local-installer", "--json"], f.deps)).toBe(0);
    expect(json()).toEqual(raw); expect(f.calls).toEqual([{ path: "/api/native-integrations/cursor/local-installer", method: "GET", body: undefined }]);
    output.mockClear(); expect(await handleCursorIntegrationCommand(["local-installer"], f.deps)).toBe(0); expect(stdout()).toContain("Nothing was downloaded or installed.");
  });
  test.each([null, "no-regular-install", "unsupported-platform", "unreachable", "unusable-response"])("valid unavailable installer reason remains a successful inspection", async reason => {
    const raw = { available: false, url: null, version: null, reason }, f = fixture(raw);
    expect(await handleCursorIntegrationCommand(["local-installer", "--json"], f.deps)).toBe(0); expect(json()).toEqual(raw);
    output.mockClear(); expect(await handleCursorIntegrationCommand(["local-installer"], f.deps)).toBe(0); expect(stdout()).toContain("No installer advertised");
    if (reason) expect(stdout()).toContain(reason);
  });
  test.each([["on"], ["off"], ["install"], ["status", "extra"], ["--url", "https://private-fixture.invalid"], ["status", "--json", "--json"], ["local-installer", "--yes"]].map(args => [args]))("invalid action/flags fail before discovery", async args => {
    const f = fixture(); expect(await handleCursorIntegrationCommand(args, f.deps)).toBe(2); expect(f.discoveries()).toBe(0); expect(f.calls).toEqual([]);
    expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-fixture");
  });
  test.each([null, {}, { ...status(), models: {} }, { ...status(), lastSeen: {} }, { ...status(), privateInference: {} },
    { ...status(), gateway: { ...status().gateway, apiKeyMode: "unknown" } },
    { ...status(), gateway: { ...status().gateway, placeholder: "private-fixture" } },
    { ...status(), gateway: { ...status().gateway, baseUrl: "https://private:fixture@example.test/v1" } },
    { ...status(), effortTable: { source: "unexpected", version: null, families: null } },
    { ...status(), models: [{ ...status().models[0], context: { defaultWindow: -1, longWindow: 4 } }] },
    { ...status(), guideUrl: "https://private-fixture.invalid" },
  ])("malformed status fails closed with static diagnostics", async raw => {
    const f = fixture(raw); expect(await handleCursorIntegrationCommand(["--json"], f.deps)).toBe(1); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-fixture");
  });
  test.each([{}, { available: false, url: null, version: null }, { available: false, url: null, version: null, reason: "private-fixture" },
    { available: true, url: null, version: "1", reason: null },
    { available: true, url: "https://private-fixture.invalid/installer", version: "1", reason: null },
    { available: false, url: "https://downloads.cursor.com/local-mode/a", version: "1", reason: null },
    { available: true, url: "https://downloads.cursor.com/local-mode/a", version: "1", reason: "unreachable" },
  ])("malformed installer hints cannot claim success", async raw => {
    const f = fixture(raw); expect(await handleCursorIntegrationCommand(["local-installer", "--json"], f.deps)).toBe(1); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-fixture");
  });
  test.each([[401, 1], [404, 4], [409, 5], [503, 1]])("runtime refusal exposes neither body nor credentials", async (statusCode, exit) => {
    const f = fixture(Response.json({ error: "private-fixture", apiKey: "private-fixture" }, { status: statusCode }));
    expect(await handleCursorIntegrationCommand(["--json"], f.deps)).toBe(exit); expect(stdout()).toBe(""); expect(stderr()).not.toContain("private-fixture");
  });
  test("client-role and stopped runtime never use a local fallback", async () => {
    for (const live of [null, { pid: null, port: 15801, source: "runtime" as const, role: "client" as const }]) {
      expect(await handleCursorIntegrationCommand([], { findLiveProxy: async () => live })).toBe(1);
    }
    expect(stdout()).toBe(""); expect(stderr()).toContain("Hub");
  });
  test("a management redirect cannot issue a second request", async () => {
    let redirectedCalls = 0, initialCalls = 0;
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { redirectedCalls++; return Response.json(status()); } });
    const first = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { initialCalls++; return Response.redirect(new URL("/received", target.url), 307); } });
    try {
      const origin = new URL(first.url).origin;
      const deps: RuntimeApiDeps = { baseUrl: origin, fetchImpl: (input, init) => {
        if (new URL(String(input)).origin !== origin) throw new Error("Unexpected initial URL");
        return realFetch(input, init);
      } };
      expect(await handleCursorIntegrationCommand(["--json"], deps)).toBe(1);
      expect(initialCalls).toBe(1); expect(redirectedCalls).toBe(0); expect(stdout()).toBe("");
    } finally { await first.stop(true); await target.stop(true); }
  });
});

for (const wantsJson of [false, true]) {
  test(`singleton arrays cannot masquerade as Cursor enums (JSON ${wantsJson})`, async () => {
    for (const [action, raw] of [
      ["status", { ...status(), gateway: { ...status().gateway, apiKeyMode: ["credential"] } }],
      ["status", { ...status(), effortTable: { ...status().effortTable, source: ["static"] } }],
      ["local-installer", { available: false, url: null, version: null, reason: ["unreachable"] }],
    ] as const) {
      output.mockClear(); errors.mockClear();
      const f = fixture(raw);
      expect(await handleIntegrationCommand(["native", "cursor", action, ...(wantsJson ? ["--json"] : [])], f.deps)).toBe(1);
      expect(f.calls).toHaveLength(1);
      expect(stdout()).toBe("");
      expect(stderr()).toContain("did not return a usable outcome");
    }
  });
}
