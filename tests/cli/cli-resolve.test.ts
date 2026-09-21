import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RESOLVE_DEFAULT_PORT,
  RESOLVE_SCHEMA,
  buildResolveJson,
  parseResolveArgs,
  runResolve,
} from "../../src/cli/resolve";
import type { LiveProxy } from "../../src/server/proxy-liveness";
import type { ConfigDiagnostics } from "../../src/config";
import { repoPath } from "../helpers/repo-root";

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
    expect(json.liveness).toEqual({ status: "absent-proven", pid: null, port: null, source: null });
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
      readDiagnostics: () => ({ config: { port: 12345 }, source: "file", error: null } as ConfigDiagnostics),
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

  test("a proven-absent verdict is a successful answer, not a failure", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => null,
      probeEndpoint: () => "dead",
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as { liveness: { status: string }; port: { effective: number } };
    expect(parsed.liveness.status).toBe("absent-proven");
    expect(parsed.port.effective).toBe(RESOLVE_DEFAULT_PORT);
  });

  test("accepts async dead probes for every candidate endpoint", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => ({ port: 10110, hostname: "127.0.0.1" }),
      probeEndpoint: async () => "dead",
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect((JSON.parse(lines[0]!) as { liveness: { status: string } }).liveness.status).toBe("absent-proven");
  });

  test("an undecidable probe is unknown, and unknown is never answered as absent", async () => {
    // The launch decision keys on this verdict: a timed-out probe or a listener that
    // withholds /healthz must exit 1 rather than let the caller start a second runtime.
    for (const probeEndpoint of [() => "unknown" as const, () => { throw new Error("spawn unavailable"); }]) {
      const lines: string[] = [];
      const errors: string[] = [];
      const code = await runResolve({ json: true }, {
        configDir: () => "/h",
        readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
        findLive: async () => null,
        readRuntime: () => null,
        probeEndpoint,
        cliVersion: () => "1.2.3",
        stdout: { log: value => lines.push(value) },
        stderr: { error: value => errors.push(value) },
      });
      expect(code).toBe(1);
      expect(lines).toEqual([]);
      expect(errors.join("\n")).toContain("unknown");
    }
  });

  test("absence requires every endpoint dead, not just the configured one", async () => {
    // The runtime record can point at a live port while the configured port refuses;
    // answering from the configured port alone would shadow-start over the record.
    // Every candidate is probed: an unknown runtime endpoint defeats the proof even when the
    // configured endpoint is dead.
    const seen: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: { port: 10100 }, source: "file", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => ({ port: 10110, hostname: "127.0.0.1" }),
      probeEndpoint: endpoint => { seen.push(String(endpoint.port)); return endpoint.port === 10110 ? "unknown" : "dead"; },
      cliVersion: () => "1.2.3",
      stdout: { log: () => {} },
      stderr: { error: () => {} },
    });
    expect(code).toBe(1);
    expect(seen).toContain("10110");
  });

  test("proven absent probes both the runtime record and the configured port", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: { port: 10100 }, source: "file", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => ({ port: 10110, hostname: "127.0.0.1" }),
      probeEndpoint: endpoint => { seen.push(String(endpoint.port)); return "dead"; },
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(seen).toEqual(["10110", "10100"]);
    expect((JSON.parse(lines[0]!) as { liveness: { status: string } }).liveness.status).toBe("absent-proven");
  });

  test("a config read failure exits 1 with nothing on stdout", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => { throw new Error("config.json is not readable"); },
      findLive: async () => null,
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("config.json is not readable");
  });

  test("an invalid config is refused, not repaired to defaults", async () => {
    // loadConfig repairs a broken config to factory defaults; a shell contract must not
    // answer 10100 for a config the operator pointed at another port. The diagnostics
    // surface distinguishes that case (source "fallback") so resolve can exit 1.
    const lines: string[] = [];
    const errors: string[] = [];
    let probed = false;
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "fallback", error: "invalid_json" } as ConfigDiagnostics),
      findLive: async () => { probed = true; return null; },
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(1);
    expect(lines).toEqual([]);
    expect(errors.join("\n")).toContain("refusing to guess");
    // No liveness probe may run against a guessed port.
    expect(probed).toBe(false);
  });

  test("the production default probes with the ownership-safe budget", () => {
    // Source oracle: the verdict feeds the shell's launch decision, so it borrows the
    // start path's START_OWNERSHIP_LIVENESS budget instead of the 750ms single probe.
    const src = readFileSync(repoPath("src", "cli", "resolve.ts"), "utf8");
    expect(src).toContain("findLiveProxy(START_OWNERSHIP_LIVENESS)");
  });

  test("the default output is two human lines, never JSON", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: false }, {
      configDir: () => "/home/fixture/.opencodex",
      readDiagnostics: () => ({ config: { port: 12345 }, source: "file", error: null } as ConfigDiagnostics),
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

  test("human output for a proven-absent verdict names the effective port", async () => {
    const lines: string[] = [];
    const code = await runResolve({ json: false }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => null,
      probeEndpoint: () => "dead",
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines[1]).toBe(`No live proxy (absence proven); effective port ${RESOLVE_DEFAULT_PORT} (configured).`);
  });
});
