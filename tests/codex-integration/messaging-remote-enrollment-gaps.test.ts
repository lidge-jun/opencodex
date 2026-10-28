import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildExecArgv, buildFingerprintArgv, buildProbeArgv, buildTunnelArgv, quoteRemote,
  remoteOcxArgv } from "../../src/link/ssh-argv";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { enrollRemoteHost, handleEnrollmentControl, probeRemoteHost, type RemoteControlRunner } from "../../src/messaging/remote-enrollment";
import { readRemoteFile, writeRemoteFile } from "../../src/messaging/remote-files";
import { startRemoteTunnels, type RemoteTunnelPair } from "../../src/messaging/remote-tunnels";
import { LOCAL_TARGET } from "../helpers/messaging-local";
import { remoteMessagingPair } from "../helpers/messaging-remote";

const fingerprint = "SHA256:fixture";
const pinnedPath = (argv: readonly string[]) => argv.find(arg => arg.startsWith("UserKnownHostsFile="))!.slice(19);
const scratchFiles = (directory: string) => readdirSync(directory).filter(name => name.startsWith("enrollment_known_hosts-"));

test.skipIf(process.platform === "win32")("enrollment scratch is published only while the mutation lock is held and consumed after release", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  pair.aStore.mutate(state => { state.peers = []; });
  pair.bStore.mutate(state => { state.peers = []; });
  const lock = join(pair.aStore.directory, "mutation.lock"), key = "fixture ssh-ed25519 Zml4dHVyZQ==\n";
  const consumed: string[] = [];
  let probes = 0, controls = 0;
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    if (argv[0] === "ssh-keygen") return `256 ${fingerprint} fake (ED25519)\n`;
    const path = pinnedPath(argv);
    if (stdin === undefined) { probes++; writeRemoteFile(path, key); return ""; }
    controls++;
    const request = JSON.parse(stdin), transaction = request.params.transaction;
    consumed.push(path);
    expect(existsSync(lock)).toBe(false);
    expect(basename(path)).toMatch(new RegExp(`^enrollment_known_hosts-${transaction}-[0-9a-f-]{36}$`));
    expect(scratchFiles(pair.aStore.directory)).toEqual([basename(path)]);
    expect(readRemoteFile(path)).toBe(key);
    return JSON.stringify(handleEnrollmentControl(pair.bStore, request));
  };
  try {
    // Locks fail closed immediately, rather than queuing an enrollment until release.
    // Probe/fingerprint run before the journal lock; only the control runner is barred.
    // There is no await between journal publication and scratch publication, so an
    // external owner cannot enter that second boundary deterministically. The precise
    // publication-under-lock guarantee needs static inspection of remote-enrollment.ts.
    mkdirSync(lock, { mode: 0o700 });
    await expect(enrollRemoteHost(pair.aStore, "worker", "fixture", fingerprint, budget, capacity, runner))
      .rejects.toMatchObject({ code: "remote_state_busy" });
    expect(probes).toBe(1);
    expect(controls).toBe(0);
    expect(scratchFiles(pair.aStore.directory)).toEqual([]);
    expect(readRemoteFile(join(pair.aStore.directory, "enrollment.json"))).toBeNull();
    expect(pair.aStore.requireEnabled().peers).toEqual([]);
    expect(pair.bStore.requireEnabled().peers).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    rmdirSync(lock);

    expect(await enrollRemoteHost(pair.aStore, "worker", "fixture", fingerprint, budget, capacity, runner))
      .toMatchObject({ enrolled: true, inbound: "responses-only", outbound: "messages" });
    expect(controls).toBe(1);
    expect(consumed).toHaveLength(1);
    expect(readRemoteFile(consumed[0]!)).toBeNull();
    expect(scratchFiles(pair.aStore.directory)).toEqual([]);
    expect(existsSync(lock)).toBe(false);
    expect(pair.aStore.peer("worker").hostKey).toBe(key);
    expect(pair.bStore.requireEnabled().peers).toHaveLength(1);
    for (const fixture of [pair.a, pair.b]) {
      expect(fixture.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
      expect(fixture.activeConnections).toBe(0);
      expect(fixture.failures).toEqual([]);
    }
  } finally { if (existsSync(lock)) rmdirSync(lock); budget.dispose(); await pair.close(); }
});

test.skipIf(process.platform === "win32")("messaging SSH consumers pass hostile aliases and arguments only through the shared argv builder", async () => {
  const pair = remoteMessagingPair(), budget = new MessageBudget(), capacity = new RemoteCapacity();
  const ssh = "fixture_@[%+]:-node", key = `${ssh} ssh-ed25519 Zml4dHVyZQ==\n`;
  const name = `node '; $(printf hostile) & | > ${LOCAL_TARGET}`;
  pair.aStore.mutate(state => { state.peers = []; state.machine.name = name; });
  pair.bStore.mutate(state => { state.peers = []; });
  const captured: { argv: string[]; stdin?: string }[] = [];
  const runner: RemoteControlRunner = async (argv, _budget, _capacity, stdin) => {
    captured.push({ argv: [...argv], stdin });
    if (argv[0] === "ssh-keygen") return `256 ${fingerprint} fake (ED25519)\n`;
    if (stdin === undefined) { writeRemoteFile(pinnedPath(argv), key); return ""; }
    return JSON.stringify(handleEnrollmentControl(pair.bStore, JSON.parse(stdin)));
  };
  const owner = new AbortController(), spawned: string[][] = [], retired: string[] = [];
  let listener: ReturnType<typeof Bun.listen> | undefined, tunnels: RemoteTunnelPair | undefined;
  try {
    expect(await enrollRemoteHost(pair.aStore, "worker", ssh, fingerprint, budget, capacity, runner)).toHaveProperty("enrolled", true);
    expect(captured).toHaveLength(3);
    const probe = captured[0]!, control = captured[2]!, probePath = pinnedPath(probe.argv);
    expect(probe.argv).toEqual(buildProbeArgv({ alias: ssh, tempKnownHostsFile: probePath }));
    expect(captured[1]!.argv).toEqual(buildFingerprintArgv(probePath));
    expect(control.argv).toEqual(buildExecArgv({ alias: ssh, knownHostsFile: pinnedPath(control.argv),
      argv: remoteOcxArgv(["message", "_control"]) }));
    expect(probe.argv.slice(-3)).toEqual(["--", ssh, "echo ocx-link-probe"]);
    expect(control.argv.slice(-3, -1)).toEqual(["--", ssh]);
    expect(control.argv.at(-1)).toStartWith("sh '-c' '");
    expect(control.argv.at(-1)).toEndWith("'ocx' 'message' '_control'");
    expect(control.argv.join(" ")).not.toContain(name);
    expect(JSON.parse(control.stdin!).params.machine.name).toBe(name);
    expect(pair.bStore.peer(pair.aStore.requireEnabled().machine.id).machine.name).toBe(name);

    // Consumer commands are fixed and transactions are UUIDs, not shell arguments.
    // Exercise arbitrary metacharacters only at the builder's actual argv seam.
    const hostile = "a';$(printf hostile)&|> spaced";
    const quoted = "'a'\"'\"';$(printf hostile)&|> spaced'";
    expect(quoteRemote(["sh", "-c", hostile])).toBe(`sh '-c' ${quoted}`);
    expect(buildExecArgv({ alias: ssh, knownHostsFile: pinnedPath(control.argv), argv: remoteOcxArgv(["message", hostile]) }).at(-1))
      .toEndWith(`'ocx' 'message' ${quoted}`);

    const peer = pair.aStore.peer("worker"), knownHosts = join(pair.aStore.directory, `${peer.machine.id}.known_hosts`);
    const tunnelRuns: string[][] = [];
    tunnels = await startRemoteTunnels(pair.aStore, peer, budget, capacity, owner.signal, {
      run: async argv => { tunnelRuns.push([...argv]); return JSON.stringify({ port: pair.bStore.requireEnabled().port }); },
      spawn: argv => {
        spawned.push([...argv]);
        const direction = argv.includes("-L") ? "L" : "R";
        if (direction === "L") {
          const port = Number(argv[argv.indexOf("-L") + 1]!.split(":")[1]);
          listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data(socket) { socket.end(); } } });
        }
        let finish!: (code: number) => void, closed = false;
        const exited = new Promise<number>(resolve => { finish = resolve; });
        return { pid: 0, exited, output: Promise.resolve(""), async close() {
          if (closed) return;
          closed = true; retired.push(direction);
          if (direction === "L") listener?.stop(true);
          finish(0);
        } };
      },
    });
    expect(tunnelRuns).toEqual([buildExecArgv({ alias: ssh, knownHostsFile: knownHosts, argv: remoteOcxArgv(["message", "_port"]) })]);
    expect(tunnelRuns[0]!.at(-1)).toEndWith("'ocx' 'message' '_port'");
    expect(readRemoteFile(knownHosts)).toBe(key);
    expect(spawned).toEqual([
      buildTunnelArgv({ alias: ssh, knownHostsFile: knownHosts, direction: "L", bindPort: tunnels.localPort, targetPort: peer.port }),
      buildTunnelArgv({ alias: ssh, knownHostsFile: knownHosts, direction: "R", bindPort: tunnels.returnPort, targetPort: pair.aStore.requireEnabled().port }),
    ]);
    for (const argv of [control.argv, ...tunnelRuns, ...spawned]) {
      for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "GlobalKnownHostsFile=none", "KnownHostsCommand=none"]) {
        expect(argv).toContain(option);
      }
      expect(argv).toContain(`HostKeyAlias=${ssh}`);
    }
    expect(tunnels.alive).toBe(true);
    owner.abort();
    await tunnels.close();
    await tunnels.exited;
    expect(tunnels.alive).toBe(false);
    expect(retired.sort()).toEqual(["L", "R"]);
    await expect(Bun.connect({ hostname: "127.0.0.1", port: tunnels.localPort,
      socket: { data(socket) { socket.end(); } } })).rejects.toThrow();

    for (const invalid of ["-option", "two hosts", "host;command"]) {
      const calls = captured.length, runs = tunnelRuns.length, spawns = spawned.length;
      await expect(probeRemoteHost(invalid, budget, capacity, runner)).rejects.toMatchObject({ code: "invalid_ssh_alias" });
      await expect(enrollRemoteHost(pair.aStore, "other", invalid, fingerprint, budget, capacity, runner))
        .rejects.toMatchObject({ code: "invalid_enrollment" });
      await expect(startRemoteTunnels(pair.aStore, { ...peer, ssh: invalid }, budget, capacity, new AbortController().signal, {
        run: async argv => { tunnelRuns.push([...argv]); throw new Error("unexpected SSH runner"); },
        spawn: argv => { spawned.push([...argv]); throw new Error("unexpected SSH spawn"); },
      })).rejects.toMatchObject({ name: "LinkSshArgumentError" });
      expect(captured).toHaveLength(calls);
      expect(tunnelRuns).toHaveLength(runs);
      expect(spawned).toHaveLength(spawns);
    }
    for (const fixture of [pair.a, pair.b]) {
      expect(fixture.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(0);
      expect(fixture.activeConnections).toBe(0);
      expect(fixture.failures).toEqual([]);
    }
  } finally { owner.abort(); await tunnels?.close(); listener?.stop(true); budget.dispose(); await pair.close(); }
});
