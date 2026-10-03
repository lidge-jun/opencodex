import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_REMOTE_CAPABILITIES } from "../../src/cli/capabilities-access-remote";
import { OBSERVE_SYSTEM_CAPABILITIES } from "../../src/cli/capabilities-observe-system";
import { CAPABILITIES as BASE } from "../../src/cli/capabilities-base";
import { handleAccessCommand } from "../../src/cli/access";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { repoPath } from "../helpers/repo-root";

const envKeys = ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let savedEnv: Array<string | undefined>;
let home: string;
let output: ReturnType<typeof spyOn>;
let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  savedEnv = envKeys.map(key => process.env[key]);
  home = mkdtempSync(join(tmpdir(), "ocx-capability-access-"));
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
  const value = ACCESS_REMOTE_CAPABILITIES.find(row => row.command.join(" ") === key);
  if (!value) throw new Error(`Missing capability: ${key}`);
  return value;
}
function transport(payload: unknown = {}) {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const deps: RuntimeApiDeps = {
    baseUrl: "http://capability.invalid",
    fetchImpl: async (input, init) => {
      expect(new Headers(init?.headers).has("X-OpenCodex-API-Key")).toBe(false);
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(payload);
    },
  };
  return { deps, requests };
}

describe("access capability workflows preserve consent and handler grammar", () => {
  test("published key listing requires the explicit action before JSON", async () => {
    expect(capability("access key").usage).toBe("ocx access key list [--json]");
    const io = transport({ keys: [] });
    expect(await handleAccessCommand(["key", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
    expect(await handleAccessCommand(["key", "list", "--json"], io.deps)).toBe(0);
    expect(io.requests).toHaveLength(1);
  });
  test("masked list and get use one real list endpoint, with ID/name resolution", async () => {
    const row = { id: "fixture-id", name: "Fixture", prefix: "masked", allowedProviders: ["fixture"] };
    const io = transport({ keys: [row] });
    for (const key of ["access key list", "access key get"]) {
      expect(capability(key).routes).toEqual([{ method: "GET", path: "/api/keys" }]);
      expect(capability(key).mutates).toBe(false);
    }
    expect(await handleAccessCommand(["key", "list", "--json"], io.deps)).toBe(0);
    expect(await handleAccessCommand(["key", "get", "FIXTURE", "--json"], io.deps)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[1]![0]))).toEqual(row);
    expect(io.requests).toEqual([
      { method: "GET", path: "/api/keys", body: null },
      { method: "GET", path: "/api/keys", body: null },
    ]);
  });
  test("scope set replaces named dimensions and preserves repeatable values", async () => {
    const io = transport({ keys: [{ id: "fixture-id", name: "Fixture" }] });
    const leaf = capability("access key set");
    expect(leaf.routes).toEqual([{ method: "GET", path: "/api/keys" }, { method: "PATCH", path: "/api/keys" }]);
    expect(leaf.flags.map(flag => flag.name)).toEqual(["--allow-provider", "--allow-model", "--clear", "--json"]);
    expect(await handleAccessCommand(["key", "set", "Fixture", "--clear", "--allow-provider", "p1", "--allow-provider", "p2", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([
      { method: "GET", path: "/api/keys", body: null },
      { method: "PATCH", path: "/api/keys", body: { id: "fixture-id", allowedProviders: ["p1", "p2"], allowedModels: null } },
    ]);
  });
  test("ambiguous key name refuses without changing either key", async () => {
    const io = transport({ keys: [{ id: "one", name: "same" }, { id: "two", name: "same" }] });
    expect(capability("access key set").mutates).toBe(true);
    expect(await handleAccessCommand(["key", "set", "same", "--allow-model", "p/model", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([{ method: "GET", path: "/api/keys", body: null }]);
  });
  test("endpoints is a filtered envelope, models is the public data-plane catalog", async () => {
    const io = transport({ baseUrl: "http://fixture.invalid", responsesEndpoint: "http://fixture.invalid/v1/responses", keys: [], audio: { enabled: false } });
    expect(capability("access endpoints").json).toBe("envelope");
    expect(await handleAccessCommand(["endpoints", "--json"], io.deps)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({ baseUrl: "http://fixture.invalid", responsesEndpoint: "http://fixture.invalid/v1/responses" });
    expect(capability("access models").routes).toEqual([]);
    expect(await handleAccessCommand(["models", "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "GET", path: "/api/keys", body: null }, { method: "GET", path: "/v1/models", body: null }]);
  });
  test.each(["commit", "abort"])("rotation %s requires both IDs before transport", async operation => {
    const leaf = capability("access key rotate " + operation);
    expect(leaf.usage).toBe("ocx access key rotate " + operation + " <id> <rotation-id> [--json]");
    expect(leaf.routes).toEqual([{ method: operation === "commit" ? "POST" : "DELETE", path: operation === "commit" ? "/api/keys/rotate/commit" : "/api/keys/rotate" }]);
    const io = transport();
    expect(await handleAccessCommand(["key", "rotate", operation, "fixture-id", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
    // Source proof for destructive completion; never complete a real or fake rotation here.
    const source = readFileSync(repoPath("src/cli/access.ts"), "utf8");
    expect(source).toContain('body: JSON.stringify({ id, rotationId })');
    expect(source).toContain('method: operation === "commit" ? "POST" : "DELETE"');
  });
  test("revocation requires explicit confirmation before transport", async () => {
    expect(capability("access key remove").flags.find(flag => flag.name === "--yes")?.required).toBe(true);
    const io = transport();
    expect(await handleAccessCommand(["key", "remove", "fixture-id", "--json"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
  });
  test.each([
    ["chat", "/v1/chat/completions", { model: "fixture/model", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16, stream: false }],
    ["responses", "/v1/responses", { model: "fixture/model", input: "Reply with OK.", max_output_tokens: 16 }],
    ["messages", "/v1/messages", { model: "fixture/model", messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 16 }],
  ] as const)("inference %s uses only a fake transport and the existing body", async (protocol, path, body) => {
    const leaf = capability("access test");
    expect(leaf.mutates).toBe(true);
    expect(leaf.routes).toEqual([]);
    const io = transport({ ok: true });
    expect(await handleAccessCommand(["test", "fixture/model", "--protocol", protocol, "--json"], io.deps)).toBe(0);
    expect(io.requests).toEqual([{ method: "POST", path, body }]);
  });
  test("chosen-key, rename and audio capabilities match supported explicit workflows", async () => {
    const leaf = capability("access test");
    expect(leaf.flags.map(flag => flag.name)).toEqual(["--protocol", "--json", "--api-key-stdin"]);
    const io = transport();
    expect(await handleAccessCommand(["test", "fixture/model", "--api-key-stdin", "--api-key-stdin"], io.deps)).toBe(2);
    expect(io.requests).toEqual([]);
    const keys = ACCESS_REMOTE_CAPABILITIES.map(row => row.command.join(" "));
    expect(keys).toContain("access key rename");
    expect(keys).toContain("access audio transcribe");
    expect(keys).toContain("access audio live-check");
  });
  test("secret-returning actions are family handoffs, never executable headings", () => {
    const family = capability("access key");
    expect(family.mutates).toBe(true);
    expect(family.usage).toBe("ocx access key list [--json]");
    for (const leaf of ACCESS_REMOTE_CAPABILITIES) {
      const key = leaf.command.join(" ");
      expect(key).not.toBe("access key create");
      expect(key).not.toBe("access key rotate");
      expect(leaf.usage).not.toMatch(/access key create|access key rotate (?:<|start)/);
    }
  });
  test("new literals are unique, disjoint from baseline and import types only", () => {
    const rows = [...OBSERVE_SYSTEM_CAPABILITIES, ...ACCESS_REMOTE_CAPABILITIES];
    const keys = rows.map(row => row.command.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    const baselineKeys = new Set(BASE.map(row => row.command.join(" ")));
    expect(keys.filter(key => baselineKeys.has(key))).toEqual([]);
    for (const name of ["capabilities-observe-system.ts", "capabilities-access-remote.ts"]) {
      const source = readFileSync(repoPath("src/cli", name), "utf8");
      expect(source.match(/^import .*$/gm)).toEqual(['import type { Capability } from "./capability-types";']);
      expect(source).not.toMatch(/import\(|require\(|process\.|Bun\./);
    }
    for (const leaf of rows) {
      if (leaf.command.join(" ") === "config export") expect(leaf.usage).toBeUndefined();
      else expect(leaf.usage?.startsWith("ocx " + leaf.command.join(" "))).toBe(true);
      expect(leaf.flags.map(flag => flag.name)).not.toContain("--live");
    }
  });
});
