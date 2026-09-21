import { describe, expect, test } from "bun:test";
import {
  RESOLVE_DEFAULT_PORT,
  RESOLVE_SCHEMA,
  buildResolveJson,
  parseResolveArgs,
  runResolve,
} from "../../src/cli/resolve";
import type { LiveProxy } from "../../src/server/proxy-liveness";

function fakeLive(overrides: Partial<LiveProxy> = {}): LiveProxy {
  return {
    pid: 4242,
    port: 10110,
    hostname: "127.0.0.1",
    source: "runtime",
    version: "9.9.9",
    ...overrides,
  };
}

describe("parseResolveArgs", () => {
  test("accepts the bare verb and --json, rejects anything else with code 64", () => {
    expect(parseResolveArgs([])).toEqual({ ok: true, args: { json: false } });
    expect(parseResolveArgs(["--json"])).toEqual({ ok: true, args: { json: true } });
    expect(parseResolveArgs(["--json", "--json"])).toEqual({ ok: true, args: { json: true } });
    for (const argv of [["extra"], ["--wait", "5"], ["-"], ["--json", "extra"]]) {
      expect(parseResolveArgs(argv)).toEqual({ ok: false, code: 64 });
    }
  });
});

describe("buildResolveJson", () => {
  test("a live runtime-record proxy answers with its own port and identity", () => {
    const json = buildResolveJson({ port: 12345 }, fakeLive(), "/home/fixture/.opencodex", "1.2.3");
    expect(json).toEqual({
      schema: RESOLVE_SCHEMA,
      cliVersion: "1.2.3",
      configHome: "/home/fixture/.opencodex",
      port: { effective: 10110, configured: 12345, source: "runtime" },
      liveness: {
        status: "live",
        pid: 4242,
        port: 10110,
        hostname: "127.0.0.1",
        source: "runtime",
        version: "9.9.9",
      },
    });
  });

  test("without a live proxy the configured port is the effective one", () => {
    const json = buildResolveJson({ port: 12345 }, null, "/home/fixture/.opencodex", "1.2.3");
    expect(json.port).toEqual({ effective: 12345, configured: 12345, source: "config" });
    expect(json.liveness).toEqual({ status: "not-found", pid: null, port: null, source: null });
  });

  test("an absent configured port resolves to the CLI default", () => {
    const json = buildResolveJson({}, null, "/home/fixture/.opencodex", "1.2.3");
    expect(json.port).toEqual({
      effective: RESOLVE_DEFAULT_PORT,
      configured: RESOLVE_DEFAULT_PORT,
      source: "config",
    });
  });

  test("optional liveness identity fields are omitted, never null-coerced", () => {
    const legacy = fakeLive({ version: undefined, role: undefined, hostname: undefined });
    const json = buildResolveJson({}, legacy, "/h", "1.2.3");
    expect(json.liveness).toEqual({
      status: "live",
      pid: 4242,
      port: 10110,
      source: "runtime",
    });
  });
});

describe("runResolve", () => {
  test("prints exactly one JSON document and exits 0 for a live proxy", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/home/fixture/.opencodex",
      loadConfig: () => ({ port: 12345 }),
      findLive: async () => fakeLive(),
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      schema: RESOLVE_SCHEMA,
      cliVersion: "1.2.3",
      configHome: "/home/fixture/.opencodex",
      port: { effective: 10110, configured: 12345, source: "runtime" },
      liveness: {
        status: "live",
        pid: 4242,
        port: 10110,
        hostname: "127.0.0.1",
        source: "runtime",
        version: "9.9.9",
      },
    });
  });

  test("a not-found verdict is a successful answer, not a failure", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      loadConfig: () => ({}),
      findLive: async () => null,
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as { liveness: { status: string }; port: { effective: number } };
    expect(parsed.liveness.status).toBe("not-found");
    expect(parsed.port.effective).toBe(RESOLVE_DEFAULT_PORT);
  });

  test("a resolution failure exits 1 with nothing on stdout", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      loadConfig: () => { throw new Error("config.json is not valid JSON"); },
      findLive: async () => null,
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("config.json is not valid JSON");
  });

  test("the default output is two human lines, never JSON", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: false }, {
      configDir: () => "/home/fixture/.opencodex",
      loadConfig: () => ({ port: 12345 }),
      findLive: async () => fakeLive(),
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Config home: /home/fixture/.opencodex");
    expect(lines[1]).toContain("Proxy live on port 10110 (PID 4242, 9.9.9)");
    expect(lines.every(line => { try { JSON.parse(line); return false; } catch { return true; } })).toBe(true);
  });

  test("human output for a not-found verdict names the effective port", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: false }, {
      configDir: () => "/h",
      loadConfig: () => ({}),
      findLive: async () => null,
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines[1]).toBe(`No live proxy; effective port ${RESOLVE_DEFAULT_PORT} (configured).`);
  });
});
