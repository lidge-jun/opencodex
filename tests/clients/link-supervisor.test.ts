import { expect, test } from "bun:test";
import { createLinkSupervisor } from "../../src/link/supervisor";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import type { LinkStore } from "../../src/link/store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function record(direction: "hub-initiated" | "client-initiated", id: string) {
  return {
    id,
    alias: `${id}.example`,
    direction,
    hostKeyFingerprint: direction === "client-initiated" ? null : "SHA256:abcdefghijklmnop",
    tunnelPort: 19002,
    apiKeyId: `${id}-key`,
    createdAt: "2026-09-25T00:00:00.000Z",
  } as const;
}

function fakeRunner() {
  const children: Array<{ child: SshChild; resolve: (code: number) => void; stderr: string }> = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      const exit = deferred<number>();
      const item = { stderr: "", resolve: exit.resolve, child: undefined as unknown as SshChild };
      item.child = {
        pid: 400 + children.length,
        argv: [...argv],
        exited: exit.promise,
        stderr: Promise.resolve().then(() => item.stderr),
        kill: () => exit.resolve(143),
      };
      children.push(item);
      return item.child;
    },
  };
  return { runner, children };
}

function baseStore(...links: LinkStore["links"]): LinkStore {
  return { version: 1, listenerPort: 19001, links };
}

test("spawns only hub links with the exact reverse forward argv", () => {
  const fake = fakeRunner();
  const store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  expect(fake.children).toHaveLength(1);
  const argv = fake.children[0]!.child.argv;
  expect(argv).toContain("-R");
  expect(argv).toContain("127.0.0.1:19002:127.0.0.1:19001");
  expect(argv).toContain("ExitOnForwardFailure=yes");
  expect(supervisor.status()[0]!.state).toEqual({ kind: "connecting", since: expect.any(Number) });
  fake.children[0]!.resolve(143);
  return supervisor.stop();
});

test("reconnects transient network exits only after the injected timer is due", async () => {
  const fake = fakeRunner();
  const timers: Array<() => void> = [];
  let current = 0;
  const store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const supervisor = createLinkSupervisor({
    readStore: () => store,
    runner: fake.runner,
    pidfileDir: "/tmp/opencodex-link-supervisor-test",
    now: () => current,
    setTimer: callback => { timers.push(callback); return 1 as unknown as ReturnType<typeof setInterval>; },
    clearTimer: () => {},
    random: () => 0.5,
  });
  supervisor.start();
  fake.children[0]!.stderr = "connection refused";
  fake.children[0]!.resolve(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(supervisor.status()[0]!.state).toMatchObject({ kind: "reconnecting", retryAt: 1000 });
  current = 999;
  timers[0]!();
  expect(fake.children).toHaveLength(1);
  current = 1000;
  timers[0]!();
  expect(fake.children).toHaveLength(2);
  await supervisor.stop();
});

test("marks a live tunnel connected after the grace period or authenticated catalog request", async () => {
  const fake = fakeRunner();
  const timers: Array<() => void> = [];
  let current = 0;
  const store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const supervisor = createLinkSupervisor({
    readStore: () => store,
    runner: fake.runner,
    pidfileDir: "/tmp/opencodex-link-supervisor-test",
    now: () => current,
    setTimer: callback => { timers.push(callback); return 1 as unknown as ReturnType<typeof setInterval>; },
    clearTimer: () => {},
  });
  supervisor.start();
  expect(supervisor.status()[0]!.state).toMatchObject({ kind: "connecting" });
  supervisor.notifyAuthenticatedRequest!("lnk_0123456789abcdef-key");
  expect(supervisor.status()[0]!.state).toMatchObject({ kind: "connected" });
  await supervisor.stop();

  const second = fakeRunner();
  const grace = createLinkSupervisor({
    readStore: () => store,
    runner: second.runner,
    pidfileDir: "/tmp/opencodex-link-supervisor-test",
    now: () => current,
    setTimer: callback => { timers.push(callback); return 2 as unknown as ReturnType<typeof setInterval>; },
    clearTimer: () => {},
  });
  current = 0;
  grace.start();
  current = 5_000;
  timers.at(-1)!();
  expect(grace.status()[0]!.state).toMatchObject({ kind: "connected" });
  second.children[0]!.resolve(143);
  await grace.stop();
});

test("auth and host ownership failures do not retry, and client links stay client-owned", async () => {
  const fake = fakeRunner();
  const store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"), record("client-initiated", "lnk_fedcba9876543210"));
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  fake.children[0]!.stderr = "Permission denied";
  fake.children[0]!.resolve(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(supervisor.status()[0]!.state).toEqual({ kind: "failed", since: expect.any(Number), reason: "auth" });
  expect(supervisor.status()[1]).toMatchObject({ state: "client-owned", pid: null });
  await supervisor.stop();
});

test("reaps a pidfile only after an exact Linux argv match", () => {
  const fake = fakeRunner();
  const store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const pidfile = { version: 1 as const, linkId: store.links[0]!.id, pid: 99, argv: ["ssh", "-N"] };
  let killed = 0;
  const supervisor = createLinkSupervisor({
    readStore: () => store,
    runner: fake.runner,
    pidfileDir: "/tmp/opencodex-link-supervisor-test",
    readPidfile: () => pidfile,
    readProcessArgv: () => ["ssh", "-N"],
    killProcess: () => { killed += 1; },
    platform: "linux",
  });
  supervisor.start();
  expect(killed).toBe(1);
  fake.children[0]!.resolve(143);
  return supervisor.stop();
});

test("reload spawns a newly added hub link with the reverse forward argv", async () => {
  const fake = fakeRunner();
  let store = baseStore();
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  await supervisor.reload();
  expect(fake.children).toHaveLength(1);
  expect(fake.children[0]!.child.argv).toContain("-R");
  expect(fake.children[0]!.child.argv).toContain("127.0.0.1:19002:127.0.0.1:19001");
  fake.children[0]!.resolve(143);
  await supervisor.stop();
});

test("reload stops a child whose link record was removed", async () => {
  const fake = fakeRunner();
  let store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  store = baseStore();
  await supervisor.reload();
  await expect(fake.children[0]!.child.exited).resolves.toBe(143);
  expect(supervisor.status()).toEqual([]);
  await supervisor.stop();
});

test("reload kills the old child and respawns when a link tunnel port changes", async () => {
  const fake = fakeRunner();
  let store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  const oldChild = fake.children[0]!.child;
  store = baseStore({ ...record("hub-initiated", "lnk_0123456789abcdef"), tunnelPort: 19003 });
  await supervisor.reload();
  expect(await oldChild.exited).toBe(143);
  expect(fake.children).toHaveLength(2);
  expect(fake.children[1]!.child.argv).toContain("127.0.0.1:19003:127.0.0.1:19001");
  fake.children[1]!.resolve(143);
  await supervisor.stop();
});

test("reload after stop is a no-op", async () => {
  const fake = fakeRunner();
  let store = baseStore();
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  await supervisor.stop();
  store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  await supervisor.reload();
  expect(fake.children).toHaveLength(0);
});

test("concurrent reload calls spawn a newly added link once", async () => {
  const fake = fakeRunner();
  let store = baseStore();
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  store = baseStore(record("hub-initiated", "lnk_0123456789abcdef"));
  await Promise.all([supervisor.reload(), supervisor.reload()]);
  expect(fake.children).toHaveLength(1);
  fake.children[0]!.resolve(143);
  await supervisor.stop();
});

test("a reload requested during a reload runs once after the current reload", async () => {
  const fake = fakeRunner();
  const first = record("hub-initiated", "lnk_0123456789abcdef");
  const second = record("hub-initiated", "lnk_fedcba9876543210");
  let store = baseStore(first);
  const supervisor = createLinkSupervisor({ readStore: () => store, runner: fake.runner, pidfileDir: "/tmp/opencodex-link-supervisor-test" });
  supervisor.start();
  store = baseStore(second);
  const firstReload = supervisor.reload();
  await Promise.resolve();
  store = baseStore(second, { ...record("hub-initiated", "lnk_abcdef0123456789"), tunnelPort: 19003 });
  const secondReload = supervisor.reload();
  fake.children[0]!.resolve(143);
  await Promise.all([firstReload, secondReload]);
  expect(fake.children).toHaveLength(3);
  await supervisor.stop();
});

test("reconciles unowned link keys at supervisor start without logging secrets", async () => {
  const fake = fakeRunner();
  const revoked: string[] = [];
  const warnings: string[] = [];
  const store = baseStore({ ...record("client-initiated", "lnk_0123456789abcdef"), apiKeyId: "kept-key" });
  const supervisor = createLinkSupervisor({
    readStore: () => store,
    runner: fake.runner,
    pidfileDir: "/tmp/opencodex-link-supervisor-test",
    apiKeys: () => [
      { id: "orphan-key", name: "link:old" },
      { id: "kept-key", name: "link:home" },
      { id: "other-key", name: "other" },
    ],
    revokeApiKey: id => { revoked.push(id); return true; },
    warn: message => warnings.push(message),
  });
  await supervisor.ensureStarted();
  expect(revoked).toEqual(["orphan-key"]);
  expect(warnings[0]).toContain("orphan-key");
  expect(warnings[0]).not.toContain("link:old");
  await supervisor.stop();
});
