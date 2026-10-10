import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MessageBudget } from "../../src/messaging/budget";
import { RemoteCapacity, remoteError } from "../../src/messaging/remote-contract";
import { runRemoteHelper, spawnRemoteHelper } from "../../src/messaging/remote-process";
import { startRemoteOwner } from "../../src/messaging/remote-owner";
import { remoteMessagingPair } from "../helpers/messaging-remote";
import { parseRemoteMessageArgs } from "../../src/cli/message-remote-args";
import { repoPath } from "../helpers/repo-root";

test("every remote module remains inert on import", async () => {
  const modules = ["contract", "files", "store", "process", "auth", "rpc-admission", "bridge", "ports", "tunnels", "owner", "enrollment", "send"];
  const script = `const fail = () => { throw new Error("unexpected activation"); };
    globalThis.setTimeout = fail; globalThis.setInterval = fail; Bun.spawn = fail; Bun.serve = fail; Bun.listen = fail;
    globalThis.WebSocket = class { constructor() { fail(); } };
    for (const file of JSON.parse(process.argv[1])) await import(file);`;
  const child = Bun.spawn([process.execPath, "-e", script, JSON.stringify(modules.map(name => repoPath(`src/messaging/remote-${name}.ts`)))], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(0); expect(out).toBe(""); expect(err).toBe("");
  expect(readFileSync(repoPath("src/cli/message-command.ts"), "utf8")).toContain('if (remote) return (await import("./message-remote-command"))');
});

for (const rejectCleanup of [false, true]) {
  test.skipIf(process.platform === "win32")(`unpublished tunnels join both helpers on generation change (cleanup rejection=${rejectCleanup})`, async () => {
    const pair = remoteMessagingPair(), closes: (() => Promise<void>)[] = [], completed: number[] = [];
    pair.aStore.mutate(state => { Object.assign(state.peers[0]!, { ssh: "fixture", hostKey: "fixture ssh-ed25519 Zml4dHVyZQ==\n", fingerprint: "SHA256:fixture" }); });
    try {
      const result = startRemoteOwner(pair.aStore, pair.a.codexHome, ["worker"], undefined, {
        run: async () => JSON.stringify({ port: pair.bStore.requireEnabled().port }),
        spawn: (argv, capacity) => {
          const index = closes.length, free = capacity.reserve("helpers");
          const forward = argv.indexOf("-L");
          const listener = forward >= 0 ? Bun.listen({ hostname: "127.0.0.1", port: Number(argv[forward + 1]!.split(":")[1]), socket: { data(socket) { socket.end(); } } }) : undefined;
          let finish!: (code: number) => void, closing: Promise<void> | undefined;
          const exited = new Promise<number>(resolve => { finish = resolve; });
          const close = () => closing ??= (async () => {
            await Bun.sleep(index === 0 ? 10 : 80);
            listener?.stop(true); completed.push(index); free(); finish(0);
            if (rejectCleanup && index === 0) throw remoteError("cleanup_incomplete", "fixture cleanup incomplete");
          })();
          closes.push(close);
          if (index === 1) pair.aStore.mutate(state => { state.generation = crypto.randomUUID(); });
          return { pid: 0, exited, output: Promise.resolve(""), close };
        },
      });
      await expect(result).rejects.toThrow(rejectCleanup ? "fixture cleanup incomplete" : "configuration changed");
      expect(completed.sort()).toEqual([0, 1]);
    } finally { await Promise.allSettled(closes.map(close => close())); await pair.close(); }
  });
}

test("remote parser rejects ambiguous/malformed usage without runtime allocation", () => {
  for (const args of [["enable", "--port", "80"], ["serve", "--host", "a", "--host", "a"],
    ["hosts", "add", "bad alias", "--ssh", "fixture", "--fingerprint", "SHA256:fixture"],
    ["hosts", "probe", "--ssh", "-option"], ["send", "--host", "worker", "--stdin"],
    ["sessions", "--host", "worker", "--host", "other"], ["status", "--token", "secret"]]) expect(parseRemoteMessageArgs(args)).toBeNull();
  expect(parseRemoteMessageArgs(["sessions", "--host", "worker", "--json"])?.action).toBe("remote-operation");
  expect(parseRemoteMessageArgs(["serve", "--host", "a", "--host", "b"])?.action).toBe("serve");
  expect(parseRemoteMessageArgs(["sessions", "--json"])).toBeNull();
});

test.skipIf(process.platform === "win32")("helper cancellation joins TERM/KILL cleanup, releases aggregate reservations and never prints stderr", async () => {
  const controller = new AbortController(), budget = new MessageBudget(1000, controller.signal), capacity = new RemoteCapacity();
  const result = runRemoteHelper([process.execPath, "-e", 'process.on("SIGTERM", () => {}); console.error("private fixture diagnostic"); setInterval(() => {}, 1000)'], budget, capacity);
  const settled = result.catch(error => error);
  await Bun.sleep(50); controller.abort();
  const error = await settled; expect(error.message).not.toContain("private");
  expect(error.code).toBe("cancelled"); expect(capacity.snapshot()).toEqual({ connections: 0, requests: 0, helpers: 0, outputBytes: 0 });
  budget.dispose();
});

test.skipIf(process.platform === "win32")("idempotent close shares one cleanup flight and bounded capture refuses overflow", async () => {
  const capacity = new RemoteCapacity();
  const helper = spawnRemoteHelper([process.execPath, "-e", 'setInterval(() => {}, 1000)'], capacity);
  expect(helper.close()).toBe(helper.close()); await helper.close();
  const budget = new MessageBudget();
  try { await expect(runRemoteHelper([process.execPath, "-e", 'console.log("x".repeat(65537))'], budget, capacity)).rejects.toThrow("safely"); }
  finally { budget.dispose(); }
  expect(capacity.snapshot().helpers).toBe(0); expect(capacity.snapshot().outputBytes).toBe(0);
});
