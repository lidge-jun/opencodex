import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity } from "../../src/messaging/remote-contract";
import { enrollRemoteHost, probeRemoteHost } from "../../src/messaging/remote-enrollment";
import { startRemoteOwner } from "../../src/messaging/remote-owner";
import { remotePortCandidate } from "../../src/messaging/remote-ports";
import { runRemoteHelper, spawnRemoteHelper } from "../../src/messaging/remote-process";
import { sendRemoteMessage } from "../../src/messaging/remote-send";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { LOCAL_OTHER, LOCAL_TARGET } from "../helpers/messaging-local";
import { repoPath } from "../helpers/repo-root";

// Opt-in binds a disposable sshd, generates fixture keys, and never reads user SSH config/agent.
const requested = process.env.OCX_MESSAGE_SSH_INTEROP === "1";
test.skipIf(!requested || process.platform !== "linux")("isolated real SSH enrollment and duplex message/reply join every owned helper", async () => {
  const pair = remoteMessagingPair(), capacity = new RemoteCapacity(), budget = new MessageBudget(), root = join(pair.a.root, "ssh");
  mkdirSync(root, { mode: 0o700 });
  pair.aStore.mutate(state => { state.peers = []; }); pair.bStore.mutate(state => { state.peers = []; });
  const key = join(root, "identity"), hostKey = join(root, "host"), authorized = join(root, "authorized_keys");
  let sshd: ReturnType<typeof spawnRemoteHelper> | undefined;
  let aOwner: Awaited<ReturnType<typeof startRemoteOwner>> | undefined;
  let bOwner: Awaited<ReturnType<typeof startRemoteOwner>> | undefined;
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  try {
    await runRemoteHelper(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key], budget, capacity);
    await runRemoteHelper(["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", hostKey], budget, capacity);
    writeFileSync(authorized, await Bun.file(`${key}.pub`).text(), { mode: 0o600 });
    const bin = join(root, "bin"); mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, "ocx"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(repoPath("src/cli/index.ts"))} "$@"\n`, { mode: 0o700 });
    const login = join(root, "login");
    writeFileSync(login, `#!/bin/sh\nexport HOME=${quote(pair.b.root)}\nexport OPENCODEX_HOME=${quote(join(pair.b.root, "ocx"))}\nexport CODEX_HOME=${quote(pair.b.codexHome)}\nexport PATH=${quote(`${bin}:/usr/bin:/bin`)}\nexport OCX_TEST_HOME_GUARD=1\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`, { mode: 0o700 });
    const port = remotePortCandidate(), sshdConfig = join(root, "sshd.conf");
    // OpenSSH's authorized-key ancestor check does not exempt sticky /tmp. The fixture
    // alone disables that check; generated keys and the entire private fixture remain mode 0700/0600.
    writeFileSync(sshdConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${join(root, "sshd.pid")}\nAuthorizedKeysFile ${authorized}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding yes\nGatewayPorts no\nForceCommand ${login}\n`, { mode: 0o600 });
    sshd = spawnRemoteHelper(["/usr/sbin/sshd", "-D", "-E", join(root, "sshd.log"), "-f", sshdConfig], capacity);
    const config = join(root, "ssh.conf");
    writeFileSync(config, `Host fixture\n  HostName 127.0.0.1\n  Port ${port}\n  User ${userInfo().username}\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  IdentityAgent none\n`, { mode: 0o600 });
    const argv = (value: readonly string[]) => value[0] === "ssh" ? ["/usr/bin/ssh", "-F", config, ...value.slice(1)] : [...value];
    const run: typeof runRemoteHelper = (args, time, caps, input) => runRemoteHelper(argv(args), time, caps, input);
    const spawn: typeof spawnRemoteHelper = (args, caps, signal, input) => spawnRemoteHelper(argv(args), caps, signal, input);
    await Bun.sleep(100);
    bOwner = await startRemoteOwner(pair.bStore, pair.b.codexHome, []);
    const offer = await probeRemoteHost("fixture", budget, capacity, run);
    const enrolled = await enrollRemoteHost(pair.aStore, "worker", "fixture", offer.fingerprint, budget, capacity, run);
    expect(enrolled.enrolled).toBe(true); expect(JSON.stringify(enrolled)).not.toContain(pair.aStore.peer("worker").outgoing);
    aOwner = await startRemoteOwner(pair.aStore, pair.a.codexHome, ["worker"], undefined, { run, spawn });
    const request = await sendRemoteMessage(pair.aStore, { host: "worker", thread: LOCAL_TARGET, kind: "request", body: "SSH fixture request" },
      { home: pair.a.codexHome, senderId: LOCAL_OTHER }, budget);
    expect(request.status).toBe("queued");
    const reply = await sendRemoteMessage(pair.bStore, { host: pair.aStore.requireEnabled().machine.id, thread: LOCAL_OTHER,
      kind: "response", inReplyTo: request.messageId, body: "SSH fixture response" }, { home: pair.b.codexHome, senderId: LOCAL_TARGET }, budget);
    expect(reply.status).toBe("queued");
    expect(pair.bStore.peer(pair.aStore.requireEnabled().machine.id).ssh).toBeNull();
    expect(pair.a.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    expect(pair.b.calls.filter(call => call.method === "thread/queue/add")).toHaveLength(1);
    expect(aOwner.capacity.snapshot().helpers).toBe(2);
  } catch (error) {
    // This is a fixture-owned sshd log containing no user credentials or message payloads.
    const log = await Bun.file(join(root, "sshd.log")).text().catch(() => "fixture sshd produced no log");
    throw new Error(`${error instanceof Error ? error.message : "SSH fixture failed"}\n${log.slice(-4096)}`);
  } finally {
    await aOwner?.close(); await bOwner?.close(); await sshd?.close(); budget.dispose(); await pair.close();
  }
  expect(aOwner?.capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
}, 45000);
