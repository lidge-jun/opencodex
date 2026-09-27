import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecArgv,
  buildProbeArgv,
  buildTunnelArgv,
  LinkSshArgumentError,
  quoteRemote,
  REMOTE_OCX_SCRIPT,
  remoteOcxArgv,
} from "../../src/link/ssh-argv";
import {
  boundHint,
  createSshRunner,
  linkSshPath,
  linkSshSpawnEnv,
  sshFailureHint,
  sshRunnerErrorHint,
  SshRunnerError,
} from "../../src/link/ssh-runner";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function tempPath(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocx-link-argv-${label}-`));
  roots.push(root);
  return join(root, "known_hosts");
}

function expectCommonTrustOptions(argv: string[], strict: "yes" | "accept-new", knownHostsFile: string): void {
  expect(argv).toContain("BatchMode=yes");
  expect(argv).toContain(`StrictHostKeyChecking=${strict}`);
  expect(argv).toContain(`UserKnownHostsFile=${knownHostsFile}`);
  expect(argv).toContain("GlobalKnownHostsFile=none");
  expect(argv).toContain("KnownHostsCommand=none");
  expect(argv).toContain("VerifyHostKeyDNS=no");
  expect(argv).toContain("CheckHostIP=no");
}

test("tunnel argv uses a loopback forward and the confirmed host-key policy", () => {
  const knownHostsFile = tempPath("tunnel");
  for (const direction of ["R", "L"] as const) {
    const argv = buildTunnelArgv({
      alias: "alpha.example.test",
      direction,
      bindPort: 20100,
      targetPort: 10100,
      knownHostsFile,
    });
    expect(argv.slice(0, 3)).toEqual(["ssh", "-N", "-T"]);
    expectCommonTrustOptions(argv, "yes", knownHostsFile);
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain(`-${direction}`);
    expect(argv).toContain("127.0.0.1:20100:127.0.0.1:10100");
    expect(argv.slice(-2)).toEqual(["--", "alpha.example.test"]);
  }
});

test("exec argv quotes the remote command and clears forwarding", () => {
  const knownHostsFile = tempPath("exec");
  const argv = buildExecArgv({
    alias: "beta.example.test",
    argv: ["printf", "it's ready"],
    knownHostsFile,
  });
  expect(argv).toContain("-T");
  expect(argv).not.toContain("-N");
  expectCommonTrustOptions(argv, "yes", knownHostsFile);
  expect(argv).toContain("ClearAllForwardings=yes");
  expect(argv.slice(-3, -1)).toEqual(["--", "beta.example.test"]);
  expect(argv[argv.length - 1]).toBe(`'printf' 'it'"'"'s ready'`);
});

test("probe argv uses accept-new only with its temporary known_hosts file", () => {
  const knownHostsFile = tempPath("probe");
  writeFileSync(knownHostsFile, "", { mode: 0o600 });
  const argv = buildProbeArgv({ alias: "gamma.example.test", tempKnownHostsFile: knownHostsFile });
  expect(argv.slice(0, 2)).toEqual(["ssh", "-T"]);
  expect(argv).not.toContain("-N");
  expectCommonTrustOptions(argv, "accept-new", knownHostsFile);
  expect(argv).toContain("ClearAllForwardings=yes");
  expect(argv.slice(-3, -1)).toEqual(["--", "gamma.example.test"]);
  expect(argv[argv.length - 1]).toBe("true");
});

test("aliases and forwarding ports are validated before building argv", () => {
  const knownHostsFile = tempPath("validation");
  for (const alias of ["-oProxyCommand=x", "", "alpha beta", "alpha\nbeta"]) {
    expect(() => buildTunnelArgv({ alias, direction: "R", bindPort: 1, targetPort: 2, knownHostsFile }))
      .toThrow(LinkSshArgumentError);
  }
  for (const port of [0, 65536, 1.5]) {
    expect(() => buildTunnelArgv({ alias: "alpha.example.test", direction: "R", bindPort: port, targetPort: 2, knownHostsFile }))
      .toThrow(LinkSshArgumentError);
    expect(() => buildTunnelArgv({ alias: "alpha.example.test", direction: "R", bindPort: 1, targetPort: port, knownHostsFile }))
      .toThrow(LinkSshArgumentError);
  }
});

test("known_hosts option paths are absolute and safely quoted", () => {
  const pathWithSpaces = tempPath("path with spaces");
  const argv = buildTunnelArgv({
    alias: "alpha.example.test",
    direction: "R",
    bindPort: 1,
    targetPort: 2,
    knownHostsFile: pathWithSpaces,
  });
  expect(argv).toContain(`UserKnownHostsFile="${pathWithSpaces}"`);

  for (const knownHostsFile of [
    "none",
    "relative/known_hosts",
    "~/k",
    "/tmp/%h/known_hosts",
    "/tmp/${HOME}/k",
    "/tmp/\"quoted\"/known_hosts",
    "/tmp/control\ncharacter/known_hosts",
  ]) {
    expect(() => buildProbeArgv({ alias: "alpha.example.test", tempKnownHostsFile: knownHostsFile }))
      .toThrow(LinkSshArgumentError);
  }
});

test("quoteRemote escapes single quotes and rejects NUL", () => {
  expect(quoteRemote(["it's"])).toBe(`'it'"'"'s'`);
  expect(() => quoteRemote(["bad\0argument"])).toThrow(LinkSshArgumentError);
});

test("remote ocx argv runs ocx through a single-quoted sh PATH prelude", () => {
  expect(REMOTE_OCX_SCRIPT).toBe('PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; exec ocx "$@"');
  expect(remoteOcxArgv(["link", "port"])).toEqual(["sh", "-c", REMOTE_OCX_SCRIPT, "ocx", "link", "port"]);
  const argv = buildExecArgv({ alias: "delta.example.test", argv: remoteOcxArgv(["link", "issue", "--alias", "it's x", "--json"]), knownHostsFile: tempPath("remote-ocx") });
  expect(argv.at(-1)).toBe(`'sh' '-c' 'PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"; exec ocx "$@"' 'ocx' 'link' 'issue' '--alias' 'it'"'"'s x' '--json'`);
});

function fakeOcx(dir: string, label: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ocx"), `#!/bin/sh\nprintf "%s\\n" "${label}" "$PATH"\nfor arg in "$@"; do printf "[%s]\\n" "$arg"; done\n`, { mode: 0o755 });
}

test.skipIf(process.platform === "win32")("the remote prelude appends ~/.bun/bin after the remote PATH and keeps every argument", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-link-remote-home-"));
  roots.push(home);
  fakeOcx(join(home, ".bun", "bin"), "bun");
  const command = quoteRemote(remoteOcxArgv(["link", "issue", "--alias", "it's x", "--json"]));
  const result = Bun.spawnSync(["/bin/sh", "-c", command], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.toString().trim().split("\n");
  expect(lines[0]).toBe("bun");
  expect(lines[1]).toBe(`/usr/bin:/bin:${home}/.bun/bin:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin`);
  expect(lines.slice(2)).toEqual(["[link]", "[issue]", "[--alias]", "[it's x]", "[--json]"]);
});

test.skipIf(process.platform === "win32")("an ocx the remote PATH already resolves wins over the appended fallbacks", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-link-remote-first-"));
  roots.push(home);
  fakeOcx(join(home, "first"), "first");
  fakeOcx(join(home, ".bun", "bin"), "bun");
  const result = Bun.spawnSync(["/bin/sh", "-c", quoteRemote(remoteOcxArgv(["--version"]))], { env: { HOME: home, PATH: `${home}/first:/usr/bin:/bin` } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString().split("\n")[0]).toBe("first");
});

test("ssh PATH appends helper directories once and leaves Windows untouched", () => {
  expect(linkSshPath({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/test" }, "darwin"))
    .toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:/Users/test/.bun/bin:/Users/test/.local/bin");
  expect(linkSshPath({ PATH: "/opt/homebrew/bin:/usr/bin:/usr/bin", HOME: "/h" }, "linux"))
    .toBe("/opt/homebrew/bin:/usr/bin:/usr/local/bin:/h/.bun/bin:/h/.local/bin");
  expect(linkSshPath({ HOME: "/h" }, "darwin")).toBe("/opt/homebrew/bin:/usr/local/bin:/h/.bun/bin:/h/.local/bin");
  expect(linkSshPath({ PATH: "C:\\Windows", HOME: "C:\\Users\\t" }, "win32")).toBeUndefined();
  expect(linkSshSpawnEnv({ PATH: "C:\\Windows" }, "win32")).toBeUndefined();
  expect(linkSshSpawnEnv({ PATH: "/usr/bin", HOME: "/h", SSH_AUTH_SOCK: "/tmp/agent" }, "darwin"))
    .toEqual({ PATH: "/usr/bin:/opt/homebrew/bin:/usr/local/bin:/h/.bun/bin:/h/.local/bin", HOME: "/h", SSH_AUTH_SOCK: "/tmp/agent" });
});

function fakeSpawn(captured: Array<Record<string, unknown>>): typeof Bun.spawn {
  const closed = () => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
  return ((_argv: string[], options: Record<string, unknown>) => {
    captured.push(options);
    return { pid: 7, stdout: closed(), stderr: closed(), stdin: undefined, exited: Promise.resolve(0), kill() {} };
  }) as unknown as typeof Bun.spawn;
}

test("the runner spawns commands and tunnels with the augmented environment", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const runner = createSshRunner({ spawn: fakeSpawn(captured), env: () => linkSshSpawnEnv({ PATH: "/usr/bin:/bin", HOME: "/h" }, "darwin") });
  expect((await runner.run(["ssh", "-G", "--", "host"])).code).toBe(0);
  runner.spawnTunnel(["ssh", "-N", "--", "host"]);
  expect(captured.map(options => (options.env as Record<string, string>).PATH))
    .toEqual(Array(2).fill("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/h/.bun/bin:/h/.local/bin"));

  const windows: Array<Record<string, unknown>> = [];
  const windowsRunner = createSshRunner({ spawn: fakeSpawn(windows), env: () => linkSshSpawnEnv({ PATH: "C:\\Windows" }, "win32") });
  await windowsRunner.run(["ssh", "-G", "--", "host"]);
  windowsRunner.spawnTunnel(["ssh", "-N", "--", "host"]);
  expect(windows).toHaveLength(2);
  expect(windows.every(options => !("env" in options))).toBe(true);

  if (process.platform !== "win32") {
    const defaults: Array<Record<string, unknown>> = [];
    await createSshRunner({ spawn: fakeSpawn(defaults) }).run(["ssh", "-G", "--", "host"]);
    expect((defaults[0]?.env as Record<string, string>).PATH.split(":")).toContain("/opt/homebrew/bin");
  }
});

test("ssh failure hints keep one clean stderr line and redact secrets", () => {
  expect(sshFailureHint("\u001b[31mdebug noise\u001b[0m\nuser@host: Permission denied (publickey).\r\n\n")).toBe("user@host: Permission denied (publickey).");
  expect(sshFailureHint("bad\u202e line\u0007\there")).toBe("bad line here");
  expect(sshFailureHint(`issue failed ocx_data_${"a".repeat(40)} and ocx_session_x-y`)).toBe("issue failed ocx_data_[redacted] and ocx_session_[redacted]");
  expect(sshFailureHint("open https://team.example.test/cdn-cgi/access/cli?token=abc&aud=x to log in")).toBe("open https://team.example.test/cdn-cgi/access/cli to log in");
  const long = sshFailureHint("x".repeat(400));
  expect(long?.length).toBe(160);
  expect(long?.endsWith("…")).toBe(true);
  expect(sshFailureHint("")).toBeUndefined();
  expect(sshFailureHint("\n \u001b[0m\n")).toBeUndefined();
  expect(sshRunnerErrorHint(new SshRunnerError("timeout", "ssh command exceeded 30000ms"))).toBe("ssh command exceeded 30000ms");
  expect(sshRunnerErrorHint(new Error("unrelated"))).toBeUndefined();
});

test("hint bounding caps astral text by code point and never leaves a lone surrogate", () => {
  const astral = String.fromCodePoint(0x1f511);
  // 200 astral characters are 400 UTF-16 units; a unit-based cut at 159 would split a pair.
  for (const hint of [boundHint(astral.repeat(200)), sshFailureHint(`noise\n${astral.repeat(200)}\n`)]) {
    const points = Array.from(hint ?? "");
    expect(points).toHaveLength(160);
    expect(points.at(-1)).toBe(String.fromCodePoint(0x2026));
    expect(points.slice(0, -1).every(point => point === astral)).toBe(true);
    expect(points.every(point => { const code = point.codePointAt(0)!; return code < 0xd800 || code > 0xdfff; })).toBe(true);
  }
  expect(boundHint(astral.repeat(160))).toBe(astral.repeat(160));
});

/** Invisible and bidi formatting code points that must never sit literally in link hint sources. */
function isInvisibleOrBidi(code: number): boolean {
  return (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
}

test("link hint sources spell invisible and bidi characters as escapes, and hints still strip them", () => {
  for (const file of ["src/link/ssh-runner.ts", "src/server/management/link-routes.ts", "gui/src/remote-link-api.ts"]) {
    const literal = [...readFileSync(repoPath(file), "utf8")].map(char => char.codePointAt(0)!).filter(isInvisibleOrBidi);
    expect({ file, literal: literal.map(code => code.toString(16)) }).toEqual({ file, literal: [] });
  }
  const controls = [0x85, 0x200b, 0x200f, 0x202a, 0x202e, 0x2060, 0x206f, 0xfeff].map(code => String.fromCodePoint(code)).join("");
  expect(sshFailureHint(`left${controls}right`)).toBe("left right");
});
