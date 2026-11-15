import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnClientLinkTunnel } from "../../src/client/link-tunnel";
import { buildTunnelArgv } from "../../src/link/ssh-argv";
import { createSshCaptureOpener, startSshCapture, stopSshCapture, sshCaptureDir } from "../../src/link/ssh-capture";
import { createSshRunner, type SshChild, type SshRunner, type SshTunnelOptions } from "../../src/link/ssh-runner";
import type { LinkStore } from "../../src/link/store";
import { createLinkSupervisor } from "../../src/link/supervisor";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINK = "lnk_0123456789abcdef";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ssh-capture-tunnel-"));
  roots.push(dir);
  return dir;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function recordingRunner() {
  const calls: Array<{ argv: string[]; args: number; options?: SshTunnelOptions; exit: (code: number) => void }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(...args: [readonly string[], SshTunnelOptions?]) {
      const exit = deferred<number>();
      calls.push({ argv: [...args[0]], args: args.length, options: args[1], exit: exit.resolve });
      return { pid: 500 + calls.length, argv: [...args[0]], exited: exit.promise, stderr: Promise.resolve(""), kill: () => exit.resolve(143) } satisfies SshChild;
    },
  };
  return { runner, calls };
}

function hubStore(): LinkStore {
  return { version: 1, listenerPort: 19001, links: [{
    id: LINK, alias: "child.example.test", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort: 19002, apiKeyId: "lnk-key", createdAt: "2026-09-25T00:00:00.000Z",
  }] };
}

function supervisorFor(linkDirectory: string, runner: SshRunner, extra: Parameters<typeof createLinkSupervisor>[0] = {}) {
  let tick!: () => void;
  const supervisor = createLinkSupervisor({
    readStore: () => hubStore(), runner, pidfileDir: linkDirectory, random: () => 0.5,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: callback => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval>; }, clearTimer: () => {},
    ...extra,
  });
  return { supervisor, tick: () => tick() };
}

const homeArgv = (logLevel?: "DEBUG1") => buildTunnelArgv({
  alias: "child.example.test", direction: "R", bindPort: 19002, targetPort: 19001,
  knownHostsFile: join(process.env.OPENCODEX_HOME ?? "", "link", "known_hosts"), ...(logLevel ? { logLevel } : {}),
});

describe("Home -R tunnel and SSH capture", () => {
  test("disabled by default: the argv keeps LogLevel=ERROR, the runner gets no tap, nothing is written", async () => {
    const linkDirectory = join(tempDir(), "link");
    const { runner, calls } = recordingRunner();
    const { supervisor } = supervisorFor(linkDirectory, runner);
    supervisor.start();
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toBe(1);
      expect(calls[0]!.argv).toContain("LogLevel=ERROR");
      expect(calls[0]!.argv.join(" ")).not.toContain("DEBUG");
      expect(existsSync(sshCaptureDir(linkDirectory))).toBe(false);
    } finally {
      await supervisor.stop();
    }
  });

  test("an open window raises only the log level; expiry returns to ERROR on the next spawn", async () => {
    const linkDirectory = join(tempDir(), "link");
    let clock = Date.UTC(2026, 10, 11);
    startSshCapture({ linkDirectory, now: clock, minutes: 1 });
    const { runner, calls } = recordingRunner();
    const sshCapture = createSshCaptureOpener({ linkDirectory, now: () => clock });
    let current = 0;
    const { supervisor, tick } = supervisorFor(linkDirectory, runner, { sshCapture, now: () => current });
    supervisor.start();
    try {
      const enabled = calls[0]!;
      expect(enabled.args).toBe(2);
      expect(typeof enabled.options?.stderrLine).toBe("function");
      const withError = homeArgv();
      // The only difference from the default argv is the level itself.
      expect(enabled.argv).toEqual(withError.map(value => value === "LogLevel=ERROR" ? "LogLevel=DEBUG1" : value));
      enabled.exit(255);
      await Bun.sleep(0);
      clock += 60_000;
      current = 1_000;
      tick();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args).toBe(1);
      expect(calls[1]!.argv).toEqual(withError);
    } finally {
      await supervisor.stop();
    }
  });

  test("verbose stderr past 64 KiB neither ends the tunnel nor changes its exit class, and is stored sanitized", async () => {
    const linkDirectory = join(tempDir(), "link");
    startSshCapture({ linkDirectory, now: Date.now() });
    const encoder = new TextEncoder();
    const exits: Array<(code: number) => void> = [];
    const kills: string[] = [];
    const scripts = [
      // A healthy tunnel that saw refused channels, then dropped with no classified cause.
      [...Array.from({ length: 1_500 }, (_, index) => "debug1: channel " + index + ": connected to 127.0.0.1 port 19001\n"),
        "channel 3: open failed: connect failed: Connection refused\n",
        "debug1: connect_next: connect to 127.0.0.1 port 19001: Connection refused\n",
        "Transferred: sent 10, received 20 bytes, in 30.0 seconds\n"],
      ["debug1: Connecting to child.example.test [203.0.113.9] port 22.\n", "debug1: No more authentication methods to try.\n",
        "alice@child.example.test: Permission denied (publickey).\n"],
    ];
    const spawn = ((argv: string[]) => {
      const exit = deferred<number>();
      exits.push(exit.resolve);
      const script = scripts[exits.length - 1] ?? [];
      return {
        pid: 700 + exits.length, argv,
        stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { for (const line of script) controller.enqueue(encoder.encode(line)); controller.close(); } }),
        exited: exit.promise,
        kill(signal?: string) { kills.push(signal ?? "SIGTERM"); exit.resolve(143); },
      };
    }) as unknown as typeof Bun.spawn;
    let current = 0;
    const { supervisor, tick } = supervisorFor(linkDirectory, createSshRunner({ spawn }), { now: () => current });
    supervisor.start();
    try {
      expect(scripts[0]!.join("").length).toBeGreaterThan(64 * 1024);
      await Bun.sleep(20);
      expect(kills).toEqual([]);
      exits[0]!(255);
      await Bun.sleep(20);
      // At LogLevel=ERROR ssh prints none of these lines, so the exit stays unclassified.
      expect(supervisor.status()[0]).toMatchObject({ state: { kind: "reconnecting" }, history: { lastFailure: { cause: "unknown" } } });
      current = 1_000;
      tick();
      expect(exits).toHaveLength(2);
      exits[1]!(255);
      await Bun.sleep(20);
      expect(supervisor.status()[0]).toMatchObject({ state: { kind: "failed", reason: "auth" } });
    } finally {
      await supervisor.stop();
    }
    const dir = sshCaptureDir(linkDirectory);
    const file = readdirSync(dir).find(name => name.endsWith(".jsonl"))!;
    // The default opener is per directory; give its async writer a moment.
    for (let wait = 0; wait < 50 && !readFileSync(join(dir, file), "utf8").includes("auth.denied"); wait++) await Bun.sleep(10);
    const stored = readFileSync(join(dir, file), "utf8");
    expect(stored).toContain("\"event\":\"auth.denied\"");
    expect(stored).toContain("\"tunnel\":\"home\"");
    expect(stored).not.toMatch(/child\.example\.test|203\.0\.113|alice/);
  });
});

describe("ssh runner stderr tap", () => {
  const big = "debug1: channel 1: free: port listener, nchannels 2\n".repeat(4_000);
  const spawnWith = (text: string | string[], kills: string[]) => (() => {
    const exit = deferred<number>();
    return {
      pid: 900, stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      stderr: new ReadableStream<Uint8Array>({ start(controller) {
        for (const chunk of typeof text === "string" ? [text] : text) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      } }),
      exited: exit.promise, kill(signal?: string) { kills.push(signal ?? "SIGTERM"); exit.resolve(143); },
    };
  }) as unknown as typeof Bun.spawn;

  test("without a tap the 64 KiB stderr cap still ends the child, as before", async () => {
    const kills: string[] = [];
    const child = createSshRunner({ spawn: spawnWith(big, kills) }).spawnTunnel(["ssh"]);
    await expect(child.stderr!).rejects.toThrow("ssh output exceeded");
    expect(kills).toEqual(["SIGTERM"]);
  });

  test("with a tap only the lines it keeps are returned and counted against the cap", async () => {
    const kills: string[] = [];
    const seen: string[] = [];
    const child = createSshRunner({ spawn: spawnWith(big + "Host key verification failed.\r\npartial", kills) })
      .spawnTunnel(["ssh"], { stderrLine: line => { seen.push(line); return !line.startsWith("debug1: "); } });
    expect(await child.stderr!).toBe("Host key verification failed.\npartial\n");
    expect(kills).toEqual([]);
    expect(seen).toHaveLength(4_002);
  });

  test("pieces of one overlong line inherit the first piece's decision: a debug1 line never classifies", async () => {
    const kills: string[] = [];
    const seen: string[] = [];
    // Delivered in chunks, so the runner has to split the line before it sees its newline.
    const chunks = ["debug1: " + "a".repeat(20_000), " Permission denied (publickey).", "\nHost key verification failed.\n"];
    const child = createSshRunner({ spawn: spawnWith(chunks, kills) })
      .spawnTunnel(["ssh"], { stderrLine: line => { seen.push(line); return !line.startsWith("debug1: "); } });
    expect(await child.stderr!).toBe("Host key verification failed.\n");
    // Only the first piece and the next line reach the tap; the continuation inherits "not kept".
    expect(seen).toHaveLength(2);
    expect(seen[0]!.startsWith("debug1: ")).toBe(true);
  });

  test("a final unterminated kept line still counts against the cap", async () => {
    const kills: string[] = [];
    const text = ("x".repeat(1_000) + "\n").repeat(63) + "y".repeat(5_000);
    const child = createSshRunner({ spawn: spawnWith(text, kills) }).spawnTunnel(["ssh"], { stderrLine: () => true });
    await expect(child.stderr!).rejects.toThrow("ssh output exceeded");
  });
});

describe("Child -L tunnel and SSH capture", () => {
  const spec = { linkId: LINK, alias: "home.example.test", tunnelPort: 19002, peerListenerPort: 19001 };

  test("disabled by default: the exact ERROR argv and no tap", async () => {
    const configDir = tempDir();
    const { runner, calls } = recordingRunner();
    const knownHostsFile = join(configDir, "link", "known_hosts");
    const handle = spawnClientLinkTunnel(spec, { configDir, knownHostsFile, runner, readProcessStartTime: () => "start" } as Parameters<typeof spawnClientLinkTunnel>[1]);
    calls[0]!.exit(0);
    await handle.stop();
    expect(calls[0]!.args).toBe(1);
    expect(calls[0]!.argv).toEqual(buildTunnelArgv({ alias: spec.alias, direction: "L", bindPort: 19002, targetPort: 19001, knownHostsFile }));
    expect(existsSync(sshCaptureDir(join(configDir, "link")))).toBe(false);
  });

  test("an open window spawns with DEBUG1 and a tap; stop returns to ERROR", async () => {
    const configDir = tempDir();
    const linkDirectory = join(configDir, "link");
    const knownHostsFile = join(linkDirectory, "known_hosts");
    const now = Date.UTC(2026, 10, 11);
    startSshCapture({ linkDirectory, now });
    const sshCapture = createSshCaptureOpener({ linkDirectory, now: () => now });
    const { runner, calls } = recordingRunner();
    const deps = { configDir, knownHostsFile, runner, sshCapture, readProcessStartTime: () => "start" } as Parameters<typeof spawnClientLinkTunnel>[1];
    const first = spawnClientLinkTunnel(spec, deps);
    calls[0]!.exit(0);
    await first.stop();
    expect(calls[0]!.argv).toEqual(buildTunnelArgv({ alias: spec.alias, direction: "L", bindPort: 19002, targetPort: 19001, knownHostsFile, logLevel: "DEBUG1" }));
    expect(calls[0]!.options?.stderrLine?.("debug1: Entering interactive session.")).toBe(false);
    stopSshCapture(linkDirectory, now);
    const second = spawnClientLinkTunnel(spec, deps);
    calls[1]!.exit(0);
    await second.stop();
    expect(calls[1]!.args).toBe(1);
    expect(calls[1]!.argv).toContain("LogLevel=ERROR");
  });
});

