import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_LINK_MAX_HOLDS,
  clientLinkTunnelStatus,
  clientTunnelPidfilePath,
  CONNECTION_UNREADABLE,
  createClientLinkSupervisor,
  readWhenFileChanges,
  reapOrphanTunnel,
  spawnClientLinkTunnel,
  type ClientLinkSupervisorDeps,
} from "../../src/client/link-tunnel";
import type { ClientLinkState } from "../../src/client/link-state";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import { buildTunnelArgv } from "../../src/link/ssh-argv";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function fakeRunner(resolveOnTerm = true) {
  const children: Array<{ child: SshChild; resolve: (code: number) => void; signals: NodeJS.Signals[] }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      const exit = deferred<number>();
      const item = { child: undefined as unknown as SshChild, resolve: exit.resolve, signals: [] as NodeJS.Signals[] };
      item.child = {
        pid: 30_000 + children.length,
        argv: [...argv],
        exited: exit.promise,
        stderr: Promise.resolve(""),
        kill(signal = "SIGTERM") { item.signals.push(signal); if (signal === "SIGTERM" && resolveOnTerm) exit.resolve(143); },
      };
      children.push(item);
      return item.child;
    },
  };
  return { runner, children };
}

function sidecar(linkId = "lnk_0123456789abcdef"): ClientLinkState {
  return {
    linkId,
    alias: "home.example.test",
    hubHostKeyFingerprint: "SHA256:abcdefghijklmnop",
    peerListenerPort: 19001,
    tunnelPort: 19002,
  };
}

function tempConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "ocx-client-link-tunnel-"));
}

test("spawns the client tunnel with the exact local forward argv and writes a private pidfile", async () => {
  const configDir = tempConfigDir();
  const fake = fakeRunner();
  try {
    const handle = spawnClientLinkTunnel({ ...sidecar() }, {
      configDir,
      knownHostsFile: join(configDir, "link", "known_hosts"),
      runner: fake.runner,
    });
    expect(fake.children[0]!.child.argv).toEqual(buildTunnelArgv({
      alias: "home.example.test",
      direction: "L",
      bindPort: 19002,
      targetPort: 19001,
      knownHostsFile: join(configDir, "link", "known_hosts"),
    }));
    const pidfile = clientTunnelPidfilePath(configDir);
    expect(JSON.parse(readFileSync(pidfile, "utf8"))).toEqual({
      version: 1,
      linkId: sidecar().linkId,
      pid: fake.children[0]!.child.pid,
      argv: fake.children[0]!.child.argv,
      ownerPid: process.pid,
    });
    if (process.platform !== "win32") expect(statSync(pidfile).mode & 0o777).toBe(0o600);
    fake.children[0]!.resolve(0);
    await handle.stop();
    expect(existsSync(pidfile)).toBe(false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("sends TERM and then KILL after the bounded stop wait", async () => {
  const configDir = tempConfigDir();
  const fake = fakeRunner(false);
  const timers: Array<() => void> = [];
  try {
    const handle = spawnClientLinkTunnel({ ...sidecar() }, {
      configDir,
      runner: fake.runner,
      setTimer: (callback, ms) => {
        expect(ms).toBe(5_000);
        timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
    });
    const stopping = handle.stop();
    await Promise.resolve();
    expect(fake.children[0]!.signals).toEqual(["SIGTERM"]);
    timers[0]!();
    await stopping;
    expect(fake.children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    fake.children[0]!.resolve(137);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("reaps only a dead owner's exact Linux tunnel and drops a stale pidfile", async () => {
  const configDir = tempConfigDir();
  const path = clientTunnelPidfilePath(configDir);
  const argv = ["ssh", "-N", "-T"];
  const writePidfile = (ownerPid: number, pid: number, value = argv) => {
    mkdirSync(join(configDir, "link"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: sidecar().linkId, pid, argv: value, ownerPid }));
  };
  try {
    writePidfile(41, 42);
    expect(await reapOrphanTunnel({
      configDir, isAlive: pid => pid === 41 || pid === 42, platform: "linux", readProcessArgv: () => argv,
    })).toEqual({ tunnel: "owned", pid: 42 });
    expect(existsSync(path)).toBe(true);

    // A live owner whose tunnel is gone (pids reused after a reboot) leaves only a stale pidfile.
    expect(await reapOrphanTunnel({
      configDir, isAlive: pid => pid === 41, platform: "linux", readProcessArgv: () => null,
    })).toEqual({ tunnel: "absent" });
    expect(existsSync(path)).toBe(false);

    const signals: NodeJS.Signals[] = [];
    writePidfile(41, 42);
    expect(await reapOrphanTunnel({
      configDir,
      isAlive: pid => pid === 42,
      platform: "linux",
      readProcessArgv: () => argv,
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
    })).toEqual({ tunnel: "reaped" });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(existsSync(path)).toBe(false);

    writePidfile(41, 42, ["ssh", "-R"]);
    expect(await reapOrphanTunnel({
      configDir,
      isAlive: () => false,
      platform: "linux",
      readProcessArgv: () => argv,
    })).toEqual({ tunnel: "absent" });
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("macOS reaps an exact-argv orphan of launchd and never signals a process it cannot prove is its own", async () => {
  const configDir = tempConfigDir();
  const path = clientTunnelPidfilePath(configDir);
  const argv = ["ssh", "-N", "-T", "-L", "127.0.0.1:19002:127.0.0.1:19001", "--", "home.example.test"];
  const writePidfile = () => {
    mkdirSync(join(configDir, "link"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: 42, argv, ownerPid: 41 }));
  };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const record = (pid: number, signal: NodeJS.Signals) => { signals.push([pid, signal]); };
  try {
    // Owner and tunnel both gone: the pidfile is stale.
    writePidfile();
    expect(await reapOrphanTunnel({ configDir, platform: "darwin", isAlive: () => false, signal: record })).toEqual({ tunnel: "absent" });
    expect(existsSync(path)).toBe(false);

    // The exact argv under launchd after the owner died: TERM, and it is gone.
    writePidfile();
    let alive = true;
    expect(await reapOrphanTunnel({
      configDir,
      platform: "darwin",
      isAlive: pid => pid === 42 && alive,
      readProcessInfo: () => ({ ppid: 1, args: argv.join(" ") }),
      signal: (pid, signal) => { record(pid, signal); alive = false; },
      sleep: async () => {},
    })).toEqual({ tunnel: "reaped" });
    expect(signals).toEqual([[42, "SIGTERM"]]);
    expect(existsSync(path)).toBe(false);

    // Our argv under another parent, or a process ps cannot read: watched, never signalled.
    for (const info of [{ ppid: 500, args: argv.join(" ") }, null]) {
      signals.length = 0;
      writePidfile();
      expect(await reapOrphanTunnel({
        configDir, platform: "darwin", isAlive: pid => pid === 42, readProcessInfo: () => info, signal: record, sleep: async () => {},
      })).toEqual({ tunnel: "unresolved", pid: 42 });
      expect(signals).toEqual([]);
      expect(existsSync(path)).toBe(true);
    }

    // The pid now runs another program (reused after a reboot): stale, and never signalled.
    expect(await reapOrphanTunnel({
      configDir, platform: "darwin", isAlive: pid => pid === 42,
      readProcessInfo: () => ({ ppid: 1, args: "/usr/libexec/some-daemon --agent" }), signal: record,
    })).toEqual({ tunnel: "absent" });
    expect(signals).toEqual([]);
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("the macOS process reader identifies a live child by its exact argv and parent", async () => {
  const configDir = tempConfigDir();
  const path = clientTunnelPidfilePath(configDir);
  const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  const signals: NodeJS.Signals[] = [];
  const writePidfile = (argv: string[]) => {
    mkdirSync(join(configDir, "link"), { recursive: true });
    // Owner 999999 does not exist, so only the identity check stands between the child and a signal.
    writeFileSync(path, JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: sleeper.pid, argv, ownerPid: 999_999 }));
  };
  try {
    // Real `ps`: the argv matches, but the parent is this test, not launchd.
    writePidfile(["sleep", "30"]);
    expect(await reapOrphanTunnel({ configDir, platform: "darwin", signal: (_pid, signal) => { signals.push(signal); } }))
      .toEqual({ tunnel: "unresolved", pid: sleeper.pid });
    writePidfile(["sleep", "31"]);
    expect(await reapOrphanTunnel({ configDir, platform: "darwin", signal: (_pid, signal) => { signals.push(signal); } }))
      .toEqual({ tunnel: "absent" });
    expect(signals).toEqual([]);
  } finally {
    sleeper.kill();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("supervisor starts once while connected and ends once after a missing or mismatched sidecar", async () => {
  const configDir = tempConfigDir();
  const fake = fakeRunner();
  const timers: Array<() => void> = [];
  let currentSidecar: ClientLinkState | null = sidecar();
  let connected = sidecar().linkId;
  let ended = 0;
  try {
    const supervisor = createClientLinkSupervisor({
      configDir,
      runner: fake.runner,
      readSidecar: () => currentSidecar,
      connectedLinkId: () => connected,
      setTimer: (callback, ms) => {
        if (ms === 1_000) timers.push(callback);
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => {},
      onLinkEnded: () => { ended += 1; },
      now: () => 0,
      random: () => 0.5,
    });
    supervisor.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.children).toHaveLength(1);
    timers[0]!();
    await Promise.resolve();
    expect(fake.children).toHaveLength(1);
    currentSidecar = null;
    timers[0]!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fake.children[0]!.signals).toContain("SIGTERM");
    expect(ended).toBe(1);
    timers[0]!();
    await Promise.resolve();
    expect(ended).toBe(1);

    await supervisor.stop();

    currentSidecar = sidecar();
    connected = "different";
    const second = createClientLinkSupervisor({
      configDir: tempConfigDir(),
      runner: fake.runner,
      readSidecar: () => currentSidecar,
      connectedLinkId: () => connected,
      setTimer: callback => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: () => {},
    });
    second.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.children).toHaveLength(1);
    await second.stop();
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("corrupt sidecar fails closed without spawning", async () => {
  const fake = fakeRunner();
  const supervisor = createClientLinkSupervisor({
    runner: fake.runner,
    readSidecar: () => { throw new Error("invalid sidecar"); },
    connectedLinkId: () => "lnk_0123456789abcdef",
    setTimer: callback => setTimeout(callback, 1_000),
    clearTimer: timer => clearTimeout(timer),
  });
  supervisor.start();
  await Promise.resolve();
  expect(fake.children).toHaveLength(0);
  expect(supervisor.status()).toEqual({ kind: "failed", reason: "sidecar_invalid" });
  await supervisor.stop();
});

test("projects an invalid sidecar as a failed child status", () => {
  const configDir = tempConfigDir();
  const sidecarPath = join(configDir, "link", "client-link.json");
  mkdirSync(join(configDir, "link"), { recursive: true });
  writeFileSync(sidecarPath, "{broken");
  try {
    expect(clientLinkTunnelStatus(sidecarPath, () => Date.parse("2026-09-25T00:00:00.000Z"))).toEqual({
      alias: "unknown",
      state: "failed",
      since: "2026-09-25T00:00:00.000Z",
      reason: "sidecar_invalid",
    });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

const LINK_KEY = `ocx_data_${"f".repeat(40)}`;
const HOST_KEY_CHANGED = "Host key verification failed.";

/** ssh children that stay up until the test ends them with an exit code and stderr. */
function scriptedRunner() {
  const children: Array<{ child: SshChild; alive: boolean; signals: NodeJS.Signals[]; exit(code: number, stderr?: string): void }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      const exited = deferred<number>();
      let stderrText = "";
      const item = {
        child: undefined as unknown as SshChild,
        alive: true,
        signals: [] as NodeJS.Signals[],
        exit(code: number, stderr = "") {
          if (!item.alive) return;
          item.alive = false;
          stderrText = stderr;
          exited.resolve(code);
        },
      };
      item.child = {
        pid: 31_000 + children.length,
        argv: [...argv],
        exited: exited.promise,
        stderr: exited.promise.then(() => stderrText),
        kill(signal = "SIGTERM") { item.signals.push(signal); item.exit(143); },
      };
      children.push(item);
      return item.child;
    },
  };
  return { runner, children, live: () => children.filter(item => item.alive) };
}

/**
 * A client supervisor on a scripted ssh, an injected clock and a scripted Home `/readyz`.
 * `step` moves the clock and runs one supervisor tick to completion.
 */
function supervisorHarness(overrides: Partial<ClientLinkSupervisorDeps> = {}) {
  const configDir = tempConfigDir();
  const ssh = scriptedRunner();
  const intervals: Array<() => void> = [];
  const probes: Array<{ url: string; keyed: boolean; cache: RequestCache | undefined }> = [];
  const view = {
    readyz: 200 as number | "refused",
    readyzBody: null as string | null,
    sidecar: sidecar() as ClientLinkState | null | "unreadable",
    connected: sidecar().linkId as string | null,
    clock: 0,
    ended: 0,
  };
  const supervisor = createClientLinkSupervisor({
    configDir,
    runner: ssh.runner,
    readSidecar: () => {
      if (view.sidecar === "unreadable") throw new Error("client-link.json is not valid JSON");
      return view.sidecar;
    },
    connectedLinkId: () => view.connected,
    setTimer: (callback, ms) => {
      if (ms === 1_000) intervals.push(callback);
      return intervals.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    now: () => view.clock,
    random: () => 0.5,
    linkKey: () => LINK_KEY,
    fetchImpl: (async (input, init) => {
      probes.push({ url: String(input), keyed: new Headers(init?.headers).get("x-opencodex-api-key") === LINK_KEY, cache: init?.cache });
      if (view.readyz === "refused") throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
      return new Response(view.readyzBody, { status: view.readyz });
    }) as typeof fetch,
    onLinkEnded: () => { view.ended += 1; },
    ...overrides,
  });
  const settle = async () => {
    for (let turn = 0; turn < 3; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  };
  return {
    configDir,
    ssh,
    supervisor,
    probes,
    view,
    settle,
    state: () => {
      const status = supervisor.status();
      return status.kind === "tunnel" ? status.state.kind : status.kind;
    },
    async start() {
      supervisor.start();
      await settle();
    },
    async step(ms = 1_000) {
      view.clock += ms;
      intervals[0]!();
      await settle();
    },
    async close() {
      await supervisor.stop();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

test("after a six-minute outage the tunnel is back within a minute of the Home returning", async () => {
  const h = supervisorHarness();
  try {
    await h.start();
    await h.step();
    expect(h.state()).toBe("connected");

    h.view.readyz = "refused";
    h.ssh.children[0]!.exit(255, "ssh: connect to host home port 22: Connection refused");
    let spawnsInLastMinute = 0;
    for (let elapsed = 1_000; elapsed <= 6 * 60_000; elapsed += 1_000) {
      for (const item of h.ssh.live()) item.exit(255, "ssh: connect to host home port 22: Operation timed out");
      const before = h.ssh.children.length;
      await h.step();
      if (elapsed > 5 * 60_000) spawnsInLastMinute += h.ssh.children.length - before;
    }
    expect(h.state()).toBe("failed");
    // Past the five-minute window the retries slow to about one a minute.
    expect(spawnsInLastMinute).toBeLessThanOrEqual(1);

    h.view.readyz = 200;
    let reconnectedAfter = -1;
    for (let elapsed = 1_000; elapsed <= 90_000; elapsed += 1_000) {
      await h.step();
      if (h.state() === "connected") {
        reconnectedAfter = elapsed;
        break;
      }
    }
    expect(reconnectedAfter).toBeGreaterThan(0);
    expect(reconnectedAfter).toBeLessThanOrEqual(62_000);
  } finally {
    await h.close();
  }
}, 30_000);

test("a reconnect is promoted by a keyed readyz and the healthy ssh is never cut afterwards", async () => {
  const h = supervisorHarness();
  try {
    await h.start();
    await h.step();
    expect(h.state()).toBe("connected");
    h.ssh.children[0]!.exit(255, "client_loop: send disconnect: Broken pipe");
    await h.settle();
    expect(h.state()).toBe("reconnecting");
    await h.step();
    expect(h.ssh.children).toHaveLength(2);
    await h.step();
    expect(h.state()).toBe("connected");
    const probesWhenConnected = h.probes.length;

    for (let minute = 1; minute <= 30; minute += 1) {
      for (let second = 0; second < 60; second += 5) await h.step(5_000);
      if (minute === 5 || minute === 30) {
        expect(h.state()).toBe("connected");
        expect(h.ssh.children[1]!.signals).toEqual([]);
        expect(h.ssh.children[1]!.alive).toBe(true);
      }
    }
    expect(h.ssh.children).toHaveLength(2);
    // While connected the only background cost is one keyed probe every 30 seconds.
    expect(h.probes.length - probesWhenConnected).toBeLessThanOrEqual(60);
    expect(h.probes.every(probe => probe.keyed && probe.cache === "no-store" && probe.url === "http://127.0.0.1:19002/readyz")).toBe(true);
  } finally {
    await h.close();
  }
}, 30_000);

test("the keyed probe reports an unauthorized key or an unreachable Home for display only", async () => {
  const h = supervisorHarness();
  try {
    await h.start();
    await h.step();
    expect(h.supervisor.status()).toMatchObject({ kind: "tunnel", state: { kind: "connected" } });
    h.view.readyz = 401;
    await h.step(30_000);
    expect(h.supervisor.status()).toMatchObject({ state: { kind: "connected" }, probe: "unauthorized" });
    h.view.readyz = 503;
    await h.step(30_000);
    expect(h.supervisor.status()).toMatchObject({ state: { kind: "connected" }, probe: "home_unreachable" });
    h.view.readyz = 200;
    await h.step(30_000);
    const status = h.supervisor.status();
    expect(status).toMatchObject({ state: { kind: "connected" } });
    expect("probe" in status).toBe(false);
    expect(h.ssh.children[0]!.signals).toEqual([]);
    expect(h.view.ended).toBe(0);
  } finally {
    await h.close();
  }
});

test("a Home that admits the key but reports its own readiness failed still carries the link, and its ssh is never cut", async () => {
  const h = supervisorHarness();
  try {
    // The Home's link listener answers 401 before /readyz, so its 503 readiness body proves the
    // forward and the key; only the Home's own start-up sync failed, which relayed requests ignore.
    h.view.readyz = 503;
    h.view.readyzBody = JSON.stringify({ service: "opencodex", status: "failed" });
    await h.start();
    const held = h.supervisor.waitForConnected(15_000);
    await h.step();
    expect(h.state()).toBe("connected");
    expect(await held).toBe(true);
    expect(h.supervisor.status()).toMatchObject({ state: { kind: "connected" }, probe: "home_not_ready" });
    for (let elapsed = 0; elapsed < 12 * 60_000; elapsed += 5_000) await h.step(5_000);
    expect(h.state()).toBe("connected");
    expect(h.ssh.children).toHaveLength(1);
    expect(h.ssh.children[0]!.signals).toEqual([]);

    // A 503 that is not the Home's readiness answer proves nothing, so a reconnect waits for one.
    h.view.readyzBody = "<html>Service Unavailable</html>";
    h.ssh.children[0]!.exit(255, "Connection reset by peer");
    await h.settle();
    for (let tick = 0; tick < 10; tick += 1) await h.step();
    expect(h.ssh.children).toHaveLength(2);
    expect(h.supervisor.status()).toMatchObject({ state: { kind: "reconnecting" }, probe: "home_unreachable" });
    h.view.readyzBody = JSON.stringify({ service: "opencodex", status: "pending" });
    for (let tick = 0; tick < 6 && h.state() !== "connected"; tick += 1) await h.step();
    expect(h.state()).toBe("connected");
    expect(h.ssh.children[1]!.signals).toEqual([]);
  } finally {
    await h.close();
  }
}, 30_000);

test("a probe that hangs never delays noticing a disconnect, and stop() aborts it instead of waiting", async () => {
  let hang = false;
  const probeSignals: AbortSignal[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (!hang) return new Response(null, { status: 200 });
    const signal = init!.signal!;
    probeSignals.push(signal);
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const race = (work: Promise<void>) =>
    Promise.race([work.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("waiting"), 500))]);

  const h = supervisorHarness({ fetchImpl });
  try {
    await h.start();
    await h.step();
    expect(h.state()).toBe("connected");
    hang = true;
    await h.step(30_000);
    expect(probeSignals).toHaveLength(1);
    h.view.connected = null;
    await h.step();
    expect(h.view.ended).toBe(1);
    expect(h.ssh.children[0]!.signals).toContain("SIGTERM");
    expect(probeSignals[0]!.aborted).toBe(true);
  } finally {
    expect(await race(h.close())).toBe("done");
  }

  const stopping = supervisorHarness({ fetchImpl });
  try {
    await stopping.start();
    await stopping.step();
    expect(probeSignals).toHaveLength(2);
    expect(await race(stopping.supervisor.stop())).toBe("done");
    expect(probeSignals[1]!.aborted).toBe(true);
    expect(stopping.ssh.children[0]!.signals).toContain("SIGTERM");
  } finally {
    await stopping.close();
  }
});

test("while a request is held the tunnel is probed on every check, and otherwise it backs off", async () => {
  const h = supervisorHarness();
  try {
    h.view.readyz = "refused";
    await h.start();
    for (let tick = 0; tick < 5; tick += 1) await h.step();
    // Nothing held: probes at one, two and four seconds, then the next is due at eight.
    expect(h.probes).toHaveLength(3);
    const held = h.supervisor.waitForConnected(15_000);
    await h.step();
    expect(h.probes).toHaveLength(4);
    h.view.readyz = 200;
    await h.step();
    expect(await held).toBe(true);
    expect(h.state()).toBe("connected");
    const probesWhenConnected = h.probes.length;
    for (let tick = 0; tick < 29; tick += 1) await h.step();
    expect(h.probes.length).toBe(probesWhenConnected);
  } finally {
    await h.close();
  }
});

test("a start-up read that cannot be used still reaps a leftover tunnel before the first spawn", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let orphanAlive = true;
  const argv = buildTunnelArgv({ alias: "home.example.test", direction: "L", bindPort: 19002, targetPort: 19001, knownHostsFile: "/tmp/ocx-known-hosts" });
  const h = supervisorHarness({
    platform: "linux",
    readProcessArgv: pid => (pid === 42 && orphanAlive ? argv : null),
    isAlive: pid => pid === 42 && orphanAlive,
    signal: (pid, signal) => { signals.push([pid, signal]); orphanAlive = false; },
    sleep: async () => {},
  });
  mkdirSync(join(h.configDir, "link"), { recursive: true });
  writeFileSync(clientTunnelPidfilePath(h.configDir), JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: 42, argv, ownerPid: 41 }));
  try {
    h.view.connected = CONNECTION_UNREADABLE as never;
    await h.start();
    expect(h.ssh.children).toHaveLength(0);
    h.view.connected = sidecar().linkId;
    await h.step();
    expect(signals).toEqual([[42, "SIGTERM"]]);
    expect(h.ssh.children).toHaveLength(1);
    await h.step();
    expect(h.state()).toBe("connected");
  } finally {
    await h.close();
  }
});

test("a macOS pidfile whose owner and ssh are both dead gives way to a new tunnel at once", async () => {
  const h = supervisorHarness({ platform: "darwin", isAlive: () => false });
  mkdirSync(join(h.configDir, "link"), { recursive: true });
  writeFileSync(clientTunnelPidfilePath(h.configDir), JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: 42, argv: ["ssh", "-N"], ownerPid: 41 }));
  try {
    await h.start();
    expect(h.ssh.children).toHaveLength(1);
    expect(h.state()).toBe("connecting");
    await h.step();
    expect(h.state()).toBe("connected");
  } finally {
    await h.close();
  }
});

test("a macOS orphan with the exact argv under launchd is reaped and replaced", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let orphanAlive = true;
  const argv = buildTunnelArgv({ alias: "home.example.test", direction: "L", bindPort: 19002, targetPort: 19001, knownHostsFile: "/tmp/ocx-known-hosts" });
  const h = supervisorHarness({
    platform: "darwin",
    isAlive: pid => pid === 42 && orphanAlive,
    readProcessInfo: pid => (pid === 42 ? { ppid: 1, args: argv.join(" ") } : null),
    signal: (pid, signal) => { signals.push([pid, signal]); orphanAlive = false; },
    sleep: async () => {},
  });
  mkdirSync(join(h.configDir, "link"), { recursive: true });
  writeFileSync(clientTunnelPidfilePath(h.configDir), JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: 42, argv, ownerPid: 41 }));
  try {
    await h.start();
    expect(signals).toEqual([[42, "SIGTERM"]]);
    expect(h.ssh.children).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("a macOS tunnel that cannot be verified is watched, never signalled, and replaced once it dies", async () => {
  const signals: Array<[number, NodeJS.Signals]> = [];
  let orphanAlive = true;
  const h = supervisorHarness({
    platform: "darwin",
    isAlive: pid => pid === 42 && orphanAlive,
    readProcessInfo: () => null,
    signal: (pid, signal) => { signals.push([pid, signal]); },
  });
  mkdirSync(join(h.configDir, "link"), { recursive: true });
  writeFileSync(clientTunnelPidfilePath(h.configDir), JSON.stringify({ version: 1, linkId: sidecar().linkId, pid: 42, argv: ["ssh", "-N"], ownerPid: 41 }));
  try {
    h.view.readyz = "refused";
    await h.start();
    expect(h.ssh.children).toHaveLength(0);
    expect(h.supervisor.status()).toMatchObject({ kind: "tunnel", state: { kind: "connecting" }, pid: 42 });
    // Past the five-minute window the link reads failed, but the adopted tunnel is still probed.
    for (let elapsed = 0; elapsed < 6 * 60_000; elapsed += 5_000) await h.step(5_000);
    expect(h.state()).toBe("failed");
    expect(h.ssh.children).toHaveLength(0);
    h.view.readyz = 200;
    for (let elapsed = 0; elapsed < 31_000 && h.state() !== "connected"; elapsed += 1_000) await h.step();
    expect(h.state()).toBe("connected");
    expect(h.ssh.children).toHaveLength(0);
    orphanAlive = false;
    await h.step();
    expect(h.ssh.children).toHaveLength(1);
    await h.step();
    expect(h.state()).toBe("connected");
    expect(signals).toEqual([]);
  } finally {
    await h.close();
  }
});

test("an unreadable read does not end the link; three in a row or an explicit disconnect do, once", async () => {
  const h = supervisorHarness();
  try {
    await h.start();
    await h.step();
    h.view.connected = CONNECTION_UNREADABLE as never;
    await h.step();
    await h.step();
    expect(h.view.ended).toBe(0);
    expect(h.ssh.children[0]!.signals).toEqual([]);
    h.view.connected = sidecar().linkId;
    await h.step();
    h.view.sidecar = "unreadable";
    await h.step();
    await h.step();
    expect(h.ssh.children[0]!.signals).toEqual([]);
    expect(h.supervisor.status()).toMatchObject({ kind: "tunnel", state: { kind: "connected" } });
    h.view.sidecar = sidecar();
    await h.step();
    h.view.connected = CONNECTION_UNREADABLE as never;
    for (let tick = 0; tick < 3; tick += 1) await h.step();
    expect(h.view.ended).toBe(1);
    expect(h.ssh.children[0]!.signals).toContain("SIGTERM");
  } finally {
    await h.close();
  }

  const disconnected = supervisorHarness();
  try {
    await disconnected.start();
    await disconnected.step();
    disconnected.view.connected = null;
    await disconnected.step();
    expect(disconnected.view.ended).toBe(1);
    await disconnected.step();
    await disconnected.step();
    expect(disconnected.view.ended).toBe(1);
  } finally {
    await disconnected.close();
  }
});

test("requests wait on a reconnect only while it lasts and are released when it connects or fails", async () => {
  const h = supervisorHarness();
  try {
    expect(h.supervisor.pending()).toBe(false);
    await h.start();
    expect(h.supervisor.pending()).toBe(true);
    await h.step();
    expect(h.supervisor.pending()).toBe(false);
    expect(await h.supervisor.waitForConnected(15_000)).toBe(true);

    h.view.readyz = "refused";
    h.ssh.children[0]!.exit(255, "Connection reset by peer");
    await h.settle();
    expect(h.supervisor.pending()).toBe(true);
    let released: boolean | undefined;
    const waiting = h.supervisor.waitForConnected(15_000).then(value => { released = value; return value; });
    await h.step();
    expect(h.ssh.children).toHaveLength(2);
    expect(released).toBeUndefined();
    h.view.readyz = 200;
    await h.step();
    expect(await waiting).toBe(true);

    h.ssh.children[1]!.exit(255, "Connection reset by peer");
    await h.settle();
    const failing = h.supervisor.waitForConnected(15_000);
    await h.step();
    h.ssh.children[2]!.exit(255, HOST_KEY_CHANGED);
    await h.settle();
    expect(await failing).toBe(false);
    expect(h.supervisor.status()).toMatchObject({ state: { kind: "failed", reason: "hostkey" } });
    expect(h.supervisor.pending()).toBe(false);
    expect(await h.supervisor.waitForConnected(15_000)).toBe(false);
  } finally {
    await h.close();
  }
});

test("the number of requests waiting on a reconnect is capped", async () => {
  const h = supervisorHarness();
  try {
    h.view.readyz = "refused";
    await h.start();
    const held = Array.from({ length: CLIENT_LINK_MAX_HOLDS }, () => h.supervisor.waitForConnected(15_000));
    expect(await h.supervisor.waitForConnected(15_000)).toBe(false);
    h.view.readyz = 200;
    await h.step();
    expect(await Promise.all(held)).toEqual(Array.from({ length: CLIENT_LINK_MAX_HOLDS }, () => true));
  } finally {
    await h.close();
  }
});

test("the supervisor's own reads parse a file again only after it changed", () => {
  const dir = tempConfigDir();
  const path = join(dir, "config.json");
  try {
    writeFileSync(path, "one");
    let reads = 0;
    const read = readWhenFileChanges(() => path, () => { reads += 1; return readFileSync(path, "utf8"); });
    expect(read()).toBe("one");
    expect(read()).toBe("one");
    expect(reads).toBe(1);
    writeFileSync(`${path}.next`, "two");
    renameSync(`${path}.next`, path);
    expect(read()).toBe("two");
    expect(reads).toBe(2);

    let refused = 0;
    const unreadable = readWhenFileChanges(() => path, () => { refused += 1; return CONNECTION_UNREADABLE; }, value => value !== CONNECTION_UNREADABLE);
    unreadable();
    unreadable();
    expect(refused).toBe(2);
    let thrown = 0;
    const throwing = readWhenFileChanges(() => path, () => { thrown += 1; throw new Error("bad"); });
    expect(() => throwing()).toThrow("bad");
    expect(() => throwing()).toThrow("bad");
    expect(thrown).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
