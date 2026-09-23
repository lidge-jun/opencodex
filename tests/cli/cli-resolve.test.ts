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

const OWNERSHIP_NONE = { kind: "none", revision: 0 } as const;
const OWNERSHIP_OWNED = {
  kind: "owned",
  ownership: { owner: "desktop", installId: "install-a", consentGeneration: 3 },
  revision: 7,
} as const;
const OWNERSHIP_UNKNOWN = { kind: "unknown", reason: "a service state path could not be read" } as const;

const TAKEOVER_SUPPORTED = {
  kind: "supported",
  protocolVersion: 1,
  minimumCliVersion: "2.61.0",
  token: "deadbeef",
} as const;
const TAKEOVER_BLOCKED = {
  kind: "blocked",
  reason: "managing-cli-unsupported",
  detail: "path uses OpenCodex 2.59.0; 2.61.0 or later is required",
  minimumCliVersion: "2.61.0",
} as const;

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
    const json = buildResolveJson({ port: 12345 }, fakeLive(), "/home/fixture/.opencodex", "1.2.3", OWNERSHIP_OWNED, TAKEOVER_SUPPORTED);
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
      ownership: OWNERSHIP_OWNED,
      takeover: TAKEOVER_SUPPORTED,
    });
  });

  test("without a live proxy the configured port is the effective one", () => {
    const json = buildResolveJson({ port: 12345 }, null, "/home/fixture/.opencodex", "1.2.3", OWNERSHIP_NONE, TAKEOVER_BLOCKED);
    expect(json.port).toEqual({ effective: 12345, configured: 12345, source: "config" });
    expect(json.liveness).toEqual({ status: "absent-proven", pid: null, port: null, source: null });
  });

  test("an absent configured port resolves to the CLI default", () => {
    const json = buildResolveJson({}, null, "/home/fixture/.opencodex", "1.2.3", OWNERSHIP_NONE, TAKEOVER_BLOCKED);
    expect(json.port).toEqual({
      effective: RESOLVE_DEFAULT_PORT,
      configured: RESOLVE_DEFAULT_PORT,
      source: "config",
    });
  });

  test("optional liveness identity fields are omitted, never null-coerced", () => {
    const legacy = fakeLive({ version: undefined, role: undefined, hostname: undefined });
    const json = buildResolveJson({}, legacy, "/h", "1.2.3", OWNERSHIP_NONE, TAKEOVER_BLOCKED);
    expect(json.liveness).toEqual({
      status: "live",
      pid: 4242,
      port: 10110,
      source: "runtime",
    });
  });
});

/** Deterministic ownership seams: the production defaults read the real state directory. */
function ioOwnership(
  ownership: typeof OWNERSHIP_NONE | typeof OWNERSHIP_OWNED | typeof OWNERSHIP_UNKNOWN = OWNERSHIP_NONE,
  managers?: ReturnType<NonNullable<Parameters<typeof runResolve>[1]>["observeManagers"]> ,) {
  return {
    resolveOwnership: () => ownership,
    resolveState: () => ({ kind: "none", revision: 0, needsRepair: false }) as const,
    observeManagers: () => managers ?? ({
      "service-registration": { status: "absent" },
      path: { status: "absent" },
    }) as ReturnType<NonNullable<Parameters<typeof runResolve>[1]>["observeManagers"]>,
  };
}

describe("runResolve", () => {
  test("an unreadable second state read blocks takeover before manager observation", async () => {
    const lines: string[] = [];
    let observed = false;
    const code = await runResolve({ json: true }, {
      configDir: () => "/sandbox",
      readDiagnostics: () => ({ config: { port: 10100 }, source: "file", error: null } as ConfigDiagnostics),
      findLive: async () => fakeLive(),
      cliVersion: () => "2.61.0",
      resolveOwnership: () => ({ kind: "none", revision: 0 }),
      resolveState: () => ({ kind: "unknown", reason: "state unreadable" }),
      observeManagers: () => {
        observed = true;
        return {
          "service-registration": { status: "absent" },
          path: { status: "observed", version: "2.61.0", identity: "path-manager" },
        };
      },
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      ownership: { kind: "none", revision: 0 },
      takeover: { kind: "blocked", reason: "ownership-unknown", detail: "state unreadable" },
    });
    expect(observed).toBe(false);
  });
  test("prints exactly one JSON document and exits 0 for a live proxy", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/home/fixture/.opencodex",
      readDiagnostics: () => ({ config: { port: 12345 }, source: "file", error: null } as ConfigDiagnostics),
      findLive: async () => fakeLive(),
      cliVersion: () => "1.2.3",
      ...ioOwnership(OWNERSHIP_OWNED),
      resolveState: () => ({ kind: "state", state: { ownershipProtocolVersion: 1 } as never, revision: 7, needsRepair: false }),
      observeManagers: () => ({
        "service-registration": { status: "observed", version: "2.61.0", identity: "registered" },
        path: { status: "observed", version: "2.61.0", identity: "path" },
      }),
      stdout: { log: value => lines.push(value) },
      stderr: { error: value => errors.push(value) },
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(1);
    const document = JSON.parse(lines[0]!);
    expect(document).toMatchObject({
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
      ownership: OWNERSHIP_OWNED,
    });
    expect(document.takeover).toMatchObject({ kind: "supported", protocolVersion: 1 });
  });

  test("a proven-absent verdict is a successful answer, not a failure", async () => {
    const lines: string[] = [];
    let managerProbes = 0;
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
      findLive: async () => null,
      readRuntime: () => null,
      probeEndpoint: () => "dead",
      cliVersion: () => "1.2.3",
      ...ioOwnership(),
      observeManagers: () => {
        managerProbes++;
        throw new Error("manager version probe must not run without a live runtime");
      },
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines[0]!) as {
      liveness: { status: string }; port: { effective: number };
      takeover: { kind: string; reason: string };
    };
    expect(parsed.liveness.status).toBe("absent-proven");
    expect(parsed.port.effective).toBe(RESOLVE_DEFAULT_PORT);
    expect(parsed.takeover).toMatchObject({ kind: "blocked", reason: "runtime-absent" });
    expect(managerProbes).toBe(0);
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
      ...ioOwnership(),
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
        ...ioOwnership(),
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
      ...ioOwnership(),
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
      ...ioOwnership(),
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
      ...ioOwnership(),
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
      ...ioOwnership(),
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
      ...ioOwnership(),
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Config home: /home/fixture/.opencodex");
    expect(lines[1]).toContain("Proxy live on port 10110 (PID 4242, 9.9.9)");
    expect(lines[2]).toBe("Owner: none recorded");
    expect(lines[3]).toBe("Takeover: blocked (managing-cli-unobserved: no managing OpenCodex CLI installation was observed)");
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
      ...ioOwnership(),
      stdout: { log: value => lines.push(value) },
    });
    expect(code).toBe(0);
    expect(lines[1]).toBe(`No live proxy (absence proven); effective port ${RESOLVE_DEFAULT_PORT} (configured).`);
  });
});

describe("resolve ownership and takeover fields", () => {
  async function resolveWith(io: Parameters<typeof runResolve>[1]) {
    const lines: string[] = [];
    const code = await runResolve({ json: true }, {
      configDir: () => "/h",
      readDiagnostics: () => ({ config: {}, source: "default", error: null } as ConfigDiagnostics),
      findLive: async () => fakeLive(),
      cliVersion: () => "1.2.3",
      stdout: { log: value => lines.push(value) },
      stderr: { error: () => {} },
      ...io,
    });
    return { code, json: JSON.parse(lines[0]!) as { ownership: unknown; takeover: { kind: string; reason?: string } } };
  }

  test("no recorded claim lands as kind none and never blocks the verdict", async () => {
    const { code, json } = await resolveWith(ioOwnership());
    expect(code).toBe(0);
    expect(json.ownership).toEqual(OWNERSHIP_NONE);
    expect(json.takeover.kind).toBe("blocked");
    expect(json.takeover.reason).toBe("managing-cli-unobserved");
  });

  test("a recorded claim is carried through with its revision", async () => {
    const { code, json } = await resolveWith({
      ...ioOwnership(OWNERSHIP_OWNED),
      resolveState: () => ({ kind: "state", state: { ownershipProtocolVersion: 1 } as never, revision: 7, needsRepair: false }),
      observeManagers: () => ({
        "service-registration": { status: "observed", version: "2.61.0", identity: "registered" },
        path: { status: "observed", version: "2.61.0", identity: "path" },
      }),
    });
    expect(code).toBe(0);
    expect(json.ownership).toEqual(OWNERSHIP_OWNED);
    expect(json.takeover).toMatchObject({ kind: "supported", protocolVersion: 1 });
  });

  test("an unreadable claim is unknown on the wire and blocks takeover without failing resolve", async () => {
    const { code, json } = await resolveWith(ioOwnership(OWNERSHIP_UNKNOWN));
    expect(code).toBe(0);
    expect(json.ownership).toEqual(OWNERSHIP_UNKNOWN);
    expect(json.takeover).toMatchObject({
      kind: "blocked",
      reason: "ownership-unknown",
      detail: "a service state path could not be read",
    });
  });

  test("a below-floor managing CLI blocks takeover with the real version", async () => {
    const { code, json } = await resolveWith({
      ...ioOwnership(),
      observeManagers: () => ({
        "service-registration": { status: "absent" },
        path: { status: "observed", version: "2.59.0", identity: "path" },
      }),
    });
    expect(code).toBe(0);
    expect(json.takeover).toMatchObject({ kind: "blocked", reason: "managing-cli-unsupported" });
  });

  test("both managers at or above the floor answer supported with a token", async () => {
    const { json } = await resolveWith({
      ...ioOwnership(),
      // An observed registration must be backed by an ownership-aware install state.
      resolveState: () => ({ kind: "state", state: { ownershipProtocolVersion: 1 } as never, revision: 0, needsRepair: false }),
      observeManagers: () => ({
        "service-registration": { status: "observed", version: "2.62.0", identity: "registered" },
        path: { status: "observed", version: "2.61.0", identity: "path" },
      }),
    });
    expect(json.takeover).toMatchObject({ kind: "supported", protocolVersion: 1, minimumCliVersion: "2.61.0" });
    expect(typeof (json.takeover as { token?: unknown }).token).toBe("string");
  });

  test("a throwing observation is managing-cli-unknown, not an exception", async () => {
    const { code, json } = await resolveWith({
      ...ioOwnership(),
      observeManagers: () => { throw new Error("probe blew up"); },
    });
    expect(code).toBe(0);
    expect(json.takeover).toMatchObject({ kind: "blocked", reason: "managing-cli-unknown", detail: "probe blew up" });
  });
});
