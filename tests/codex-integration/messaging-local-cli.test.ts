import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageCodexHome } from "../../src/cli/message-runtime";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { LOCAL_TARGET, LocalFixtureRpcError, localMessagingFixture, NO_REPLY } from "../helpers/messaging-local";
import { repoPath } from "../helpers/repo-root";

test("local commands stay registered and skip global repair even on malformed usage", () => {
  expect(skipsCodexShimAutoRestore("message", ["message", "unknown"])).toBe(true);
  const caps = CAPABILITIES.filter(cap => cap.command[0] === "message");
  expect(caps.map(cap => cap.command[1])).toContain("sessions");
  expect(caps.map(cap => cap.command[1])).toContain("send");
  expect(caps.every(cap => cap.routes.length === 0)).toBe(true);
  const send = caps.find(cap => cap.command[1] === "send");
  expect(send?.mutates).toBe(true);
  expect(send?.flags.map(flag => flag.name)).toContain("--host");
  const claude = caps.find(cap => cap.command[1] === "claude-sessions");
  expect(claude?.mutates).toBe(false);
  expect(claude?.flags.map(flag => flag.name)).toContain("--claude");
});

test("invalid usage allocates no timer, socket, helper or runtime-selection work", async () => {
  const script = `
    const { runMessageCommand } = await import(${JSON.stringify(repoPath("src/cli/message-command.ts"))});
    const fail = () => { throw new Error('Unexpected resource allocation'); };
    globalThis.setTimeout = fail; Bun.spawn = fail; globalThis.WebSocket = class { constructor() { fail(); } };
    globalThis.AbortController = class { constructor() { fail(); } };
    for (const args of [
      ['send', '--host', 'remote', '--stdin'],
      ['claude-sessions'],
      ['claude-sessions', '--claude', 'relative'],
      ['claude-sessions', '--claude', '/must-not-run', '--json', '--json'],
      ['claude-sessions', '--claude', '/must-not-run', '--claude', '/must-not-run'],
      ['claude-sessions', '--claude', '/must-not-run', '--host', 'remote'],
    ]) {
      if (await runMessageCommand(args, { CODEX_HOME: '/must-not-read' }) !== 64) {
        throw new Error('Expected invalid usage exit code');
      }
    }
    process.exitCode = 64;
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(64); expect(output).toBe(""); expect(errors).toContain("Usage: ocx message");
  expect(errors).not.toContain("Unexpected resource allocation");
});

test.skipIf(process.platform === "win32")("full CLI uses the daemon directly, emits safe receipts and preserves exit codes", async () => {
  for (const mode of ["queued", "unsupported", "rejected", "unknown", "unloaded"]) {
    let reads = 0;
    const fixture = localMessagingFixture(call => {
      if (call.method === "thread/read" && mode === "unloaded" && ++reads === 2) {
        return { thread: { id: LOCAL_TARGET, name: "recipient", status: { type: "notLoaded" } } };
      }
      if (call.method !== "thread/queue/add") return;
      if (mode === "unsupported") return new LocalFixtureRpcError(-32601, "PRIVATE remote error");
      if (mode === "rejected") return new LocalFixtureRpcError(-32000, "PRIVATE remote error");
      if (mode === "unknown") { fixture.closeConnections(); return NO_REPLY; }
    });
    const preload = join(fixture.root, "no-spawn.ts");
    await Bun.write(preload, `const fail = () => { throw new Error('Unexpected helper spawn'); }; Bun.spawn = fail; Bun.spawnSync = fail;`);
    const env = { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: fixture.codexHome,
      OPENCODEX_HOME: join(fixture.root, "ocx"), CODEX_CLI_PATH: "/nonexistent/native", OCX_TEST_HOME_GUARD: "1" };
    const cli = [process.execPath, "--preload", preload, repoPath("src/cli/index.ts"), "message"];
    const run = async (args: string[], stdin = "") => {
      const child = Bun.spawn([...cli, ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill(), 10_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        return { exitCode, stdout, stderr };
      } finally { clearTimeout(timer); }
    };
    try {
      expect(messageCodexHome(env)).toBe(fixture.codexHome);
      if (mode === "queued") {
        const directory = await run(["sessions", "--json"]);
        expect(directory.exitCode).toBe(0); expect(directory.stderr).toBe("");
        expect(JSON.parse(directory.stdout).sessions).toEqual([{ id: LOCAL_TARGET, name: "recipient", status: "idle" }]);
      }
      const result = await run(["send", "--name", "recipient", "--kind", "notification", "--stdin", "--json"], "PRIVATE body from stdin");
      expect(result.exitCode).toBe(mode === "queued" ? 0 : mode === "unknown" ? 3 : 1);
      expect(result.stderr).toBe(""); expect(result.stdout).not.toContain("PRIVATE");
      const receipt = JSON.parse(result.stdout);
      expect(receipt.status).toBe(mode === "queued" ? "queued" : mode === "unknown" ? "unknown" : "not_sent");
      expect(receipt.target.threadId).toBe(LOCAL_TARGET);
      const calls = fixture.calls.filter(call => call.method === "thread/queue/add");
      expect(calls).toHaveLength(mode === "unloaded" ? 0 : 1);
      if (mode !== "unloaded") expect(calls[0]!.params.clientUserMessageId).toBe(receipt.messageId);
      expect(existsSync(join(env.OPENCODEX_HOME, "codex-runtime.json"))).toBe(false);
      expect(fixture.connectionCount).toBe(mode === "queued" ? 2 : 1);
      expect(fixture.failures).toEqual([]);
    } finally { await fixture.close(); }
  }
}, 30_000);

test.skipIf(process.platform === "win32")("Claude discovery projects live sessions and sanitizes failed lookups", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-claude-sessions-"));
  const executable = join(root, "fake claude");
  const responsePath = join(root, "response.json");
  const failPath = join(root, "fail");
  const hangPath = join(root, "hang");
  const env = {
    PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "codex"),
    OPENCODEX_HOME: join(root, "ocx"), OCX_TEST_HOME_GUARD: "1",
    ANTHROPIC_API_KEY: "fixture-private-env",
  };
  const cli = [process.execPath, repoPath("src/cli/index.ts"), "message", "claude-sessions"];
  const run = async (args: string[]) => {
    const child = Bun.spawn([...cli, ...args], {
      env, stdin: new Blob(["fixture-private-stdin\n"]), stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 10_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally { clearTimeout(timer); }
  };
  try {
    writeFileSync(executable, `#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = agents ] && [ "$2" = --json ] || exit 40
if IFS= read -r line; then exit 41; fi
[ -z "$ANTHROPIC_API_KEY" ] || exit 44
printf '%s\\n' fixture-private-stderr >&2
/bin/cat "\${0%/*}/response.json" || exit 42
if [ -f "\${0%/*}/fail" ]; then exit 43; fi
if [ -f "\${0%/*}/hang" ]; then exec /bin/sleep 30; fi
`, { mode: 0o700 });
    const records = [
      { sessionId: "1111111A-1111-4111-8111-111111111111", pid: 123, kind: "interactive", status: "busy", cwd: "/fixture-private-cwd" },
      { sessionId: "22222222-2222-4222-8222-222222222222", pid: 456, kind: "background", status: "idle", name: "fixture-private-name" },
      { sessionId: "33333333-3333-4333-8333-333333333333", pid: 789, kind: "interactive", status: "waiting", summary: "fixture-private-summary" },
    ];
    writeFileSync(responsePath, JSON.stringify([
      ...records, { sessionId: LOCAL_TARGET, summary: "fixture-private-stopped" }, { pid: 987, status: "busy" },
    ]));
    const args = ["--claude", executable];
    const json = await run([...args, "--json"]);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe("");
    expect(JSON.parse(json.stdout)).toEqual({
      schema: "ocx-claude-sessions/1",
      sessions: records.map(({ sessionId, kind, status }) => ({ id: sessionId.toLowerCase(), kind, status })),
    });
    const human = await run(args);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).not.toContain("fixture-private");
    for (const { sessionId, kind, status } of records) {
      expect(human.stdout).toContain(`${sessionId.toLowerCase()}\t${kind}\t${status}\n`);
    }

    const expectFailure = async (path = executable) => {
      const result = await run(["--claude", path, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("fixture-private");
      expect(result.stdout).not.toContain(root);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema: "ocx-message-error/1", error: { message: expect.any(String) },
      });
    };
    writeFileSync(responsePath, "[]");
    const empty = await run([...args, "--json"]);
    expect(empty.exitCode).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ schema: "ocx-claude-sessions/1", sessions: [] });
    const first = records[0]!;
    for (const response of [
      "fixture-private-invalid-json",
      JSON.stringify({ sessions: records }),
      JSON.stringify([records[0], { ...records[1], pid: 0 }]),
      JSON.stringify([records[0], { ...records[1], sessionId: "fixture-private-invalid-id" }]),
      JSON.stringify([records[0], { ...records[1], kind: "fixture-private-invalid-kind" }]),
      JSON.stringify([records[0], { ...records[1], status: "fixture-private-invalid-status" }]),
      JSON.stringify([first, { ...first, sessionId: first.sessionId.toLowerCase() }]),
      JSON.stringify(Array.from({ length: 257 }, () => ({}))),
      " ".repeat(256 * 1024) + "[]",
    ]) {
      writeFileSync(responsePath, response);
      await expectFailure();
    }
    writeFileSync(responsePath, "[]");
    writeFileSync(failPath, "");
    await expectFailure();
    await expectFailure(join(root, "missing executable"));
    rmSync(failPath);
    writeFileSync(hangPath, "");
    await expectFailure();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
