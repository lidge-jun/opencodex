import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientLinkTunnelStatus,
  clientTunnelPidfilePath,
  createClientLinkSupervisor,
  reapOrphanTunnel,
  spawnClientLinkTunnel,
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
    expect(statSync(pidfile).mode & 0o777).toBe(0o600);
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

test("reaps only a dead owner's exact Linux tunnel and preserves non-Linux ambiguity", async () => {
  const configDir = tempConfigDir();
  const path = clientTunnelPidfilePath(configDir);
  const argv = ["ssh", "-N", "-T"];
  const writePidfile = (ownerPid: number, pid: number, value = argv) => {
    mkdirSync(join(configDir, "link"), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, linkId: sidecar().linkId, pid, argv: value, ownerPid }));
  };
  try {
    writePidfile(41, 42);
    expect(await reapOrphanTunnel({ configDir, isAlive: pid => pid === 41, platform: "linux" })).toEqual({ tunnel: "owned" });
    expect(existsSync(path)).toBe(true);

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

    writePidfile(41, 42);
    expect(await reapOrphanTunnel({ configDir, isAlive: () => false, platform: "darwin" })).toEqual({ tunnel: "unresolved", pid: 42 });
    expect(existsSync(path)).toBe(true);
  } finally {
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
