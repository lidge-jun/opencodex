import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { messageCodexHome, messageCodexRuntime } from "../../src/cli/message-runtime";
import { skipsCodexShimAutoRestore } from "../../src/cli/codex-shim-autorestore";
import { CAPABILITIES } from "../../src/cli/capabilities";
import { MessageBudget } from "../../src/messaging/budget";
import { runMessageProcess } from "../../src/messaging/process";
import { LOCAL_TARGET, localMessagingFixture } from "../helpers/messaging-local";
import { repoPath } from "../helpers/repo-root";

test("command is local-only in registry and skips global repair even on malformed usage", () => {
  expect(skipsCodexShimAutoRestore("message", ["message", "unknown"])).toBe(true);
  const caps = CAPABILITIES.filter(cap => cap.command[0] === "message");
  expect(caps.map(cap => cap.command[1])).toEqual(["sessions", "send"]);
  expect(caps.every(cap => cap.routes.length === 0)).toBe(true);
  expect(caps[1]!.mutates).toBe(true);
  expect(caps[1]!.flags.map(flag => flag.name)).not.toContain("--host");
});

test("invalid usage allocates no timer, socket, helper or runtime-selection work", async () => {
  const script = `
    const { runMessageCommand } = await import(${JSON.stringify(repoPath("src/cli/message-command.ts"))});
    const fail = () => { throw new Error('Unexpected resource allocation'); };
    globalThis.setTimeout = fail; Bun.spawn = fail; globalThis.WebSocket = class { constructor() { fail(); } };
    process.exitCode = await runMessageCommand(['send', '--host', 'remote', '--stdin'], { CODEX_HOME: '/must-not-read' });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).toBe(64); expect(output).toBe(""); expect(errors).toContain("Usage: ocx message");
  expect(errors).not.toContain("Unexpected resource allocation");
});

test.skipIf(process.platform === "win32")("real CLI resolves effective home/runtime, emits one private-body-free receipt and no repair", async () => {
  const fixture = localMessagingFixture();
  const launcher = join(fixture.root, "native fixture launcher");
  const record = join(fixture.root, "native-calls.jsonl");
  const env = { PATH: process.env.PATH, HOME: fixture.root, CODEX_HOME: fixture.codexHome,
    OPENCODEX_HOME: join(fixture.root, "ocx"), CODEX_CLI_PATH: launcher,
    OPENAI_API_KEY: "private-fixture-key", OCX_TEST_HOME_GUARD: "1" };
  const help = "Usage: codex queue [OPTIONS] --thread <THREAD> --message <TEXT>\n  --thread <THREAD>\n  --message <TEXT>\n  --remote <ADDR>\nunix://PATH";
  await Bun.write(launcher, `#!${process.execPath}\n
    const args = process.argv.slice(2);
    const fs = await import('node:fs');
    fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({args, home: process.env.CODEX_HOME, bypass: process.env.OCX_SHIM_BYPASS, keyPresent: Boolean(process.env.OPENAI_API_KEY)})+'\\n');
    console.log(args.includes('--version') ? 'codex-cli 0.160.0' : args.includes('--help') ? ${JSON.stringify(help)} : 'PRIVATE native output');
  `);
  chmodSync(launcher, 0o700);
  const budget = new MessageBudget();
  try {
    expect(messageCodexHome(env)).toBe(fixture.codexHome);
    expect(messageCodexRuntime(env).argv(["queue", "--thread", LOCAL_TARGET])).toEqual([launcher, "queue", "--thread", LOCAL_TARGET]);
    const cli = [process.execPath, repoPath("src/cli/index.ts"), "message"];
    const directory = await runMessageProcess([...cli, "sessions", "--json"], budget, { env });
    expect(directory.exitCode).toBe(0);
    expect(JSON.parse(directory.stdout).sessions).toEqual([{ id: LOCAL_TARGET, name: "recipient", status: "idle" }]);
    expect(existsSync(record)).toBe(false); // Discovery has no native helper probe.
    const result = await runMessageProcess([...cli, "send", "--name", "recipient", "--kind", "notification", "--stdin", "--json"],
      budget, { env, stdin: "PRIVATE body from stdin" });
    expect(result.exitCode).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.status).toBe("queued"); expect(receipt.target.threadId).toBe(LOCAL_TARGET);
    expect(result.stdout).not.toContain("PRIVATE");
    const calls = readFileSync(record, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(calls).toHaveLength(3);
    expect(calls[2].args.slice(0, 3)).toEqual(["queue", "--thread", LOCAL_TARGET]);
    expect(calls[2].args.slice(-2)).toEqual(["--remote", fixture.nativeUrl]);
    expect(calls.every(call => !call.keyPresent && call.bypass === "1" && !existsSync(call.home))).toBe(true);
    expect(existsSync(join(env.OPENCODEX_HOME, "codex-runtime.json"))).toBe(false);
    expect(fixture.failures).toEqual([]);
  } finally { budget.dispose(); await fixture.close(); }
}, 30_000);
