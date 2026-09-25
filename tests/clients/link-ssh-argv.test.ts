import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExecArgv,
  buildProbeArgv,
  buildTunnelArgv,
  LinkSshArgumentError,
  quoteRemote,
} from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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
