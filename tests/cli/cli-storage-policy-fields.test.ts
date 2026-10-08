import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleStorageCommand } from "../../src/cli/storage";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, StorageCleanupPolicy } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let home: TempHome;
let output: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
let oldToken: string | undefined;
const nativeFetch = globalThis.fetch;
beforeEach(() => {
  home = createTempHome("ocx-cli-storage-fields-");
  oldToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  output = spyOn(console, "log").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden"); });
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  network.mockRestore(); output.mockRestore(); errors.mockRestore();
  if (oldToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldToken;
  home.remove();
});
const policy: StorageCleanupPolicy = { enabled: false, trigger: { archivedBytesOver: 1000 }, target: { removeOldestPercent: 25 }, schedule: "manual", mode: "quarantine" };
const receipt = () => ({ ok: true, policy: structuredClone(policy), job: { status: "idle" } });
type Call = { method: string; path: string; body: unknown; redirect: RequestRedirect | undefined };
function fixture(reply: unknown = receipt(), status = 200) {
  const calls: Call[] = [];
  let discoveries = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { discoveries++; return { pid: null, port: 15100, source: "runtime" }; },
    fetchImpl: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined, redirect: init?.redirect });
      return Response.json(reply, { status });
    },
  };
  return { calls, deps, discoveries: () => discoveries };
}
const json = () => JSON.parse(output.mock.calls.flat().join("\n"));

describe("storage policy field controls", () => {
  test.each([
    [["--archived-bytes-over", "0"], { trigger: { archivedBytesOver: 0 } }],
    [["--reduce-to-bytes", "0"], { target: { reduceToBytes: 0 } }],
    [["--remove-oldest-percent", "10"], { target: { removeOldestPercent: 10 } }],
    [["--archived-bytes-over", "9007199254740991", "--reduce-to-bytes", "9007199254740991"],
      { trigger: { archivedBytesOver: Number.MAX_SAFE_INTEGER }, target: { reduceToBytes: Number.MAX_SAFE_INTEGER } }],
    [["--archived-bytes-over", "1_024", "--percent", "40", "--enabled", "false"],
      { enabled: false, trigger: { archivedBytesOver: 1024 }, target: { removeOldestPercent: 40 } }],
  ] as [string[], unknown][])("sends exact supplied policy fields: %j", async (args, body) => {
    const f = fixture();
    expect(await handleStorageCommand(["policy", "set", ...args, "--json"], f.deps)).toBe(0);
    expect(f.calls).toEqual([{ method: "PUT", path: "/api/storage/cleanup-policy", body, redirect: "error" }]);
    expect(f.discoveries()).toBe(1);
    expect(json()).toEqual(receipt());
  });
  const invalid = [
    ["--reduce-to-bytes", "1", "--percent", "20"],
    ["--reduce-to-bytes", "1", "--remove-oldest-percent", "20"],
    ["--percent", "20", "--remove-oldest-percent", "20"],
    ["--archived-bytes-over", "1", "--run"],
    ...["--archived-bytes-over", "--reduce-to-bytes", "--remove-oldest-percent"].flatMap(flag => [
      [flag], [flag, "-1"], [flag, "1.5"], [flag, "1e3"], [flag, "9007199254740992"], [flag, "NaN"], [flag, "1", flag, "2"],
    ]),
  ];
  test.each(invalid)("invalid or conflicting fields cause no discovery: %j", async (...args) => {
    const f = fixture();
    expect(await handleStorageCommand(["policy", "set", ...args], f.deps)).toBe(2);
    expect(f.discoveries()).toBe(0); expect(f.calls).toEqual([]); expect(output).not.toHaveBeenCalled();
  });
  test.each(["--percent", "--remove-oldest-percent"])("%s retains server range refusal", async flag => {
    for (const value of ["0", "101"]) {
      const f = fixture({ error: "target must set exactly one of reduceToBytes (non-negative int) or removeOldestPercent (1-100)" }, 400);
      expect(await handleStorageCommand(["policy", "set", flag, value], f.deps)).toBe(1);
      expect(f.calls[0]?.body).toEqual({ target: { removeOldestPercent: Number(value) } });
      expect(output).not.toHaveBeenCalled();
    }
  });
  test.each([null, {}, { ok: false }, { ...receipt(), policy: { ...policy, target: { reduceToBytes: 0, removeOldestPercent: 10 } } },
    { ...receipt(), job: { status: "private-canary" } }])("malformed receipt never becomes success", async value => {
    const f = fixture(value);
    expect(await handleStorageCommand(["policy", "set", "--reduce-to-bytes", "0", "--json"], f.deps)).toBe(1);
    expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("private-canary");
  });
  test("unknown receipt fields and backend text do not leak", async () => {
    const f = fixture({ ...receipt(), secret: "private-canary", policy: { ...policy, private: "private-canary" }, job: { status: "idle", lastError: "private-canary" } });
    expect(await handleStorageCommand(["policy", "set", "--reduce-to-bytes", "0", "--json"], f.deps)).toBe(0);
    expect(json()).toEqual(receipt());
    output.mockClear();
    const failure = fixture({ error: "private-canary", hint: "private-canary" }, 409);
    expect(await handleStorageCommand(["policy", "set", "--reduce-to-bytes", "0"], failure.deps)).toBe(5);
    expect(output).not.toHaveBeenCalled(); expect(errors.mock.calls.flat().join(" ")).not.toContain("private-canary");
  });
  test("human receipt displays observed policy values and separates saving from running", async () => {
    const f = fixture();
    expect(await handleStorageCommand(["policy", "set", "--archived-bytes-over", "1000"], f.deps)).toBe(0);
    expect(output.mock.calls.flat().join("\n")).toBe([
      "Policy saved. This command did not start cleanup.", "Enabled: false", "Trigger: archived bytes over 1000",
      "Target: remove oldest 25%", "Mode: quarantine; schedule: manual; job: idle",
    ].join("\n"));
  });
  test.each([false, true])("real owner preserves omitted enabled=%s and untouched fields, without running cleanup", async enabled => {
    const initial = { ...policy, enabled, trigger: { archivedBytesOver: 8000 }, target: { reduceToBytes: 6000 } };
    const config: OcxConfig = { port: 15100, defaultProvider: "fixture", providers: {}, storageCleanupPolicy: initial };
    saveConfig(config);
    const calls: string[] = [];
    const deps: RuntimeApiDeps = { baseUrl: "http://127.0.0.1:15100", fetchImpl: async (input, init) => {
      const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const result = await handleManagementAPI(new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: url.host } }), url, config, {}, "admin-token");
      if (!result) throw new Error("Unexpected route");
      return result;
    } };
    expect(await handleStorageCommand(["policy", "set", "--archived-bytes-over", "4000", "--json"], deps)).toBe(0);
    expect(loadConfig().storageCleanupPolicy).toEqual({ ...initial, trigger: { archivedBytesOver: 4000 } });
    expect(json().policy).toEqual(loadConfig().storageCleanupPolicy);
    expect(await handleStorageCommand(["policy", "set", "--remove-oldest-percent", "30", "--json"], deps)).toBe(0);
    expect(loadConfig().storageCleanupPolicy).toEqual({ ...initial, trigger: { archivedBytesOver: 4000 }, target: { removeOldestPercent: 30 } });
    expect(await handleStorageCommand(["policy", "set", "--reduce-to-bytes", "3000", "--json"], deps)).toBe(0);
    const expected = { ...initial, trigger: { archivedBytesOver: 4000 }, target: { reduceToBytes: 3000 } };
    expect(loadConfig().storageCleanupPolicy).toEqual(expected);
    expect(await handleStorageCommand(["policy", "set", "--remove-oldest-percent", "0", "--json"], deps)).toBe(1);
    expect(loadConfig().storageCleanupPolicy).toEqual(expected);
    expect(calls).toEqual(Array(4).fill("PUT /api/storage/cleanup-policy"));
    expect(config.storageCleanupPolicy).toEqual(loadConfig().storageCleanupPolicy);
  });
  test("redirect refuses before reaching another owned loopback endpoint", async () => {
    let first = 0, second = 0;
    const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { second++; return Response.json(receipt()); } });
    const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { first++; return Response.redirect(destination.url, 307); } });
    try {
      expect(await handleStorageCommand(["policy", "set", "--reduce-to-bytes", "0", "--json"], {
        baseUrl: origin.url.origin, fetchImpl: nativeFetch,
      })).toBe(1);
      expect(first).toBe(1); expect(second).toBe(0); expect(output).not.toHaveBeenCalled();
    } finally { await origin.stop(true); await destination.stop(true); }
  });
});
