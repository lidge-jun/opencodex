import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkSupervisor, type LinkSupervisor, type Pidfile } from "../../src/link/supervisor";
import { createRouteProofRegistry, type RouteProofRegistry } from "../../src/link/route-proof";
import { SshRunnerError, type SshChild, type SshRunner, type SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord, LinkStore } from "../../src/link/store";
import { READY_PROOF_MS, ROUTE_PROBE_MS } from "../../src/link/route-rounds";
import { HOME_TUNNEL_RETRY_POLICY } from "../../src/link/tunnel-state";

const LINK = "lnk_0123456789abcdef";
const TUNNEL_PORT = 19002;
const LISTENER_PORT = 19001;
const CHILD_PORT = 4100;
const GRANT = "debug1: remote forward success for: listen 127.0.0.1:" + TUNNEL_PORT + ", connect 127.0.0.1:" + LISTENER_PORT;
const REFUSED = "debug1: remote forward failure for: listen 127.0.0.1:" + TUNNEL_PORT + ", connect 127.0.0.1:" + LISTENER_PORT;

function record(routes?: string[], id = LINK, tunnelPort = TUNNEL_PORT): LinkRecord {
  return {
    id, alias: "pen-alpha", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort, apiKeyId: "link-key", createdAt: "2026-11-01T00:00:00.000Z", remotePlatform: "posix",
    ...(routes ? { routes } : {}),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
}

type Answer = SshRunResult | "hang" | Promise<SshRunResult>;
const ok = (stdout = ""): SshRunResult => ({ code: 0, stdout, stderr: "" });
const refused = (stderr: string): SshRunResult => ({ code: 255, stdout: "", stderr });

interface Tunnel { argv: string[]; tap: (line: string) => boolean; signals: string[]; exit: (code: number, stderr?: string) => void; child: SshChild }
interface Run { argv: readonly string[]; signal?: AbortSignal; kind: string; destination: string | undefined; proofId?: string }

/** Answers every ssh call the route rounds make; tests script the answers per call kind and route. */
function harness(options: {
  routes?: string[];
  client?: Answer | (() => Answer);
  probe?: (route: string, attempt: number) => Answer;
  catalog?: (route: string, proofId: string, admit: () => void) => Answer;
  health?: Answer;
  pidfile?: Pidfile | null | (() => Pidfile | null);
  processArgv?: (pid: number) => readonly string[] | null;
  processStart?: (pid: number) => number | null;
  store?: () => LinkStore;
  /** Tunnels ignore signals (an exit that never arrives). */
  stubborn?: boolean;
  /** Signalling the tunnel with this index throws. */
  killFails?: (index: number) => boolean;
  processAlive?: (pid: number) => boolean | null;
  writePidfile?: (path: string, pidfile: Pidfile) => void;
  /** Hold every tunnel's stderr until released (an exit still being classified). */
  holdStderr?: { release?: () => void };
  /** The Child's `ocx config show --json` stdout. */
  configStdout?: string;
  /** spawnTunnel throws while this returns true (ssh missing). */
  spawnFails?: () => boolean;
  /** Read pidfiles from this directory with the supervisor's own reader instead of `pidfile`. */
  pidfileDir?: string;
  /** Pidfile removal fails (a read-only directory, say). */
  removeFails?: () => boolean;
} = {}) {
  let now = 0;
  let tick: () => void = () => {};
  const timer = { cleared: 0 };
  const runs: Run[] = [];
  const tunnels: Tunnel[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const removed: string[] = [];
  const warns: string[] = [];
  const probes = new Map<string, number>();
  let supervisor!: LinkSupervisor;
  const proofs: RouteProofRegistry = createRouteProofRegistry({ now: () => now, generationOf: id => supervisor.connectionGeneration?.(id) });
  const destinationOf = (argv: readonly string[]) => { const index = argv.indexOf("--"); return index === -1 ? undefined : argv[index + 1]; };
  const runner: SshRunner = {
    run(argv, runOptions) {
      const remote = argv.at(-1) ?? "";
      const kind = argv[1] === "-V" ? "client" : remote === "echo ocx-link-probe" ? "probe"
        : remote.includes("config") && remote.includes("show") ? "config"
        : remote.includes("healthz") ? "health" : remote.includes("v1/catalog") ? "catalog" : "other";
      const proofId = kind === "catalog" ? /[0-9a-f]{32}/.exec(remote)?.[0] : undefined;
      const entry: Run = { argv, kind, destination: destinationOf(argv), ...(runOptions?.signal ? { signal: runOptions.signal } : {}), ...(proofId ? { proofId } : {}) };
      runs.push(entry);
      let answer: Answer;
      if (kind === "client") answer = (typeof options.client === "function" ? options.client() : options.client) ?? { code: 0, stdout: "", stderr: "OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13" };
      else if (kind === "probe") {
        const route = entry.destination!;
        const attempt = (probes.get(route) ?? 0) + 1;
        probes.set(route, attempt);
        answer = options.probe ? options.probe(route, attempt) : ok("ocx-link-probe\n");
      } else if (kind === "config") answer = ok(options.configStdout ?? JSON.stringify({ port: CHILD_PORT, runtimeRole: "client" }));
      else if (kind === "health") answer = options.health ?? ok(JSON.stringify({ service: "opencodex", role: "client", port: CHILD_PORT, pid: 77 }) + "\n200");
      else if (kind === "catalog") {
        const admit = () => proofs.admit("link-key", proofId!);
        answer = options.catalog ? options.catalog(entry.destination!, proofId!, admit) : (admit(), ok(JSON.stringify({ models: [] }) + "\n200"));
      } else answer = remote.includes("uname") ? ok("Linux\n") : ok();
      if (answer === "hang") return new Promise<SshRunResult>(() => {});
      // The real runner refuses output past the caller's cap (or its 64 KiB default).
      if (!(answer instanceof Promise) && answer.stdout.length > (runOptions?.maxOutputBytes ?? 64 * 1024)) return Promise.reject(new SshRunnerError("output_limit", "ssh output exceeded the cap"));
      return Promise.resolve(answer);
    },
    spawnTunnel(argv, tunnelOptions) {
      if (options.spawnFails?.()) throw new Error("spawn ssh ENOENT");
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { resolveExit = resolve; });
      let stderr = "";
      const signals: string[] = [];
      const tunnel: Tunnel = {
        argv: [...argv], tap: tunnelOptions?.stderrLine ?? (() => true), signals,
        exit: (code, text = "") => { stderr = text; resolveExit(code); },
        child: undefined as unknown as SshChild,
      };
      tunnel.child = {
        pid: 500 + tunnels.length, argv: [...argv], exited,
        get stderr() {
          if (!options.holdStderr) return exited.then(() => stderr);
          const held = options.holdStderr;
          return exited.then(() => new Promise<string>(resolve => { held.release = () => resolve(stderr); }));
        },
        kill: signal => {
          if (options.killFails?.(tunnels.indexOf(tunnel))) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
          signals.push(signal ?? "SIGTERM");
          if (!options.stubborn) tunnel.exit(143);
        },
      };
      tunnels.push(tunnel);
      return tunnel.child;
    },
  };
  const store: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(options.routes ?? ["alpha-lan", "pen-alpha"])] };
  supervisor = createLinkSupervisor({
    readStore: options.store ?? (() => store),
    runner,
    now: () => now,
    random: () => 0.5,
    platform: "linux",
    ...(options.pidfileDir !== undefined ? { pidfileDir: options.pidfileDir }
      : { readPidfile: () => (typeof options.pidfile === "function" ? options.pidfile() : options.pidfile) ?? null }),
    writePidfile: options.writePidfile ?? (() => {}),
    removePidfile: path => {
      if (options.removeFails?.()) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      removed.push(path);
    },
    readProcessArgv: options.processArgv ?? (() => null),
    readProcessStartTime: options.processStart ?? (() => null),
    processAlive: options.processAlive ?? (pid => (options.processArgv?.(pid) ?? null) !== null),
    killProcess: (pid, signal) => { kills.push({ pid, signal: signal ?? "SIGTERM" }); },
    setTimer: callback => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; },
    clearTimer: () => { timer.cleared += 1; },
    sshCapture: () => null,
    routeProof: proofs,
    warn: message => { warns.push(message); },
  });
  return {
    supervisor, runs, tunnels, kills, proofs, removed, warns, timer,
    advance: async (ms: number) => { now += ms; tick(); await flush(); },
    /** Move the clock without a tick (a delayed timer). */
    skip: (ms: number) => { now += ms; },
    tick: async () => { tick(); await flush(); },
    now: () => now,
    state: () => supervisor.status()[0] as Extract<ReturnType<LinkSupervisor["status"]>[number], { direction: "hub-initiated" }>,
    grant: async (index = tunnels.length - 1) => { tunnels[index]!.tap(GRANT); await flush(); },
  };
}

type Harness = ReturnType<typeof harness>;
const live: Harness[] = [];
afterEach(async () => { for (const h of live.splice(0)) await h.supervisor.stop(); });

function start(options: Parameters<typeof harness>[0] = {}): Harness {
  const h = harness(options);
  live.push(h);
  h.supervisor.start();
  return h;
}

/** Start, answer the client check, and let the first round run until it waits on a clock or a grant. */
async function started(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = start(options);
  await flush();
  await h.tick();
  return h;
}

function option(argv: readonly string[], name: string): string | undefined {
  return argv.find((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "="))?.slice(name.length + 1);
}

test("a two-route link connects on its first route only after the correlated readiness proof", async () => {
  const h = await started();
  expect(h.runs.filter(run => run.kind === "probe").map(run => run.destination)).toEqual(["alpha-lan"]);
  expect(h.tunnels).toHaveLength(1);
  const argv = h.tunnels[0]!.argv;
  expect(argv[argv.indexOf("--") + 1]).toBe("alpha-lan");
  expect(option(argv, "HostKeyAlias")).toBe("pen-alpha");
  expect(option(argv, "StrictHostKeyChecking")).toBe("yes");
  expect(option(argv, "LogLevel")).toBe("DEBUG1");
  // Alive for a long time is not readiness: no grant, no proof, no promotion.
  await h.advance(10_000);
  expect(h.state().state.kind).toBe("connecting");
  await h.grant();
  await h.tick();
  expect(h.runs.filter(run => run.kind === "catalog").every(run => run.destination === "alpha-lan")).toBe(true);
  expect(h.state().state.kind).toBe("connected");
  expect(h.state().routes?.route).toEqual({ name: "alpha-lan", index: 0, since: 10_000 });
  expect(h.proofs.size()).toBe(0);
});

test("a refused first route falls through to the second without waiting for the clock", async () => {
  const h = await started({ probe: route => route === "alpha-lan" ? refused("ssh: connect to host 10.0.0.5 port 22: Connection refused") : ok("ocx-link-probe\n") });
  expect(h.runs.filter(run => run.kind === "probe").map(run => run.destination)).toEqual(["alpha-lan", "pen-alpha"]);
  expect(h.tunnels[0]!.argv.at(-1)).toBe("pen-alpha");
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
  expect(h.state().routes?.route?.name).toBe("pen-alpha");
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("transient");
});

test("a first route that hangs is abandoned at the probe bound and the second is tried", async () => {
  const h = await started({ probe: route => route === "alpha-lan" ? "hang" : ok("ocx-link-probe\n") });
  const hung = h.runs.find(run => run.kind === "probe" && run.destination === "alpha-lan")!;
  await h.advance(ROUTE_PROBE_MS - 1);
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  expect(h.tunnels).toHaveLength(0);
  await h.advance(1);
  expect(hung.signal?.aborted).toBe(true);
  expect(h.runs.filter(run => run.kind === "probe").map(run => run.destination)).toEqual(["alpha-lan", "pen-alpha"]);
  expect(h.tunnels[0]!.argv.at(-1)).toBe("pen-alpha");
});

test("a route offering another host key is skipped and cooled, and the link does not fail", async () => {
  const h = await started({ probe: route => route === "alpha-lan" ? refused("Host key verification failed.") : ok("ocx-link-probe\n") });
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
  expect(h.state().routes?.route?.name).toBe("pen-alpha");
  const first = h.state().routes!.routes[0]!;
  expect(first.lastOutcome?.class).toBe("hostkey");
  expect(first.eligibleAt).toBe(600_000);
  // The proven relay tunnel exits; the next round must not try the refused route before its cooldown.
  h.tunnels[0]!.exit(255, "Connection reset by peer");
  await flush();
  await h.advance(2_000);
  expect(h.runs.filter(run => run.kind === "probe" && run.destination === "alpha-lan")).toHaveLength(1);
  expect(h.tunnels).toHaveLength(2);
  expect(h.tunnels[1]!.argv.at(-1)).toBe("pen-alpha");
});

test("a candidate whose remote listener is refused is a forward failure of that route only", async () => {
  const h = await started();
  h.tunnels[0]!.tap(REFUSED);
  h.tunnels[0]!.exit(255, "Error: remote port forwarding failed for listen port 19002");
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("forward");
  expect(h.state().routes?.routes[0]?.eligibleAt).toBe(60_000);
  expect(h.tunnels[1]!.argv.at(-1)).toBe("pen-alpha");
  expect(h.state().state.kind).toBe("connecting");
});

test("a granted candidate that never proves readiness is stopped at its deadline and the next route runs", async () => {
  const h = await started({ catalog: route => route === "alpha-lan" ? refused("curl: (22) The requested URL returned error: 503") : ok(JSON.stringify({ models: [] }) + "\n200") });
  await h.grant();
  for (let elapsed = 0; elapsed < READY_PROOF_MS - 2_000; elapsed += 2_000) await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual([]);
  expect(h.runs.filter(run => run.kind === "catalog").length).toBeGreaterThan(1);
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  h.tunnels[0]!.exit(143);
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("readiness");
  expect(h.tunnels[1]!.argv.at(-1)).toBe("pen-alpha");
});

test("a grant seen after the first deadline, before the tick that would stop the candidate, keeps the candidate within 2 x READY_PROOF_MS", async () => {
  const h = await started({ catalog: () => "hang" });
  expect(h.tunnels).toHaveLength(1);
  // The grant line arrives just after spawn + READY_PROOF_MS, before the next tick saw the first deadline.
  h.skip(READY_PROOF_MS + 500);
  await h.grant();
  await h.advance(READY_PROOF_MS - 501);
  expect(h.tunnels[0]!.signals).toEqual([]);
  await h.advance(1);
  expect(h.now()).toBe(2 * READY_PROOF_MS);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  h.tunnels[0]!.exit(143);
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("readiness");
});

test("an admitted proof whose catalog request fails, or an admission without the proof id, does not prove", async () => {
  const h = await started({
    catalog: (_route, _id, admit) => { admit(); return ok("upstream error\n503"); },
  });
  await h.grant();
  await h.tick();
  h.supervisor.notifyAuthenticatedRequest?.("link-key");
  await h.advance(2_000);
  expect(h.state().state.kind).toBe("connecting");
  expect(h.state().routes?.route).toBeNull();
});

test("a candidate without a grant line is never sent a readiness trigger and is stopped as grant_unobserved", async () => {
  const h = await started();
  await h.advance(READY_PROOF_MS);
  expect(h.runs.filter(run => run.kind === "catalog")).toHaveLength(0);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  h.tunnels[0]!.exit(143);
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("grant_unobserved");
});

test("a stopped candidate whose exit never arrives blocks the round instead of starting another tunnel", async () => {
  const h = await started({ stubborn: true });
  await h.advance(READY_PROOF_MS);
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  await h.advance(2_000);
  expect(h.state().routes?.blocked).toBe("stop_unconfirmed");
  await h.advance(60_000);
  expect(h.tunnels).toHaveLength(1);
  // The exit finally arrives: the round resumes on the next route.
  h.tunnels[0]!.exit(137);
  await flush();
  expect(h.state().routes?.blocked).toBeNull();
  expect(h.tunnels[1]!.argv.at(-1)).toBe("pen-alpha");
  h.tunnels[1]!.exit(0);
  await flush();
  await h.supervisor.stop();
});

test("only a link whose every route refuses the pinned key fails terminally", async () => {
  const h = await started({ probe: () => refused("Host key verification failed.") });
  expect(h.state().state).toMatchObject({ kind: "failed", reason: "hostkey" });
  const probes = h.runs.filter(run => run.kind === "probe").length;
  await h.advance(3_600_000);
  expect(h.runs.filter(run => run.kind === "probe").length).toBe(probes);
});

test("a transient direct route that is cooling keeps a host-key fallback from failing the link, and it recovers alone", async () => {
  let directUp = false;
  const h = await started({ probe: route => route === "alpha-lan" ? (directUp ? ok("ocx-link-probe\n") : refused("Connection timed out")) : refused("Host key verification failed.") });
  expect(h.state().state.kind).toBe("reconnecting");
  directUp = true;
  for (let i = 0; i < 5 && h.tunnels.length === 0; i += 1) await h.advance(1_000);
  expect(h.tunnels[0]!.argv.at(-1)).toBe("alpha-lan");
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
});

test("auth refusals on one route are retried at most once per five minutes even while the other route flaps", async () => {
  const h = await started({ probe: route => route === "pen-alpha" ? refused("alice@pen-alpha: Permission denied (publickey).") : refused("Connection refused") });
  for (let i = 0; i < 400; i += 1) await h.advance(1_000);
  // Probed at the start and once after its five-minute rest (the link has by then moved to the 60 s
  // failed-retry cadence of the outage clock); never on the direct route's faster cadence.
  expect(h.runs.filter(run => run.kind === "probe" && run.destination === "pen-alpha")).toHaveLength(2);
  expect(h.runs.filter(run => run.kind === "probe" && run.destination === "alpha-lan").length).toBeGreaterThan(5);
});

test("an ssh client that is not OpenSSH blocks multi-route links without probing, keeping their routes", async () => {
  const h = await started({ client: { code: 0, stdout: "", stderr: "Dropbear v2024.85" } });
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.state().routes?.blocked).toBe("ssh_client_unsupported");
  expect(h.state().routes?.routes.map(route => route.name)).toEqual(["alpha-lan", "pen-alpha"]);
  expect(h.tunnels).toHaveLength(0);
});

test("a one-route link takes today's path: no client check, no probe, the old argv and the grace promotion", async () => {
  const h = await started({ routes: undefined, store: () => ({ version: 1, listenerPort: LISTENER_PORT, links: [record()] }) });
  expect(h.runs).toHaveLength(0);
  expect(h.tunnels[0]!.argv.at(-1)).toBe("pen-alpha");
  expect(option(h.tunnels[0]!.argv, "LogLevel")).toBe("ERROR");
  await h.advance(5_000);
  expect(h.state().state.kind).toBe("connected");
  expect(h.state().routes).toBeUndefined();
});

test("an empty store runs no ssh at all", async () => {
  const h = await started({ store: () => ({ version: 1, listenerPort: LISTENER_PORT, links: [] }) });
  expect(h.runs).toHaveLength(0);
  expect(h.tunnels).toHaveLength(0);
});

test("stopping during a probe aborts it and starts no tunnel", async () => {
  const h = await started({ probe: () => "hang" });
  const hung = h.runs.find(run => run.kind === "probe")!;
  await h.supervisor.stopLink(LINK);
  expect(hung.signal?.aborted).toBe(true);
  await h.advance(ROUTE_PROBE_MS);
  expect(h.tunnels).toHaveLength(0);
});

test("an earlier tunnel identified by pid, argv and start time is stopped before any candidate, rechecked before SIGKILL", async () => {
  const argv = ["ssh", "-N", "old"];
  let alive = true;
  const h = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv, startTime: 777 },
    processArgv: () => alive ? argv : null,
    processStart: () => alive ? 777 : null,
  });
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(await h.supervisor.reconnect(LINK)).toBe(false);
  await h.advance(2_000);
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }, { pid: 4242, signal: "SIGKILL" }]);
  alive = false;
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  // The link was waiting for the old tunnel: its first round starts now and proves a route.
  await h.tick();
  expect(h.tunnels).toHaveLength(1);
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
});

test("a reused pid is never signalled: start time differs before discovery, or changes before SIGKILL", async () => {
  const argv = ["ssh", "-N", "old"];
  const before = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv, startTime: 777 },
    processArgv: () => argv, processStart: () => 999,
  });
  expect(before.kills).toEqual([]);
  expect(before.state().orphan).toBeUndefined();
  let start = 777;
  const during = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv, startTime: 777 },
    processArgv: () => argv, processStart: () => start,
  });
  start = 999;
  await during.advance(2_000);
  expect(during.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
});

test("a multi-route pidfile without a start time is never signalled while its pid lives, and blocks the link", async () => {
  const h = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv: ["ssh"] },
    processArgv: () => ["ssh"],
  });
  expect(h.kills).toEqual([]);
  expect(h.state().orphan).toBe("orphan-unverified");
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
});

test("a proven tunnel that exits on a host-key error is not terminal while another route's latest outcome is transient", async () => {
  const h = await started({ probe: route => route === "alpha-lan" ? refused("Connection timed out") : ok("ocx-link-probe\n") });
  await h.grant();
  await h.tick();
  expect(h.state().routes?.route?.name).toBe("pen-alpha");
  h.tunnels[0]!.exit(255, "Host key verification failed.");
  await flush();
  expect(h.state().state.kind).toBe("reconnecting");
  expect(h.state().routes?.routes[1]?.lastOutcome?.class).toBe("hostkey");
});

test("a route edit during a probe restarts the round on the new list without starting a tunnel for the old one", async () => {
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
  const h = await started({ probe: route => route === "alpha-lan" ? "hang" : ok("ocx-link-probe\n"), store: () => current });
  const hung = h.runs.find(run => run.kind === "probe")!;
  current = { ...current, links: [record(["alpha-tailnet", "pen-alpha"])] };
  await h.supervisor.reload();
  await flush();
  await h.tick();
  expect(hung.signal?.aborted).toBe(true);
  expect(h.runs.filter(run => run.kind === "probe").map(run => run.destination)).toEqual(["alpha-lan", "alpha-tailnet"]);
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toEqual(["alpha-tailnet"]);
});

test("a record without a recorded platform discovers it over the candidate's own route before the proof", async () => {
  const withoutPlatform = { ...record(["alpha-lan", "pen-alpha"]) } as LinkRecord;
  delete (withoutPlatform as { remotePlatform?: string }).remotePlatform;
  const h = await started({ store: () => ({ version: 1, listenerPort: LISTENER_PORT, links: [withoutPlatform] }) });
  await h.grant();
  await h.tick();
  const discovery = h.runs.filter(run => run.kind === "other");
  expect(discovery.length).toBeGreaterThan(0);
  expect(discovery.every(run => run.destination === "alpha-lan")).toBe(true);
  expect(h.state().state.kind).toBe("connected");
});

test("a failed ssh client re-check leaves a proven tunnel connected and applies to the next round", async () => {
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
  let client: SshRunResult = { code: 0, stdout: "", stderr: "OpenSSH_9.6p1" };
  const h = await started({ store: () => current, client: () => client });
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
  // A route edit re-reads the client; the binary was replaced meanwhile.
  client = { code: 0, stdout: "", stderr: "Dropbear v2024.85" };
  current = { ...current, links: [record(["alpha-lan", "alpha-tailnet", "pen-alpha"])] };
  await h.supervisor.reload();
  await h.tick();
  expect(h.state().state.kind).toBe("connected");
  expect(h.tunnels[0]!.signals).toEqual([]);
  // The next round, after this tunnel ends, reports the unsupported client.
  h.tunnels[0]!.exit(255, "Connection reset by peer");
  await flush();
  await h.advance(2_000);
  await h.tick();
  expect(h.state().routes?.blocked).toBe("ssh_client_unsupported");
  expect(h.tunnels).toHaveLength(1);
});

test("an unreadable identity of a live pid is never treated as gone: no signal, the pidfile stays, the link stays blocked", async () => {
  const atDiscovery = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv: ["ssh"], startTime: 777 },
    processArgv: () => ["ssh"], processStart: () => null, processAlive: () => true,
  });
  expect(atDiscovery.kills).toEqual([]);
  expect(atDiscovery.removed).toEqual([]);
  expect(atDiscovery.state().orphan).toBe("orphan-unverified");
  let readable = true;
  const duringReap = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv: ["ssh"], startTime: 777 },
    processArgv: () => readable ? ["ssh"] : null, processStart: () => 777, processAlive: () => true,
  });
  expect(duringReap.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  readable = false;
  await duringReap.advance(2_000);
  await duringReap.advance(2_000);
  expect(duringReap.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(duringReap.removed).toEqual([]);
  expect(duringReap.state().orphan).toBe("orphan-unverified");
  expect(duringReap.runs.filter(run => run.kind === "probe")).toHaveLength(0);
});

test("a tunnel whose pidfile cannot be written is stopped and awaited before the next route starts", async () => {
  const h = await started({ stubborn: true, writePidfile: () => { throw new Error("disk full"); } });
  expect(h.tunnels).toHaveLength(1);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  await h.advance(10_000);
  expect(h.tunnels).toHaveLength(1);
  expect(h.state().routes?.blocked).toBe("stop_unconfirmed");
  h.tunnels[0]!.exit(137);
  await flush();
  expect(h.tunnels).toHaveLength(2);
  h.tunnels[1]!.exit(0);
  await flush();
  await h.supervisor.stop();
});

test("while a reload is stuck stopping one link, another link's probe result starts no tunnel until the reload ends", async () => {
  const other = "lnk_fedcba9876543210";
  let resolveProbe!: (result: SshRunResult) => void;
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"]), record(["beta-lan", "pen-alpha"], other, 19004)] };
  const opts: Parameters<typeof harness>[0] = {
    stubborn: true,
    store: () => current,
    probe: route => route === "beta-lan" ? new Promise<SshRunResult>(resolve => { resolveProbe = resolve; }) : ok("ocx-link-probe\n"),
  };
  const h = await started(opts);
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toEqual(["alpha-lan"]);
  // The first link's record changes; its stubborn candidate keeps the reload waiting.
  current = { ...current, links: [record(["alpha-lan", "pen-alpha"], LINK, 19005), current.links[1]!] };
  const reload = h.supervisor.reload();
  await flush();
  resolveProbe(ok("ocx-link-probe\n"));
  await flush();
  await h.tick();
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toEqual(["alpha-lan"]);
  h.tunnels[0]!.exit(143);
  await reload;
  await h.tick();
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toContain("beta-lan");
  opts.stubborn = false;
});

test("a proof that settles after the candidate's exit was observed does not promote it", async () => {
  const held: { release?: () => void } = {};
  let finishCatalog!: (result: SshRunResult) => void;
  const h = await started({
    holdStderr: held,
    catalog: (_route, _id, admit) => { admit(); return new Promise<SshRunResult>(resolve => { finishCatalog = resolve; }); },
  });
  await h.grant();
  await h.tick();
  h.tunnels[0]!.exit(255, "Connection reset by peer");
  await flush();
  finishCatalog(ok(JSON.stringify({ models: [] }) + "\n200"));
  await flush();
  expect(h.state().state.kind).not.toBe("connected");
  held.release?.();
  await flush();
  expect(h.state().routes?.route).toBeNull();
});

test("a blocking earlier tunnel without proven identity is watched without signals and the link starts once it is gone", async () => {
  let alive = true;
  const legacy = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv: ["ssh"] },
    processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive,
  });
  expect(legacy.state().orphan).toBe("orphan-unverified");
  await legacy.advance(10_000);
  expect(legacy.kills).toEqual([]);
  alive = false;
  await legacy.advance(1_000);
  expect(legacy.state().orphan).toBeUndefined();
  await legacy.tick();
  expect(legacy.runs.filter(run => run.kind === "probe")).toHaveLength(1);

  let readable = true;
  let present = true;
  const unreadable = await started({
    pidfile: { version: 1, linkId: LINK, pid: 4343, argv: ["ssh"], startTime: 5 },
    processArgv: () => present && readable ? ["ssh"] : null, processStart: () => present && readable ? 5 : null, processAlive: () => present,
  });
  expect(unreadable.kills).toEqual([{ pid: 4343, signal: "SIGTERM" }]);
  readable = false;
  await unreadable.advance(5_000);
  expect(unreadable.kills).toEqual([{ pid: 4343, signal: "SIGTERM" }]);
  expect(unreadable.state().orphan).toBe("orphan-unverified");
  present = false;
  await unreadable.advance(1_000);
  expect(unreadable.state().orphan).toBeUndefined();
  await unreadable.tick();
  expect(unreadable.runs.filter(run => run.kind === "probe")).toHaveLength(1);
});

async function busyWithDeferredProbe(answer: SshRunResult) {
  const other = "lnk_fedcba9876543210";
  let resolveProbe!: (result: SshRunResult) => void;
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"]), record(["beta-lan", "pen-alpha"], other, 19004)] };
  const opts: Parameters<typeof harness>[0] = {
    stubborn: true,
    store: () => current,
    probe: (route, attempt) => route === "beta-lan" && attempt === 1 ? new Promise<SshRunResult>(resolve => { resolveProbe = resolve; }) : ok("ocx-link-probe\n"),
  };
  const h = await started(opts);
  current = { ...current, links: [record(["alpha-lan", "pen-alpha"], LINK, 19005), current.links[1]!] };
  const reload = h.supervisor.reload();
  await flush();
  const settledAt = h.now();
  resolveProbe(answer);
  await flush();
  // Lifecycle work stays busy well past the probe bound.
  for (let i = 0; i < 15; i += 1) await h.advance(1_000);
  const beforeRelease = h.supervisor.status().find(status => status.linkId === other) as ReturnType<Harness["state"]>;
  h.tunnels[0]!.exit(143);
  await reload;
  await h.tick();
  const after = h.supervisor.status().find(status => status.linkId === other) as ReturnType<Harness["state"]>;
  opts.stubborn = false;
  return { h, settledAt, beforeRelease, after };
}

test("a probe that succeeded while lifecycle work ran is neither timed out nor failed, and its tunnel starts afterwards", async () => {
  const { h, beforeRelease, after } = await busyWithDeferredProbe(ok("ocx-link-probe\n"));
  expect(beforeRelease.routes?.routes[0]?.lastOutcome).toBeNull();
  expect(after.routes?.routes[0]?.lastOutcome).toBeNull();
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toContain("beta-lan");
});

test("a probe that failed while lifecycle work ran counts once, at the time it settled", async () => {
  const { h, settledAt, after } = await busyWithDeferredProbe(refused("Connection refused"));
  expect(after.routes?.routes[0]?.lastOutcome).toEqual({ class: "transient", at: settledAt });
  expect(h.runs.filter(run => run.kind === "probe" && run.destination === "beta-lan")).toHaveLength(1);
});

test("a proof admitted in time whose answer settles after its deadline, before the next tick, does not promote", async () => {
  let finishCatalog!: (result: SshRunResult) => void;
  const h = await started({ catalog: (_route, _id, admit) => { admit(); return new Promise<SshRunResult>(resolve => { finishCatalog = resolve; }); } });
  await h.grant();
  await h.tick();
  h.skip(READY_PROOF_MS);
  finishCatalog(ok(JSON.stringify({ models: [] }) + "\n200"));
  await flush();
  expect(h.state().state.kind).not.toBe("connected");
  expect(h.state().routes?.route).toBeNull();
});

test.each(["removed", "replaced", "now one-route"] as const)("an orphan watch whose link was %s sends no further signal and touches no pidfile", async change => {
  const other = "lnk_fedcba9876543210";
  const argv = ["ssh", "-N", "old"];
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"]), record(["beta-lan", "pen-alpha"], other, 19004)] };
  const h = await started({
    store: () => current,
    pidfile: { version: 1, linkId: LINK, pid: 4242, argv, startTime: 777 },
    processArgv: () => argv, processStart: () => 777, processAlive: () => true,
  });
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  const second = current.links[1]!;
  current = {
    ...current,
    links: change === "removed" ? [second]
      : change === "replaced" ? [record(["alpha-lan", "pen-alpha"], LINK, 19006), second]
      : [record(undefined, LINK), second],
  };
  await h.supervisor.reload();
  await h.advance(2_000);
  await h.advance(2_000);
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(h.removed).toEqual([]);
});

test("a probe that succeeds after its deadline, before the tick, is a timeout of that route", async () => {
  let finishProbe!: (result: SshRunResult) => void;
  const h = await started({ probe: route => route === "alpha-lan" ? new Promise<SshRunResult>(resolve => { finishProbe = resolve; }) : ok("ocx-link-probe\n") });
  h.skip(ROUTE_PROBE_MS);
  finishProbe(ok("ocx-link-probe\n"));
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("transient");
  expect(h.tunnels.map(tunnel => tunnel.argv.at(-1))).toEqual(["pen-alpha"]);
});

test.each(["before the old process exits", "before the pending SIGKILL"] as const)("a pidfile replaced %s is never acted on by the old watch: no signal, no removal, the link stays blocked", async moment => {
  const oldArgv = ["ssh", "-N", "old"];
  let file: Pidfile = { version: 1, linkId: LINK, pid: 4242, argv: oldArgv, startTime: 777 };
  let oldAlive = true;
  const h = await started({
    pidfile: () => file,
    processArgv: pid => pid === 4242 ? (oldAlive ? oldArgv : null) : ["ssh", "-N", "new"],
    processStart: pid => pid === 4242 ? (oldAlive ? 777 : null) : 888,
    processAlive: pid => pid === 4242 ? oldAlive : true,
  });
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  file = { version: 1, linkId: LINK, pid: 5555, argv: ["ssh", "-N", "new"], startTime: 888 };
  if (moment === "before the old process exits") oldAlive = false;
  await h.advance(2_000);
  await h.advance(2_000);
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(h.removed).toEqual([]);
  expect(h.state().orphan).toBe("orphan-unverified");
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
});

test.each([
  ["host key", "Host key verification failed."],
  ["auth", "alice@alpha-lan: Permission denied (publickey)."],
] as const)("a late %s failure is a timeout of that route, never its class", async (_label, stderr) => {
  let finishProbe!: (result: SshRunResult) => void;
  const h = await started({ probe: route => route === "alpha-lan" ? new Promise<SshRunResult>(resolve => { finishProbe = resolve; }) : ok("ocx-link-probe\n") });
  h.skip(ROUTE_PROBE_MS);
  finishProbe(refused(stderr));
  await flush();
  expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("transient");
});

test("after a pidfile replacement the link stays blocked until the original and the replacement are both gone", async () => {
  const oldArgv = ["ssh", "-N", "old"];
  const newArgv = ["ssh", "-N", "new"];
  let file: Pidfile = { version: 1, linkId: LINK, pid: 4242, argv: oldArgv, startTime: 777 };
  const alive = new Map<number, boolean>([[4242, true], [5555, true]]);
  const h = await started({
    pidfile: () => file,
    processArgv: pid => alive.get(pid) ? (pid === 4242 ? oldArgv : newArgv) : null,
    processStart: pid => alive.get(pid) ? (pid === 4242 ? 777 : 888) : null,
    processAlive: pid => alive.get(pid) ?? false,
  });
  file = { version: 1, linkId: LINK, pid: 5555, argv: newArgv, startTime: 888 };
  await h.advance(1_000);
  // The replacement exits first; the original still lives.
  alive.set(5555, false);
  await h.advance(1_000);
  await h.advance(5_000);
  expect(h.state().orphan).toBe("orphan-unverified");
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  alive.set(4242, false);
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
});

test("a replacement pidfile that reuses the original pid with another start time keeps the link blocked while it lives", async () => {
  const oldArgv = ["ssh", "-N", "old"];
  const newArgv = ["ssh", "-N", "new"];
  let file: Pidfile = { version: 1, linkId: LINK, pid: 4242, argv: oldArgv, startTime: 777 };
  // Which process pid 4242 names right now: the original, then (after it exits) the replacement.
  let holder: "old" | "new" | "none" = "old";
  const h = await started({
    pidfile: () => file,
    processArgv: () => holder === "old" ? oldArgv : holder === "new" ? newArgv : null,
    processStart: () => holder === "old" ? 777 : holder === "new" ? 999 : null,
    processAlive: () => holder !== "none",
  });
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  holder = "new";
  file = { version: 1, linkId: LINK, pid: 4242, argv: newArgv, startTime: 999 };
  await h.advance(1_000);
  await h.advance(5_000);
  expect(h.kills).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
  expect(h.removed).toEqual([]);
  expect(h.state().orphan).toBe("orphan-unverified");
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  holder = "none";
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
});

test("a Child whose config output is over 64 KiB still proves readiness and connects (#8356)", async () => {
  // Enrollment accepts up to the runner maximum (#8380); a multi-route link must too, or every candidate
  // on every route fails its config step and is stopped at the readiness deadline.
  const big = JSON.stringify({ port: CHILD_PORT, runtimeRole: "client", providers: { padding: "x".repeat(200 * 1024) } });
  const h = await started({ configStdout: big });
  await h.grant();
  await h.tick();
  expect(h.runs.some(run => run.kind === "config")).toBe(true);
  expect(h.state().state.kind).toBe("connected");
  expect(h.state().routes?.route?.name).toBe("alpha-lan");
});

test("a stale pidfile that cannot be removed once its watched process is gone does not stop the tick", async () => {
  let alive = true;
  const h = await started({
    pidfile: { version: 1, linkId: LINK, pid: 5454, argv: ["ssh"] },
    processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive,
    removeFails: () => true,
  });
  expect(h.state().orphan).toBe("orphan-unverified");
  alive = false;
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  expect(h.warns.filter(line => line.includes("could not be removed"))).toEqual([`[link] stale pidfile could not be removed link=${LINK}`]);
});

test("a re-read pidfile naming a gone process that cannot be removed lifts the block and starts the round", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    const h = await started({ pidfileDir: dir, processAlive: () => false, removeFails: () => true });
    expect(h.state().orphan).toBe("orphan-unverified");
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5555, argv: ["ssh"] }) + "\n");
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  });
});

test("a link that gains routes without a flag or a running child still has its pidfile checked", async () => {
  // Removing a link drops its flag; re-added as one route with ssh missing, nothing flags it again.
  const oneRoute: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record()] };
  let current = oneRoute;
  let alive = true;
  let sshMissing = true;
  const h = await started({
    store: () => current,
    pidfile: { version: 1, linkId: LINK, pid: 5656, argv: ["ssh", "old"] },
    processArgv: () => alive ? ["ssh", "other"] : null, processAlive: () => alive,
    spawnFails: () => sshMissing,
  });
  expect(h.state().orphan).toBe("orphan-unverified");
  current = { ...oneRoute, links: [] };
  await h.supervisor.reload();
  current = oneRoute;
  await h.supervisor.reload();
  expect(h.state().orphan).toBeUndefined();
  sshMissing = false;
  current = { ...oneRoute, links: [record(["alpha-lan", "pen-alpha"])] };
  await h.supervisor.reload();
  await h.tick();
  expect(h.state().orphan).toBe("orphan-unverified");
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([]);
});

test("a pidfile that becomes readable on a later tick is signalled there when its identity is proven, SIGKILL after the grace", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    const argv = ["ssh", "-N", "old"];
    const h = await started({ pidfileDir: dir, processArgv: () => argv, processStart: () => 4321, processAlive: () => true });
    expect(h.state().orphan).toBe("orphan-unverified");
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5757, argv, startTime: 4321 }) + "\n");
    await h.advance(1_000);
    expect(h.kills).toEqual([{ pid: 5757, signal: "SIGTERM" }]);
    await h.advance(1_000);
    expect(h.kills).toEqual([{ pid: 5757, signal: "SIGTERM" }]);
    await h.advance(1_000);
    expect(h.kills).toEqual([{ pid: 5757, signal: "SIGTERM" }, { pid: 5757, signal: "SIGKILL" }]);
    expect(h.state().orphan).toBe("orphan-unverified");
  });
});

test("the readiness budget runs from the grant: a slow route granted late still has the full budget to prove", async () => {
  // A relay route to a slow Child can spend much of 30 s before its listener is granted.
  let clock: () => number = () => 0;
  const h = await started({ catalog: (_route, _proofId, admit) => {
    if (clock() < 32_000) return ok(JSON.stringify({ models: [] }) + "\n200");
    admit();
    return ok(JSON.stringify({ models: [] }) + "\n200");
  } });
  clock = h.now;
  await h.advance(25_000);
  await h.grant();
  await h.tick();
  expect(h.state().state.kind).toBe("connecting");
  for (let at = 25_000; at < 34_000; at += 1_000) await h.advance(1_000);
  expect(h.state().state.kind).toBe("connected");
  expect(h.tunnels).toHaveLength(1);
  expect(h.tunnels[0]!.signals).toEqual([]);
});

test("a granted candidate is still stopped when its proof fails for the whole budget after the grant", async () => {
  const h = await started({ catalog: () => ok(JSON.stringify({ models: [] }) + "\n200") });
  await h.advance(5_000);
  await h.grant();
  await h.advance(READY_PROOF_MS - 1);
  expect(h.tunnels[0]!.signals).toEqual([]);
  await h.advance(1);
  expect(h.tunnels[0]!.signals).toContain("SIGTERM");
});

test("a one-route link's orphan flag left by a failed spawn is watched when the link gains routes, and the link starts once it is gone", async () => {
  // At start the one-route reaper cannot prove the old tunnel's identity, so it flags it; ssh is
  // missing, so no spawn clears the flag. A route edit must not leave that flag with nothing watching it.
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record()] };
  let alive = true;
  let sshMissing = true;
  const h = await started({
    store: () => current,
    pidfile: () => ({ version: 1, linkId: LINK, pid: 4545, argv: ["ssh", "old"] }),
    processArgv: () => alive ? ["ssh", "other"] : null, processAlive: () => alive,
    spawnFails: () => sshMissing,
  });
  expect(h.tunnels).toHaveLength(0);
  expect(h.state().orphan).toBe("orphan-unverified");
  sshMissing = false;
  current = { ...current, links: [record(["alpha-lan", "pen-alpha"])] };
  await h.supervisor.reload();
  await h.tick();
  // Still possibly alive: nothing starts and nothing is signalled.
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([]);
  alive = false;
  await h.advance(1_000);
  await h.tick();
  expect(h.state().orphan).toBeUndefined();
  // The link is in its failed spawn's backoff (a forward failure at 0). The due attempt starts the first
  // round with its ssh client check, and the round's first probe goes on the next tick.
  const retryAt = HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!;
  await h.advance(retryAt - 1 - h.now());
  expect(h.runs).toEqual([]);
  await h.advance(1);
  expect(h.runs.map(run => run.kind)).toEqual(["client"]);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
});

test.each([
  ["is gone", (path: string) => rmSync(path), undefined],
  ["is a directory", (path: string) => { rmSync(path); mkdirSync(path); }, "orphan-unverified"],
  ["holds no pidfile", (path: string) => writeFileSync(path, "not a pidfile\n"), "orphan-unverified"],
] as const)("a flagged one-route link that gains routes while its pidfile %s", async (_case, spoil, orphan) => {
  // Only a pidfile that does not exist shows no earlier tunnel is left; one that exists and cannot be
  // read may still name the ssh holding the port, so the flag stays and no candidate starts.
  const dir = mkdtempSync(join(tmpdir(), "ocx-link-pid-"));
  try {
    const path = join(dir, LINK + ".pid");
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 4545, argv: ["ssh", "old"] }) + "\n");
    let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record()] };
    let sshMissing = true;
    const h = await started({
      store: () => current, pidfileDir: dir,
      processArgv: () => ["ssh", "other"], processAlive: () => true,
      spawnFails: () => sshMissing,
    });
    expect(h.state().orphan).toBe("orphan-unverified");
    spoil(path);
    sshMissing = false;
    current = { ...current, links: [record(["alpha-lan", "pen-alpha"])] };
    await h.supervisor.reload();
    await h.tick();
    expect(h.state().orphan).toBe(orphan);
    await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(orphan === undefined ? 1 : 0);
    expect(h.kills).toEqual([]);
    if (orphan === undefined) return;
    // The blocked link's pidfile is read again on every tick: once it is gone, the block lifts without a restart.
    rmSync(path, { recursive: true, force: true });
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const unreadablePidfiles = [
  ["is a directory", (path: string) => { mkdirSync(path); }],
  ["holds no pidfile", (path: string) => { writeFileSync(path, "not a pidfile\n"); }],
] as const;

/** A multi-route harness on a temporary pidfile directory, read with the supervisor's own reader. */
async function withPidfileDir(run: (dir: string, path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ocx-link-pid-"));
  try { await run(dir, join(dir, LINK + ".pid")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test.each(unreadablePidfiles)("a multi-route link whose pidfile %s at start is blocked, warned once, and starts once the file is gone", async (_case, spoil) => {
  await withPidfileDir(async (dir, path) => {
    spoil(path);
    const h = await started({ pidfileDir: dir });
    // An existing pidfile that cannot be read may name the ssh still holding the port.
    expect(h.state().orphan).toBe("orphan-unverified");
    for (let i = 0; i < 3; i += 1) await h.advance(60_000);
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
    expect(h.kills).toEqual([]);
    expect(h.warns.filter(line => line.includes("pidfile unreadable"))).toEqual([`[link] pidfile unreadable; link stays blocked link=${LINK}`]);
    rmSync(path, { recursive: true, force: true });
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  });
});

test("an unreadable pidfile that becomes readable is watched like any earlier tunnel until its process is gone", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    let alive = true;
    const h = await started({ pidfileDir: dir, processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive });
    expect(h.state().orphan).toBe("orphan-unverified");
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 4646, argv: ["ssh"] }) + "\n");
    await h.advance(5_000);
    // A legacy pidfile without a start time: watched without signals, still blocking.
    expect(h.state().orphan).toBe("orphan-unverified");
    expect(h.kills).toEqual([]);
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
    alive = false;
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  });
});

test("a reload that changes a flagged link's record keeps it blocked while the earlier tunnel may live", async () => {
  // A new listener port changes every record instance but not the Child's tunnel port the earlier ssh holds.
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
  let alive = true;
  const h = await started({
    store: () => current,
    pidfile: { version: 1, linkId: LINK, pid: 4747, argv: ["ssh"] },
    processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive,
  });
  expect(h.state().orphan).toBe("orphan-unverified");
  current = { ...current, listenerPort: LISTENER_PORT + 10 };
  await h.supervisor.reload();
  await h.tick();
  expect(h.state().orphan).toBe("orphan-unverified");
  await h.advance(5_000);
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([]);
  alive = false;
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
});

test("a reload that changes a watched link's record keeps watching the earlier process after its pidfile is gone", async () => {
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
  let alive = true;
  let file: Pidfile | null = { version: 1, linkId: LINK, pid: 4848, argv: ["ssh"] };
  const h = await started({ store: () => current, pidfile: () => file, processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive });
  expect(h.state().orphan).toBe("orphan-unverified");
  // The pidfile goes while its ssh still runs; the watch already holds that process.
  file = null;
  current = { ...current, listenerPort: LISTENER_PORT + 10 };
  await h.supervisor.reload();
  await h.advance(5_000);
  expect(h.state().orphan).toBe("orphan-unverified");
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  alive = false;
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
});

test("after a reload that replaced its record, a watch only observes: no signal, and no pidfile removal when the process ends", async () => {
  let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
  let alive = true;
  const argv = ["ssh", "-N", "old"];
  const h = await started({
    store: () => current, stubborn: true,
    pidfile: { version: 1, linkId: LINK, pid: 4949, argv, startTime: 888 },
    processArgv: () => alive ? argv : null, processStart: () => alive ? 888 : null, processAlive: () => alive,
  });
  expect(h.kills).toEqual([{ pid: 4949, signal: "SIGTERM" }]);
  current = { ...current, listenerPort: LISTENER_PORT + 10 };
  await h.supervisor.reload();
  for (let i = 0; i < 5; i += 1) await h.advance(1_000);
  expect(h.kills).toEqual([{ pid: 4949, signal: "SIGTERM" }]);
  alive = false;
  await h.advance(1_000);
  expect(h.state().orphan).toBeUndefined();
  expect(h.removed).toEqual([]);
});

test("a pidfile unreadable at a reload that replaced the record is never acted on once it becomes readable", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
    let alive = true;
    const argv = ["ssh", "-N", "old"];
    const h = await started({
      store: () => current, pidfileDir: dir,
      processArgv: () => alive ? argv : null, processStart: () => alive ? 999 : null, processAlive: () => alive,
    });
    current = { ...current, listenerPort: LISTENER_PORT + 10 };
    await h.supervisor.reload();
    await h.tick();
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5050, argv, startTime: 999 }) + "\n");
    await h.advance(1_000);
    await h.advance(3_000);
    expect(h.state().orphan).toBe("orphan-unverified");
    expect(h.kills).toEqual([]);
    alive = false;
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    expect(h.removed).toEqual([]);
  });
});

test("a watch whose pidfile turns unreadable does not lift the block when its process ends", async () => {
  await withPidfileDir(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5151, argv: ["ssh"] }) + "\n");
    let alive = true;
    const h = await started({ pidfileDir: dir, processArgv: () => alive ? ["ssh"] : null, processAlive: () => alive });
    expect(h.state().orphan).toBe("orphan-unverified");
    // The file is replaced by something unreadable: it may name another tunnel now.
    rmSync(path);
    mkdirSync(path);
    alive = false;
    await h.advance(1_000);
    await h.advance(60_000);
    expect(h.state().orphan).toBe("orphan-unverified");
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
    expect(h.warns.filter(line => line.includes("pidfile unreadable"))).toHaveLength(1);
    rmSync(path, { recursive: true });
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    await h.tick();
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(1);
  });
});

test("a blocked link that is removed and added again with the same id is settled from its pidfile, not left blocked", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    const other = record(["beta-lan", "pen-alpha"], "lnk_fedcba9876543210", 19004);
    const blocked = record(["alpha-lan", "pen-alpha"]);
    let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [blocked, other] };
    const h = await started({ store: () => current, pidfileDir: dir });
    expect(h.state().orphan).toBe("orphan-unverified");
    current = { ...current, links: [other] };
    await h.supervisor.reload();
    await h.advance(1_000);
    rmSync(path, { recursive: true });
    current = { ...current, links: [blocked, other] };
    await h.supervisor.reload();
    await h.tick();
    expect(h.state().orphan).toBeUndefined();
    expect(h.runs.filter(run => run.kind === "probe" && run.destination === "alpha-lan")).toHaveLength(1);
  });
});

test("a pidfile replaced while unreadable, after the watched process ended, is only observed once readable", async () => {
  await withPidfileDir(async (dir, path) => {
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5252, argv: ["ssh"] }) + "\n");
    let oldAlive = true;
    let newAlive = true;
    const newArgv = ["ssh", "-N", "new"];
    const h = await started({
      pidfileDir: dir,
      processArgv: pid => pid === 5252 ? (oldAlive ? ["ssh"] : null) : (newAlive ? newArgv : null),
      processStart: pid => pid === 5353 && newAlive ? 1234 : null,
      processAlive: pid => pid === 5252 ? oldAlive : newAlive,
    });
    expect(h.state().orphan).toBe("orphan-unverified");
    rmSync(path);
    mkdirSync(path);
    oldAlive = false;
    await h.advance(1_000);
    // Another owner's tunnel, with a provable identity, now holds the pidfile.
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: LINK, pid: 5353, argv: newArgv, startTime: 1234 }) + "\n");
    await h.advance(1_000);
    await h.advance(3_000);
    expect(h.kills).toEqual([]);
    expect(h.state().orphan).toBe("orphan-unverified");
    newAlive = false;
    await h.advance(1_000);
    expect(h.state().orphan).toBeUndefined();
    expect(h.removed).toEqual([]);
  });
});

test("a reload that changes the record of a link blocked by an unreadable pidfile keeps it blocked", async () => {
  await withPidfileDir(async (dir, path) => {
    mkdirSync(path);
    let current: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record(["alpha-lan", "pen-alpha"])] };
    const h = await started({ store: () => current, pidfileDir: dir });
    expect(h.state().orphan).toBe("orphan-unverified");
    current = { ...current, listenerPort: LISTENER_PORT + 10 };
    await h.supervisor.reload();
    await h.tick();
    await h.advance(60_000);
    expect(h.state().orphan).toBe("orphan-unverified");
    expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
    expect(h.warns.filter(line => line.includes("pidfile unreadable"))).toHaveLength(1);
  });
});

test("a link on a later route stays there until ocx link reconnect starts a round from the first rested route", async () => {
  let lanDown = true;
  const h = await started({ probe: route => route === "alpha-lan" && lanDown ? refused("ssh: connect to host 10.0.0.5 port 22: Connection refused") : ok("ocx-link-probe\n") });
  await h.grant();
  await h.tick();
  expect(h.state().routes?.route?.name).toBe("pen-alpha");
  // The direct route comes back and its rest ends: the link does not move by itself.
  lanDown = false;
  await h.advance(60_000);
  expect(h.state().routes?.route?.name).toBe("pen-alpha");
  expect(h.runs.filter(run => run.kind === "probe" && run.destination === "alpha-lan")).toHaveLength(1);
  expect(await h.supervisor.reconnect(LINK)).toBe(true);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe").at(-1)?.destination).toBe("alpha-lan");
  await h.grant();
  await h.tick();
  expect(h.state().routes?.route?.name).toBe("alpha-lan");
});

test("a reload that changes an unflagged one-route link's record and gives it routes still checks its pidfile", async () => {
  // Removing a link drops its flag; re-added as one route with ssh missing, nothing flags it again. One reload
  // then changes its record instance (a new listener port) and gives it routes.
  const oneRoute: LinkStore = { version: 1, listenerPort: LISTENER_PORT, links: [record()] };
  let current = oneRoute;
  let sshMissing = true;
  const h = await started({
    store: () => current,
    pidfile: { version: 1, linkId: LINK, pid: 6161, argv: ["ssh", "old"] },
    processArgv: () => ["ssh", "other"], processAlive: () => true,
    spawnFails: () => sshMissing,
  });
  expect(h.state().orphan).toBe("orphan-unverified");
  current = { ...oneRoute, links: [] };
  await h.supervisor.reload();
  current = oneRoute;
  await h.supervisor.reload();
  expect(h.state().orphan).toBeUndefined();
  sshMissing = false;
  current = { ...oneRoute, listenerPort: LISTENER_PORT + 10, links: [record(["alpha-lan", "pen-alpha"])] };
  await h.supervisor.reload();
  await h.tick();
  expect(h.state().orphan).toBe("orphan-unverified");
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([]);
});

const oneRouteStore = (): LinkStore => ({ version: 1, listenerPort: LISTENER_PORT, links: [record()] });

test("a one-route startup that stops an earlier ssh whose pidfile cannot be removed still starts the link", async () => {
  const h = await started({
    store: oneRouteStore,
    pidfile: { version: 1, linkId: LINK, pid: 6262, argv: ["ssh", "old"] },
    processArgv: () => ["ssh", "old"],
    removeFails: () => true,
  });
  expect(h.kills).toEqual([{ pid: 6262, signal: "SIGTERM" }]);
  expect(h.warns).toContain(`[link] stale pidfile could not be removed link=${LINK}`);
  expect(h.tunnels).toHaveLength(1);
});

/** A harness whose pidfile reads back what the supervisor last wrote, so an exit's conditional removal sees its own child. */
async function withWrittenPidfile(options: Parameters<typeof harness>[0] = {}) {
  let written: Pidfile | null = null;
  const control = { removeFails: false };
  const h = await started({
    ...options,
    pidfile: () => written,
    writePidfile: (_path, pidfile) => { written = pidfile; },
    removeFails: () => control.removeFails,
  });
  return { h, control, written: () => written };
}

test("a one-route exit removes exactly its own pidfile once", async () => {
  const { h, written } = await withWrittenPidfile({ store: oneRouteStore });
  expect(written()?.pid).toBe(h.tunnels[0]!.child.pid);
  h.tunnels[0]!.exit(255, "Connection reset by peer");
  await flush();
  expect(h.removed).toHaveLength(1);
  expect(h.removed[0]!.endsWith(LINK + ".pid")).toBe(true);
  expect(h.state().state.kind).toBe("reconnecting");
});

test.each(["one-route", "multi-route"] as const)("a %s tunnel exit whose pidfile cannot be removed is still classified", async kind => {
  const { h, control } = await withWrittenPidfile(kind === "one-route" ? { store: oneRouteStore } : {});
  expect(h.tunnels).toHaveLength(1);
  control.removeFails = true;
  h.tunnels[0]!.exit(255, "Connection reset by peer");
  await flush();
  expect(h.warns).toContain(`[link] stale pidfile could not be removed link=${LINK}`);
  if (kind === "one-route") expect(h.state().state.kind).toBe("reconnecting");
  else expect(h.state().routes?.routes[0]?.lastOutcome?.class).toBe("transient");
});

test("a reload that stops a one-route link whose pidfile cannot be removed still completes", async () => {
  let current = oneRouteStore();
  const { h, control } = await withWrittenPidfile({ store: () => current });
  expect(h.tunnels).toHaveLength(1);
  control.removeFails = true;
  current = { ...current, links: [] };
  await h.supervisor.reload();
  expect(h.supervisor.status()).toEqual([]);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  expect(h.warns).toContain(`[link] stale pidfile could not be removed link=${LINK}`);
});

test.each(["changes its record in the same reload", "keeps its record"] as const)("a one-route link whose pidfile write failed and that gains routes while it %s settles from the older pidfile once its tunnel is stopped", async variant => {
  // The earlier tunnel could not be identified at start, so the one-route spawn went ahead (and cleared the flag),
  // but its pidfile write failed: the older pidfile, naming a live earlier ssh, is still there.
  let current = oneRouteStore();
  // Started without a tick: the next tick would stop the unrecorded tunnel (a failed state with a running child).
  const h = start({
    store: () => current,
    pidfile: { version: 1, linkId: LINK, pid: 7070, argv: ["ssh", "older"] },
    writePidfile: () => { throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }); },
    processArgv: pid => pid === 7070 ? ["ssh", "other"] : null, processAlive: pid => pid === 7070,
  });
  await flush();
  expect(h.tunnels).toHaveLength(1);
  expect(h.tunnels[0]!.signals).toEqual([]);
  current = { ...current, ...(variant === "keeps its record" ? {} : { listenerPort: LISTENER_PORT + 10 }), links: [record(["alpha-lan", "pen-alpha"])] };
  await h.supervisor.reload();
  await h.tick();
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  expect(h.state().orphan).toBe("orphan-unverified");
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  expect(h.kills).toEqual([]);
});

test("a one-route tunnel stopped by the tick after its pidfile write failed survives a pidfile that cannot be removed", async () => {
  // The write landed the file and then failed (a directory sync after the rename, say): the link is failed with a
  // running child, so the next tick sends it SIGTERM; the harness's tunnel exits on it at once, and the exit
  // watch then removes the pidfile naming it.
  let written: Pidfile | null = null;
  let removeFails = false;
  const h = start({
    store: oneRouteStore,
    pidfile: () => written,
    writePidfile: (_path, pidfile) => { written = pidfile; throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); },
    removeFails: () => removeFails,
  });
  await flush();
  expect(h.tunnels).toHaveLength(1);
  removeFails = true;
  await h.tick();
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  expect(h.warns).toContain(`[link] stale pidfile could not be removed link=${LINK}`);
  // The failed removal stopped nothing: the failed link's due retry still spawns.
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
  expect(h.tunnels).toHaveLength(2);
});

const readOnlyPidfile = () => { throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }); };

test("a one-route tunnel the tick stops after its pidfile write failed is watched until it exits: SIGKILL after the grace, no second tunnel meanwhile", async () => {
  const opts: Parameters<typeof harness>[0] = { store: oneRouteStore, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  expect(h.tunnels).toHaveLength(1);
  await h.tick();
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  await h.advance(1_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  await h.advance(1_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  // The retry is due, but the stopped tunnel has not exited yet.
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward!);
  expect(h.tunnels).toHaveLength(1);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await flush();
  await h.tick();
  expect(h.tunnels).toHaveLength(2);
});

test("a reload that gives routes while a stopped, unrecorded one-route tunnel is still exiting starts no round until it exits", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  await h.tick();
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  current = { ...current, links: [record(["alpha-lan", "pen-alpha"])] };
  const reload = h.supervisor.reload();
  await flush();
  // Past the failed link's retry: nothing may start while the old ssh is still exiting.
  await h.advance(HOME_TUNNEL_RETRY_POLICY.retryFailedAfterMs.forward! + 5_000);
  await h.tick();
  expect(h.runs.filter(run => run.kind === "probe")).toHaveLength(0);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
  await h.tick();
  await h.tick();
  // Only now does the first round start, at the first route.
  expect(h.runs.find(run => run.kind === "probe")?.destination).toBe("alpha-lan");
});

test("a reload that stops a running child which ignores SIGTERM sends SIGKILL after the grace", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true };
  const h = start(opts);
  await flush();
  current = { ...current, links: [] };
  const reload = h.supervisor.reload();
  await flush();
  expect(h.tunnels[0]!.signals.at(-1)).toBe("SIGTERM");
  await h.advance(1_000);
  expect(h.tunnels[0]!.signals).not.toContain("SIGKILL");
  // The reload is still draining that tunnel; the tick escalates it all the same.
  await h.advance(1_000);
  expect(h.tunnels[0]!.signals.at(-1)).toBe("SIGKILL");
  expect(h.tunnels[0]!.signals.filter(signal => signal === "SIGKILL")).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
  expect(h.supervisor.status()).toEqual([]);
});

test.each(["during a reload's drain", "on its own"] as const)("shutdown %s still sends SIGKILL after the grace to a one-route child that ignores SIGTERM", async when => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true };
  const h = start(opts);
  await flush();
  let reload: Promise<void> | undefined;
  if (when === "during a reload's drain") {
    current = { ...current, links: [] };
    reload = h.supervisor.reload();
    await flush();
    await h.advance(1_000);
  }
  const stopped = h.supervisor.stop();
  await flush();
  expect(h.tunnels[0]!.signals).not.toContain("SIGKILL");
  await h.advance(when === "on its own" ? 2_000 : 1_000);
  expect(h.tunnels[0]!.signals.filter(signal => signal === "SIGKILL")).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
  await stopped;
});

test("a shutdown whose stop of one child fails still escalates the other drains and clears its timer", async () => {
  const other = "lnk_fedcba9876543210";
  const opts: Parameters<typeof harness>[0] = {
    store: () => ({ version: 1, listenerPort: LISTENER_PORT, links: [record(), record(undefined, other, 19004)] }),
    stubborn: true, killFails: index => index === 0,
  };
  const h = start(opts);
  await flush();
  expect(h.tunnels).toHaveLength(2);
  let rejected: unknown;
  const stopped = h.supervisor.stop().catch(error => { rejected = error; });
  await flush();
  await h.advance(2_000);
  // The first child's stop failed; the second is still drained and escalated before the timer goes.
  expect(h.tunnels[1]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(h.timer.cleared).toBe(0);
  opts.stubborn = false;
  h.tunnels[1]!.exit(137);
  await stopped;
  expect((rejected as NodeJS.ErrnoException | undefined)?.code).toBe("EPERM");
  expect(h.timer.cleared).toBe(1);
  // The afterEach stop must not signal the failing tunnel again.
  opts.killFails = () => false;
  h.tunnels[0]!.exit(143);
});

test("a reload that drains a child the tick stopped 1.5 s earlier sends SIGKILL at the tick's grace, not a fresh one", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  await h.tick();
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM"]);
  h.skip(1_500);
  current = { ...current, links: [] };
  const reload = h.supervisor.reload();
  await flush();
  await h.advance(499);
  expect(h.tunnels[0]!.signals).not.toContain("SIGKILL");
  await h.advance(1);
  expect(h.tunnels[0]!.signals.filter(signal => signal === "SIGKILL")).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
});

test("a reload that drains a child the tick already sent SIGKILL sends no second one", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  await h.tick();
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  current = { ...current, links: [] };
  const reload = h.supervisor.reload();
  await flush();
  await h.advance(2_000);
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals.filter(signal => signal === "SIGKILL")).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
});

test("a stopped one-route child whose exit is never seen after SIGKILL is warned once", async () => {
  const opts: Parameters<typeof harness>[0] = { store: oneRouteStore, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  await h.tick();
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  await h.advance(1_999);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toEqual([]);
  await h.advance(1);
  await h.advance(1_000);
  await h.advance(1_000);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toEqual([`[link] tunnel exit unconfirmed link=${LINK}`]);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await flush();
});

test("a reload whose drained child survives SIGKILL warns once while it holds the lifecycle queue", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true };
  const h = start(opts);
  await flush();
  current = { ...current, links: [] };
  const reload = h.supervisor.reload();
  await flush();
  await h.advance(2_000);
  expect(h.tunnels[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
  await h.advance(1_999);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toEqual([]);
  await h.advance(1);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toEqual([`[link] tunnel exit unconfirmed link=${LINK}`]);
  await h.advance(1_000);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
});

test("a drained child the tick already warned about is not warned again by the drain", async () => {
  let current = oneRouteStore();
  const opts: Parameters<typeof harness>[0] = { store: () => current, stubborn: true, writePidfile: readOnlyPidfile };
  const h = start(opts);
  await flush();
  await h.tick();
  await h.advance(2_000);
  await h.advance(2_000);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toHaveLength(1);
  current = { ...current, links: [] };
  const reload = h.supervisor.reload();
  await flush();
  await h.advance(2_000);
  await h.advance(2_000);
  expect(h.warns.filter(line => line.includes("exit unconfirmed"))).toHaveLength(1);
  opts.stubborn = false;
  h.tunnels[0]!.exit(137);
  await reload;
});

test("a hold whose cancellation throws is released, so the link can be reconnected", async () => {
  const h = await started();
  const forget = h.proofs.forget.bind(h.proofs);
  h.proofs.forget = () => { throw new Error("forget failed"); };
  expect(() => h.supervisor.holdLink!(LINK)).toThrow("forget failed");
  h.proofs.forget = forget;
  // A leaked hold makes reconnect decline (it returns false while the link is held).
  expect(await h.supervisor.reconnect(LINK)).toBe(true);
});
