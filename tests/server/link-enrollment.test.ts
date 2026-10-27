import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import type { LinkStore } from "../../src/link/store";
import { SshRunnerError, type SshRunner, type SshRunResult } from "../../src/link/ssh-runner";
import { quoteRemote, remoteOcxArgv, WINDOWS_OS_PROBE } from "../../src/link/ssh-argv";
import { windowsScriptData } from "../../src/link/remote-windows";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-enrollment-test-"));
  process.env.OPENCODEX_HOME = root;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

const fingerprint = "SHA256:abcdefghijklmnop";
const recovery = "Run ocx disconnect and ocx restart on the Child before retrying.";
const result = (stdout = "", code = 0): SshRunResult => ({ code, stdout, stderr: "" });
const http = (body: unknown, status = 200) => result(`${JSON.stringify(body)}\n${status}`);
const health = (role: string, restartCapability: string | null = "v1") => http({ service: "opencodex", pid: 4321, port: 10100, role, ...(restartCapability === null ? {} : { restartCapability }) });
type RunOptions = Parameters<SshRunner["run"]>[1];
type Step = "probe" | "uname" | "windows" | "fingerprint" | "version" | "port" | "config" | "curl" | "before" | "connect" | "restart" | "health" | "catalog";
interface Call { step: Step; argv: readonly string[]; options: RunOptions; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness(remotePlatform: "posix" | "windows" = "posix") {
  const remoteOcx = (args: string[]) => quoteRemote(remoteOcxArgv(args, remotePlatform));
  const config: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "mock", providers: {}, apiKeys: [] };
  const knownHosts = join(root, "known_hosts");
  let store: LinkStore = { version: 1, listenerPort: 18181, links: [] };
  let clock = 1_800_000_000_000;
  let issued = 0;
  let restarted = false;
  let input: Uint8Array | undefined;
  let enrollmentId = "";
  let unsubscribed = 0;
  const callbacks = new Set<(id: string) => void>();
  const admissions: Array<{ phase: "enrollment" | "catalog"; id: string }> = [];
  const events: string[] = [];
  const calls: Call[] = [];
  const overrides: Partial<Record<Step, (call: Call) => SshRunResult | Promise<SshRunResult>>> = {};
  const emit = (phase: "enrollment" | "catalog", id = enrollmentId) => {
    admissions.push({ phase, id });
    for (const callback of callbacks) callback(id);
  };
  const state: LinkRouteState = {
    pendingHosts: new Map(), confirmedHosts: new Map(), operations: new Set(),
    listener: {
      ensureStarted: async () => { events.push("listener"); },
      status: () => ({ state: "listening", port: 18181, reason: null }),
      close: async () => { events.push("close"); },
      onAuthenticatedCatalog: callback => {
        events.push("subscribe"); callbacks.add(callback);
        return () => { callbacks.delete(callback); unsubscribed++; events.push("unsubscribe"); };
      },
    },
    supervisor: {
      start() {}, ensureStarted: async () => { events.push("supervisor"); },
      reload: async () => { events.push("reload"); },
      stopLink: async id => { events.push(`stop:${id}`); },
      reconnect: async () => { throw new Error("Enrollment must not reconnect an existing link"); },
      status: () => [], stop: async () => {},
    },
  };
  const runner: SshRunner = {
    async run(argv, options) {
      const command = argv.at(-1) ?? "";
      const decoded = command.startsWith("powershell.exe ") ? Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le") : command;
      // Decoded with the builder's own reader, so the fixture follows the emitted format.
      const nativeArgs = command.startsWith("powershell.exe ") ? windowsScriptData(decoded)?.args : undefined;
      const step: Step = argv[0] === "ssh-keygen" ? "fingerprint"
        : command === "echo ocx-link-probe" ? "probe"
        : command === WINDOWS_OS_PROBE ? "windows"
        : command.includes("ocx-platform") ? "uname"
        : command === remoteOcx(["--version"]) ? "version"
        : command === remoteOcx(["link", "port"]) ? "port"
        : command === remoteOcx(["config", "show", "--json"]) ? "config"
        : command.includes("ocx-curl-preflight") ? "curl"
        : (nativeArgs?.[0] === "connect" || command.includes("'connect' '--link' '--key-stdin'")) ? "connect"
        : command === remoteOcx(["restart"]) ? "restart"
        : (decoded.includes("http://127.0.0.1:10100/healthz") || command.includes("'ocx-child-http' '10100' 'healthz'")) ? (restarted ? "health" : "before")
        : (decoded.includes("http://127.0.0.1:10100/v1/catalog") || command.includes("'ocx-child-http' '10100' 'v1/catalog'")) ? "catalog"
        : (() => { throw new Error(`Unexpected SSH command: ${command}`); })();
      const call = { step, argv, options };
      calls.push(call); events.push(step);
      if (step === "restart") restarted = true;
      if (step === "connect") {
        if (!(options?.stdin instanceof Uint8Array)) throw new Error("connect must use byte stdin");
        input = options.stdin;
        const body = JSON.parse(new TextDecoder().decode(input));
        expect(body.key).toBe("fixture-child-key");
        enrollmentId = body.apiKeyId;
        // Enrollment itself hits Home's catalog; this is deliberately before the fresh watcher.
        emit("enrollment");
      }
      if (overrides[step]) return overrides[step]!(call);
      switch (step) {
        case "probe": {
          const path = candidateFile(argv);
          writeFileSync(path, `${aliasOf(argv)} ssh-ed25519 AAAA\n`);
          return result("ocx-link-probe\n");
        }
        case "uname": return result("Linux\n");
        case "windows": return remotePlatform === "windows" ? result("Windows_NT\r\n") : { code: 127, stdout: "", stderr: "sh: cmd: not found" };
        case "fingerprint": return result(`256 ${fingerprint} child (ED25519)`);
        case "version": return result("opencodex 2.83.0\n");
        case "port": return result('{"port":2200}');
        case "config": return result('{"port":10100}\n');
        case "curl": case "connect": return result();
        case "before": return health("standalone");
        case "restart": return result();
        case "health": return health("client");
        case "catalog": emit("catalog"); return http({ models: [{ id: "fixture-model" }] });
      }
    },
    spawnTunnel() { throw new Error("The route must use its supplied supervisor"); },
  };
  const deps: ManagementContext["deps"] = {
    now: () => clock, sshRunner: runner,
    readLinkStore: () => store,
    writeLinkStore: next => { store = next; events.push("store"); },
    linkKnownHostsPath: () => knownHosts, liveListenPort: () => 10100,
    issueApiKey: (cfg, name) => {
      const key = { id: `fixture-key-${++issued}`, name, key: "fixture-child-key", createdAt: "2026-10-11T00:00:00Z" };
      cfg.apiKeys = [...(cfg.apiKeys ?? []), key]; events.push("issue"); return key;
    },
    revokeApiKey: (cfg, id) => {
      events.push(`revoke:${id}`);
      cfg.apiKeys = (cfg.apiKeys ?? []).filter(key => key.id !== id); return true;
    },
  };
  async function call(route: "probe" | "confirm-host" | "apply" | "join", body: unknown, overrides: Partial<ManagementContext> = {}) {
    const url = new URL(`http://127.0.0.1:10100/api/link/${route}`);
    const context: ManagementContext = {
      req: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, config, deps, version: "2.84.0", principal: "admin-token", trustedLoopbackIngress: true,
      guiSessionIssuance: null,
      sessionControl: { isCurrent: () => true, isPaired: () => false, revokeCurrent: () => true },
      convergeCodexCatalog: async () => { throw new Error("No catalog convergence in a route fixture"); },
      syncClaudeAgentDefsBestEffort: async () => {}, ...overrides,
    };
    const response = await handleLinkRoutes(context, state);
    if (!response) throw new Error("Route did not handle request");
    return response;
  }
  function seed(alias = "child", latency = 0) {
    const pending = { alias, fingerprint, keyType: "ED25519", knownHostLine: `${alias} ssh-ed25519 AAAA`, probedAt: clock, sshLatencyMs: latency, remotePlatform };
    state.pendingHosts.set(alias, pending); return pending;
  }
  function confirmed(alias = "child", latency = 0) {
    state.confirmedHosts!.set(alias, { ...seed(alias, latency), ocxVersion: "2.83.0" });
    state.pendingHosts.delete(alias);
  }
  return { config, deps, state, knownHosts, events, calls, callbacks, admissions, overrides, emit, call, seed, confirmed,
    advance: (ms: number) => { clock += ms; }, get store() { return store; }, get input() { return input; },
    get enrollmentId() { return enrollmentId; }, get unsubscribed() { return unsubscribed; },
  };
}
function candidateFile(argv: readonly string[]): string {
  const value = argv.find(arg => arg.startsWith("UserKnownHostsFile="));
  if (!value) throw new Error("Missing private host key file");
  return value.slice("UserKnownHostsFile=".length).replace(/^"|"$/g, "");
}
function aliasOf(argv: readonly string[]): string { return argv[argv.indexOf("--") + 1]!; }
async function denied(response: Response, code: string, status = 502) {
  expect(response.status).toBe(status);
  const payload = await response.json();
  expect(payload).toMatchObject({ error: { code } }); return payload;
}
function cleanFailure(h: ReturnType<typeof harness>, subscribed = true) {
  expect(h.config.apiKeys).toEqual([]); expect(h.store.links).toEqual([]);
  expect(h.events).toContain(`revoke:${h.enrollmentId}`);
  expect(h.events.some(event => event.startsWith("stop:lnk_"))).toBe(true);
  expect(h.events).toContain("close"); expect(h.callbacks.size).toBe(0);
  expect(h.unsubscribed).toBe(subscribed ? 1 : 0);
  expect(h.input).toBeInstanceOf(Uint8Array);
  expect(h.input!.every(byte => byte === 0)).toBe(true);
  for (const call of h.calls) expect(call.argv.join(" ")).not.toContain("fixture-child-key");
}
function noEnrollmentEffects(h: ReturnType<typeof harness>) {
  expect(h.config.apiKeys).toEqual([]); expect(h.store.links).toEqual([]);
  expect(h.events.some(event => ["issue", "store", "listener", "supervisor", "reload", "connect", "restart"].includes(event))).toBe(false);
  expect(h.input).toBeUndefined(); expect(h.callbacks.size).toBe(0);
}

describe("Home enrollment of a standalone Child", () => {
  test("2.83 Child connects, restarts exactly once and needs a fresh complete catalog before success", async () => {
    const h = harness();
    const probed = await h.call("probe", { alias: "child" });
    expect(probed.status).toBe(200);
    expect(await probed.json()).toEqual({ alias: "child", fingerprint, keyType: "ED25519" });
    const confirmation = await h.call("confirm-host", { alias: "child", fingerprint });
    expect(await confirmation.json()).toMatchObject({ ocxVersion: "2.83.0" });
    const catalogStarted = deferred<void>(), completeCatalog = deferred<SshRunResult>();
    h.overrides.catalog = () => { h.emit("catalog"); catalogStarted.resolve(); return completeCatalog.promise; };
    let settled = false;
    const applying = h.call("apply", { alias: "child", fingerprint }).then(response => { settled = true; return response; });
    await catalogStarted.promise;
    try {
      expect(settled).toBe(false); expect(h.callbacks.size).toBe(1);
      expect(h.calls.map(call => call.step)).toEqual(["probe", "fingerprint", "windows", "uname", "version", "port", "config", "curl", "before", "connect", "restart", "health", "catalog"]);
      expect(h.admissions).toEqual([{ phase: "enrollment", id: h.enrollmentId }, { phase: "catalog", id: h.enrollmentId }]);
    } finally { completeCatalog.resolve(http({ models: [] })); }
    const response = await applying;
    expect(response.status).toBe(202);
    const payload = await response.json();
    expect(payload).toEqual({ linkId: h.store.links[0]!.id });
    expect(h.config.apiKeys).toHaveLength(1); expect(h.store.links).toHaveLength(1);
    expect(h.callbacks.size).toBe(0); expect(h.unsubscribed).toBe(1);
    expect(h.events.filter(event => event === "restart")).toHaveLength(1);
    expect(h.input!.every(byte => byte === 0)).toBe(true);
    const catalog = h.calls.find(call => call.step === "catalog")!;
    expect(catalog.options?.maxOutputBytes).toBe(4 * 1024 * 1024);
    expect(catalog.argv.at(-1)).toContain('curl -q --noproxy');
    expect(catalog.argv.at(-1)).not.toMatch(/--location|--user|[Bb]earer|fixture-child-key/);
    expect(h.events).not.toContain(`revoke:${h.enrollmentId}`);
    expect(h.state.operations?.size).toBe(0);
    for (const call of h.calls.filter(call => call.argv[0] === "ssh")) expect(existsSync(candidateFile(call.argv))).toBe(false);
  });

  const catalogFailures: Array<{ name: string; stdout: string; code?: number; admission?: "none" | "other" }> = [
    { name: "enrollment admission alone", stdout: '{"models":[]}\n200', admission: "none" },
    { name: "admission by the wrong key", stdout: '{"models":[]}\n200', admission: "other" },
    { name: "malformed JSON", stdout: '{"models":\n200' },
    { name: "incomplete catalog shape", stdout: '{}\n200' },
    { name: "HTTP 500", stdout: '{"models":[]}\n500' },
    { name: "HTTP redirect", stdout: '{"models":[]}\n302' },
    { name: "nonzero curl with a complete body", stdout: '{"models":[]}\n200', code: 22 },
  ];
  for (const failure of catalogFailures) test(`refuses ${failure.name} and releases the catalog watcher`, async () => {
    const h = harness(); h.confirmed();
    h.overrides.catalog = () => {
      if (failure.admission !== "none") h.emit("catalog", failure.admission === "other" ? "unrelated-key" : h.enrollmentId);
      return result(failure.stdout, failure.code ?? 0);
    };
    const payload = await denied(await h.call("apply", { alias: "child" }), "child_relay_failed");
    expect(payload).toMatchObject({ residual: true, recovery }); cleanFailure(h);
  });

  test("wrong post-restart runtime role is refused before the fresh catalog probe", async () => {
    const h = harness(); h.confirmed(); h.overrides.health = () => health("standalone");
    expect(await denied(await h.call("apply", { alias: "child" }), "child_runtime_not_client")).toMatchObject({ residual: true, recovery });
    expect(h.calls.some(call => call.step === "catalog")).toBe(false); cleanFailure(h, false);
  });

  test("post-restart health from another port cannot prove the configured Child runtime", async () => {
    const h = harness(); h.confirmed();
    h.overrides.health = () => http({ service: "opencodex", pid: 4321, port: 10101, role: "client" });
    await denied(await h.call("apply", { alias: "child" }), "child_runtime_not_client");
    expect(h.calls.some(call => call.step === "catalog")).toBe(false); cleanFailure(h, false);
  });

  for (const [name, error, code] of [
    ["failed restart", result("", 1), "child_restart_failed"],
    ["restart exception", new Error("restart failed"), "child_restart_failed"],
    ["restart SSH timeout", new SshRunnerError("timeout", "restart deadline"), "child_restart_timeout"],
    ["connect SSH timeout", new SshRunnerError("timeout", "connect deadline"), "remote_connect_timeout"],
  ] as const) test(`${name} revokes the new key, wipes stdin and exposes fixed Child recovery`, async () => {
    const h = harness(); h.confirmed();
    h.overrides[name.startsWith("connect") ? "connect" : "restart"] = () => { if (error instanceof Error) throw error; return error; };
    expect(await denied(await h.call("apply", { alias: "child" }), code)).toMatchObject({ residual: true, recovery });
    cleanFailure(h, false);
    expect(h.calls.some(call => call.step === "health" || call.step === "catalog")).toBe(false);
    expect(h.state.operations?.size).toBe(0);
  });

  for (const [name, step, output, code, status] of [
    ["effective Hub configuration", "config", result('{"port":10100,"runtimeRole":"hub"}'), "child_restart_unsupported", 409],
    ["explicit Hub health", "before", health("hub"), "child_restart_unsupported", 409],
    ["effective client configuration", "config", result('{"port":10100,"runtimeRole":"client"}'), "child_restart_unsupported", 409],
    ["missing restart capability", "before", health("standalone", null), "child_restart_unsupported", 409],
    ["health on a different configured port", "before", http({ service: "opencodex", pid: 4321, port: 10101, role: "standalone", restartCapability: "v1" }), "child_restart_unsupported", 409],
    ["missing curl", "curl", result("", 127), "child_curl_missing", 409],
    ["invalid configured port", "config", result("65536\n"), "child_preflight_failed", 502],
  ] as const) test(`${name} refuses enrollment before any key or lifecycle effects`, async () => {
    const h = harness(); h.confirmed(); h.overrides[step] = () => output;
    const payload = await denied(await h.call("apply", { alias: "child" }), code, status);
    expect(payload.residual).toBeUndefined(); noEnrollmentEffects(h);
    expect(h.state.confirmedHosts?.has("child")).toBe(true);
  });

  test("measured 3400ms SSH latency allows 28600ms commands and separate restart/relay budgets", async () => {
    const h = harness();
    h.overrides.probe = call => {
      h.advance(3400); writeFileSync(candidateFile(call.argv), "child ssh-ed25519 AAAA\n"); return result("ocx-link-probe\n");
    };
    expect((await h.call("probe", { alias: "child" })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: "child", fingerprint })).status).toBe(200);
    h.overrides.restart = () => { h.advance(150_000); return result(); };
    expect((await h.call("apply", { alias: "child" })).status).toBe(202);
    const timeouts = new Map(h.calls.map(call => [call.step, call.options?.timeoutMs]));
    for (const step of ["port", "config", "curl", "connect"] as const) expect(timeouts.get(step)).toBe(28_600);
    expect(timeouts.get("restart")).toBe(158_600);
    expect(h.calls.at(-2)?.options?.timeoutMs).toBe(15_000);
    expect(timeouts.get("catalog")).toBe(15_000);
  });

  test("huge measured latency caps ordinary work at 60s and restart at 190s", async () => {
    const h = harness(); h.confirmed("child", Number.MAX_VALUE);
    expect((await h.call("apply", { alias: "child" })).status).toBe(202);
    expect(h.calls.find(call => call.step === "connect")?.options?.timeoutMs).toBe(60_000);
    expect(h.calls.find(call => call.step === "restart")?.options?.timeoutMs).toBe(190_000);
    expect(h.calls.find(call => call.step === "catalog")?.options?.timeoutMs).toBe(15_000);
  });

  test("health and catalog share a fresh relay deadline after restart", async () => {
    const h = harness(); h.confirmed();
    h.overrides.health = () => { h.advance(4000); return health("client"); };
    h.overrides.catalog = () => { h.emit("catalog"); h.advance(11_001); return http({ models: [] }); };
    expect(await denied(await h.call("apply", { alias: "child" }), "child_relay_failed")).toMatchObject({ residual: true, recovery });
    expect(h.calls.find(call => call.step === "health")?.options?.timeoutMs).toBe(15_000);
    expect(h.calls.find(call => call.step === "catalog")?.options?.timeoutMs).toBe(11_000);
    cleanFailure(h);
  });

  test("catalog SSH timeout releases its watcher and compensates", async () => {
    const h = harness(); h.confirmed();
    h.overrides.catalog = () => { h.emit("catalog"); throw new SshRunnerError("timeout", "catalog deadline"); };
    expect(await denied(await h.call("apply", { alias: "child" }), "child_relay_timeout")).toMatchObject({ residual: true, recovery });
    cleanFailure(h);
  });
});

describe("server-owned confirmation and authority", () => {
  test("optional version probe remains read-only and inserts pending trust only after the pinned version completes", async () => {
    const h = harness();
    const started = deferred<void>(), version = deferred<SshRunResult>();
    let candidate = "";
    h.overrides.version = call => {
      candidate = candidateFile(call.argv);
      expect(readFileSync(candidate, "utf8")).toBe("child ssh-ed25519 AAAA\n");
      expect(call.argv).toContain("StrictHostKeyChecking=yes");
      started.resolve(); return version.promise;
    };
    const probing = h.call("probe", { alias: "child", includeVersion: true });
    await started.promise;
    try {
      expect(h.state.pendingHosts.size).toBe(0); expect(existsSync(h.knownHosts)).toBe(false);
      noEnrollmentEffects(h);
    } finally { version.resolve(result("opencodex 2.83.0\n")); }
    const response = await probing;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alias: "child", fingerprint, keyType: "ED25519", ocxVersion: "2.83.0" });
    expect(h.state.pendingHosts.has("child")).toBe(true);
    expect(h.state.confirmedHosts?.size).toBe(0); expect(existsSync(candidate)).toBe(false);
    expect(existsSync(h.knownHosts)).toBe(false); noEnrollmentEffects(h);
  });

  test("failed optional version probe cannot publish a pending host", async () => {
    const h = harness(); h.overrides.version = () => result("opencodex 2.83.0\n", 125);
    await denied(await h.call("probe", { alias: "child", includeVersion: true }), "version_probe_failed");
    expect(h.state.pendingHosts.size).toBe(0); noEnrollmentEffects(h);
  });

  test("an unknown remote platform issues no key and creates no link", async () => {
    const h = harness(); h.overrides.uname = () => result("?");
    await denied(await h.call("probe", { alias: "child" }), "probe_failed");
    expect(h.state.pendingHosts.size).toBe(0); noEnrollmentEffects(h);
  });

  test("a failed cross-shell echo refuses before platform discovery and key issuance", async () => {
    const h = harness(); h.overrides.probe = () => result("", 255);
    await denied(await h.call("probe", { alias: "child" }), "probe_failed");
    expect(h.calls.map(call => call.step)).toEqual(["probe"]); noEnrollmentEffects(h);
  });

  test("Windows enrollment restarts the Child and requires a fresh authenticated Home catalog", async () => {
    const h = harness("windows");
    expect((await h.call("probe", { alias: "child" })).status).toBe(200);
    expect((await h.call("confirm-host", { alias: "child", fingerprint })).status).toBe(200);
    expect((await h.call("apply", { alias: "child", fingerprint })).status).toBe(202);
    expect(h.store.links[0]?.remotePlatform).toBe("windows");
    expect(h.calls.some(call => call.step === "curl")).toBe(false);
    expect(h.admissions.map(admission => admission.phase)).toEqual(["enrollment", "catalog"]);
    expect(h.input!.every(byte => byte === 0)).toBe(true);
    for (const call of h.calls) expect(call.argv.join(" ")).not.toContain("fixture-child-key");
  });

  test("Windows restart failure compensates the key and exposes residual recovery", async () => {
    const h = harness("windows"); h.confirmed(); h.overrides.restart = () => result("", 1);
    expect(await denied(await h.call("apply", { alias: "child" }), "child_restart_failed")).toMatchObject({ residual: true, recovery });
    cleanFailure(h, false);
  });

  test("fingerprint mismatch refuses both confirmation and apply without SSH", async () => {
    const h = harness(); h.seed();
    await denied(await h.call("confirm-host", { alias: "child", fingerprint: "SHA256:other" }), "host_fingerprint_mismatch", 409);
    h.confirmed();
    await denied(await h.call("apply", { alias: "child", fingerprint: "SHA256:other" }), "host_fingerprint_mismatch", 409);
    expect(h.calls).toEqual([]); noEnrollmentEffects(h);
  });

  test("unpaired trusted loopback admin needs no TTY for confirmed Home enrollment", async () => {
    const h = harness(); h.seed();
    expect((await h.call("confirm-host", { alias: "child", fingerprint })).status).toBe(200);
    expect((await h.call("apply", { alias: "child" })).status).toBe(202);
    for (const call of h.calls) {
      expect(call.argv).toContain("-T"); expect(call.argv).toContain("BatchMode=yes");
      expect(call.argv).not.toContain("-t"); expect(call.argv).not.toContain("-tt");
    }
  });

  for (const [name, context, code] of [
    ["remote admin", { trustedLoopbackIngress: false }, "forbidden"],
    ["Tailscale session", { principal: "gui-session", guiSessionIssuance: "tailscale-identity" }, "tailscale_session_refused"],
  ] as const) test(`${name} cannot probe, confirm or enroll by forging request headers`, async () => {
    const h = harness(); h.seed(); h.confirmed();
    for (const route of ["probe", "confirm-host", "apply"] as const) {
      const url = new URL(`http://127.0.0.1/api/link/${route}`);
      const req = new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-opencodex-trusted-loopback": "true" }, body: JSON.stringify({ alias: "child", fingerprint }) });
      await denied(await h.call(route, { alias: "child", fingerprint }, { ...context, req }), code, 403);
    }
    expect(h.calls).toEqual([]); noEnrollmentEffects(h);
  });

  test("join retains its paired-session and live configured-port gates", async () => {
    const h = harness(); h.confirmed();
    const joins: string[] = [];
    const deps = { ...h.deps, joinHome: async (_deps: unknown, options: { alias: string }) => { joins.push(options.alias); return { linkId: "lnk_0123456789abcdef", apiKeyId: "joined-key" }; } };
    const gui: Partial<ManagementContext> = { principal: "gui-session", guiSessionIssuance: "loopback", deps };
    await denied(await h.call("join", { alias: "child" }, gui), "forbidden", 403);
    const paired = { ...gui, guiSessionIssuance: "pairing" as const, sessionControl: { isCurrent: () => true, isPaired: () => true, revokeCurrent: () => true } };
    await denied(await h.call("join", { alias: "child" }, { ...paired, deps: { ...deps, liveListenPort: () => 10101 } }), "join_port_mismatch", 409);
    expect(joins).toEqual([]);
    const response = await h.call("join", { alias: "child" }, paired);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ linkId: "lnk_0123456789abcdef", alias: "child", restarting: true });
    expect(joins).toEqual(["child"]); expect(h.calls).toEqual([]); noEnrollmentEffects(h);
  });

  test("different-alias confirmations use private candidate files and preserve sibling committed trust", async () => {
    const h = harness(); h.seed("first"); h.seed("second");
    writeFileSync(h.knownHosts, "existing ssh-ed25519 EXISTING\n");
    const started = deferred<{ error?: unknown }>(), pending = deferred<SshRunResult>();
    let fixtureFailure: { error: unknown } | undefined;
    const candidates: string[] = [];
    h.overrides.version = call => {
      try {
        const candidate = candidateFile(call.argv); candidates.push(candidate);
        expect(candidate).not.toBe(h.knownHosts);
        expect(existsSync(candidate)).toBe(true);
        if (process.platform !== "win32") expect(statSync(candidate).mode & 0o777).toBe(0o600);
        expect(readFileSync(candidate, "utf8")).toBe(`${aliasOf(call.argv)} ssh-ed25519 AAAA\n`);
        if (aliasOf(call.argv) === "first") { started.resolve({}); return pending.promise; }
        return result("opencodex 2.83.0\n");
      } catch (error) {
        fixtureFailure = { error }; started.resolve(fixtureFailure); throw error;
      }
    };
    const first = h.call("confirm-host", { alias: "first", fingerprint });
    try {
      const signal = await Promise.race([started.promise, first.then(response => {
        throw new Error(`First confirmation completed before the fixture started: ${response.status}`);
      })]);
      if ("error" in signal) throw signal.error;
      const second = await h.call("confirm-host", { alias: "second", fingerprint });
      if (fixtureFailure) throw fixtureFailure.error;
      expect(second.status).toBe(200);
      expect(readFileSync(h.knownHosts, "utf8")).toBe("existing ssh-ed25519 EXISTING\nsecond ssh-ed25519 AAAA\n");
    } finally { pending.resolve(result("opencodex 2.65.0\n")); await first; }
    await denied(await first, "remote_ocx_outdated", 409);
    expect(readFileSync(h.knownHosts, "utf8")).toBe("existing ssh-ed25519 EXISTING\nsecond ssh-ed25519 AAAA\n");
    expect(new Set(candidates).size).toBe(2);
    for (const candidate of candidates) expect(existsSync(candidate)).toBe(false);
    expect(h.state.confirmedHosts?.has("second")).toBe(true);
    expect(h.state.confirmedHosts?.has("first")).toBe(false);
  });

  test("same-alias overlapping confirmation/apply is busy and an expired in-flight probe cannot commit", async () => {
    const h = harness(); h.seed();
    const started = deferred<void>(), pending = deferred<SshRunResult>();
    h.overrides.version = () => { started.resolve(); return pending.promise; };
    const first = h.call("confirm-host", { alias: "child", fingerprint });
    await started.promise;
    try {
      await denied(await h.call("confirm-host", { alias: "child", fingerprint }), "link_operation_in_progress", 409);
      await denied(await h.call("apply", { alias: "child" }), "link_operation_in_progress", 409);
      expect(h.calls).toHaveLength(1); h.advance(300_001);
    } finally { pending.resolve(result("opencodex 2.83.0\n")); }
    await denied(await first, "host_confirmation_expired", 409);
    expect(h.state.operations?.size).toBe(0); expect(existsSync(h.knownHosts)).toBe(false);
    await denied(await h.call("confirm-host", { alias: "child", fingerprint }), "host_confirmation_expired", 409);
    h.confirmed(); h.advance(300_001);
    await denied(await h.call("apply", { alias: "child" }), "host_confirmation_expired", 409);
    expect(h.calls).toHaveLength(1); noEnrollmentEffects(h);
  });
});
