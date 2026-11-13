import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExplicitRoute, explicitRouteSshOptions, type ExplicitRoute } from "../../src/link/explicit-route";
import {
  buildExecArgv, buildProbeArgv, buildRouteProbeArgv, buildTunnelArgv, buildWindowsProbeArgv, LinkSshArgumentError,
} from "../../src/link/ssh-argv";
import { parseLinkStore, type LinkRecord, type LinkStore } from "../../src/link/store";
import { createLinkSupervisor } from "../../src/link/supervisor";
import { projectLinkStatus } from "../../src/link/status-projection";
import { validateStatus } from "../../src/cli/link";
import type { SshChild, SshRunner } from "../../src/link/ssh-runner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O6: a Home-initiated link may carry an explicit route {proxyCommand, user, port} and the flag
 * exclusive. The route reaches ssh on the command line, so ssh_config cannot change it.
 */
const ROUTE: ExplicitRoute = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22", user: "ubuntu", port: 22 };
const KNOWN_HOSTS = "/tmp/ocx-explicit-route/known_hosts";
const SSH = Bun.which("ssh");

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ocx-explicit-route-")); });
afterAll(() => { if (dir) removeTreeWithRetry(dir); });

function options(argv: readonly string[], name: string): string[] {
  return argv.filter((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "=")).map(value => value.slice(name.length + 1));
}

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: "lnk_0123456789abcdef", alias: "pen-7f3a9c", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstu",
    tunnelPort: 19002, apiKeyId: "link-key", createdAt: "2026-11-13T00:00:00.000Z", remotePlatform: "posix", ...overrides,
  };
}

function store(...links: LinkRecord[]): string {
  return JSON.stringify({ version: 1, listenerPort: 19001, links });
}

describe("accepted route forms", () => {
  test.each([
    ["the pen pipe command", ROUTE],
    ["a bare absolute command", { proxyCommand: "/usr/bin/nc", user: "_svc", port: 1 }],
    ["host:port and user@host words", { proxyCommand: "/opt/bin/relay --to svc@relayhost:2222 --opt=a,b --tag=a+b/c", user: "dev.user-1", port: 65535 }],
  ] as const)("%s is accepted as is", (_label, route) => {
    expect(checkExplicitRoute(route)).toEqual({ ok: true, route: { ...route } });
  });
});

describe("refused route forms", () => {
  const base = { proxyCommand: "/usr/bin/pen pipe 22", user: "ubuntu", port: 22 };
  test.each([
    ["a relative program", "pen pipe 22"],
    ["a program that is an option", "-oProxyCommand=/bin/sh"],
    ["none", "none"],
    ["a % token", "/usr/bin/pen pipe %h %p"],
    ["a command separator", "/usr/bin/pen pipe; touch /tmp/owned"],
    ["command substitution", "/usr/bin/pen $(id)"],
    ["a backquote", "/usr/bin/pen `id`"],
    ["a variable", "/usr/bin/pen $HOME"],
    ["a single quote", "/usr/bin/pen 'a b'"],
    ["a double quote", "/usr/bin/pen \"a\""],
    ["a backslash", "/usr/bin/pen a\\ b"],
    ["two spaces", "/usr/bin/pen  pipe"],
    ["a leading space", " /usr/bin/pen pipe"],
    ["a trailing space", "/usr/bin/pen pipe "],
    ["a tab", "/usr/bin/pen\tpipe"],
    ["a newline", "/usr/bin/pen pipe\n/bin/sh"],
    ["a NUL", "/usr/bin/pen pipe\u0000"],
    ["a tilde", "/usr/bin/pen ~/x"],
    ["a leading equals sign", "/usr/bin/pen =sh"],
    ["a pipe", "/usr/bin/pen a|b"],
    ["an ampersand", "/usr/bin/pen a&b"],
    ["a redirection", "/usr/bin/pen a>b"],
    ["braces", "/usr/bin/pen {a,b}"],
    ["a glob star", "/usr/bin/pen *"],
    ["a glob question mark", "/usr/bin/pen a?"],
    ["brackets", "/usr/bin/pen [a]"],
    ["parentheses", "/usr/bin/pen (a)"],
    ["an exclamation mark", "/usr/bin/pen !a"],
    ["a comment", "/usr/bin/pen #a"],
    ["non-ASCII", "/usr/bin/pen caf\u00e9"],
    ["an empty command", ""],
    ["more than 1024 characters", "/usr/bin/pen " + "a".repeat(1012)],
    ["more than 32 words", "/usr/bin/pen" + " a".repeat(32)],
  ])("a proxyCommand with %s is refused", (_label, proxyCommand) => {
    expect(checkExplicitRoute({ ...base, proxyCommand })).toEqual({ ok: false, reason: "proxy_command_form" });
  });

  test.each([
    ["an option", "-oProxyCommand=/bin/sh"], ["a separator", "root;id"], ["a space", "a b"], ["a % token", "%r"],
    ["an empty name", ""], ["33 characters", "a".repeat(33)], ["a leading digit", "1abc"], ["non-ASCII", "\u00fcser"], ["a quote", "a'b"],
  ])("a user with %s is refused", (_label, user) => {
    expect(checkExplicitRoute({ ...base, user })).toEqual({ ok: false, reason: "user_form" });
  });

  test.each([[0], [65536], [22.5], ["22"], [-1], [Number.NaN]])("port %p is refused", port => {
    expect(checkExplicitRoute({ ...base, port })).toEqual({ ok: false, reason: "port_form" });
  });

  test.each([
    ["null", null], ["an array", [base.proxyCommand, base.user, base.port]], ["a missing user", { proxyCommand: base.proxyCommand, port: 22 }],
    ["an extra key", { ...base, hostName: "x" }], ["a non-string command", { ...base, proxyCommand: ["/usr/bin/pen"] }],
  ])("%s is not a route", (_label, value) => {
    expect(checkExplicitRoute(value)).toEqual({ ok: false, reason: "shape" });
  });
});

describe("the link record", () => {
  test("an exclusive link with an explicit route round-trips", () => {
    const parsed = parseLinkStore(store(record({ explicitRoute: ROUTE, exclusive: true })));
    expect(parsed.links[0]).toEqual(record({ explicitRoute: ROUTE, exclusive: true }));
  });

  test("exclusive alone locks the route list to the alias", () => {
    expect(parseLinkStore(store(record({ exclusive: true }))).links[0]!.exclusive).toBe(true);
  });

  test.each([
    ["an explicit route without exclusive", { explicitRoute: ROUTE }, "exclusive"],
    ["exclusive with a route list", { exclusive: true, routes: ["alpha-lan", "pen-7f3a9c"] }, "routes"],
    ["exclusive false", { exclusive: false }, "exclusive"],
    ["an invalid explicit route", { explicitRoute: { ...ROUTE, proxyCommand: "pen pipe" }, exclusive: true }, "explicitRoute"],
  ] as const)("%s is a damaged record", (_label, overrides, field) => {
    expect(() => parseLinkStore(store(record(overrides as Partial<LinkRecord>)))).toThrow("links[0]." + field + " is invalid");
  });

  test("a Child-initiated link cannot be exclusive or carry an explicit route", () => {
    const child = record({ direction: "client-initiated", hostKeyFingerprint: null });
    expect(() => parseLinkStore(store({ ...child, exclusive: true }))).toThrow("links[0].exclusive is invalid");
    expect(() => parseLinkStore(store({ ...child, explicitRoute: ROUTE, exclusive: true }))).toThrow("is invalid");
  });

  test("an existing link without the new fields parses exactly as before", () => {
    expect(parseLinkStore(store(record())).links[0]).toEqual(record());
  });
});

describe("ssh argv", () => {
  const builders = (route: ExplicitRoute | null) => ({
    tunnel: buildTunnelArgv({ alias: "pen-7f3a9c", direction: "R", bindPort: 19002, targetPort: 19001, knownHostsFile: KNOWN_HOSTS, route }),
    exec: buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route }),
    probe: buildProbeArgv({ alias: "pen-7f3a9c", tempKnownHostsFile: KNOWN_HOSTS, route }),
    routeProbe: buildRouteProbeArgv({ alias: "pen-7f3a9c", destination: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
    windowsProbe: buildWindowsProbeArgv({ alias: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
  });

  test("every builder passes the explicit route once, on the command line, before the destination", () => {
    for (const [name, argv] of Object.entries(builders(ROUTE))) {
      const seen = { name, proxy: options(argv, "ProxyCommand"), user: options(argv, "User"), port: options(argv, "Port"), fdpass: options(argv, "ProxyUseFdpass") };
      expect(seen).toEqual({ name, proxy: [ROUTE.proxyCommand], user: ["ubuntu"], port: ["22"], fdpass: ["no"] });
      expect(argv.indexOf("ProxyCommand=" + ROUTE.proxyCommand)).toBeLessThan(argv.indexOf("--"));
      expect(argv[argv.indexOf("--") + 1]).toBe("pen-7f3a9c");
      expect(options(argv, "HostKeyAlias")).toEqual(["pen-7f3a9c"]);
    }
  });

  // The argv each builder produced on origin/dev e85a97556, before explicit routes existed: a drift in any option fails.
  const BEFORE_EXPLICIT_ROUTES: Record<string, string[]> = {
    tunnel: ["ssh","-N","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ExitOnForwardFailure=yes","-R","127.0.0.1:19002:127.0.0.1:19001","--","pen-7f3a9c"],
    exec: ["ssh","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ClearAllForwardings=yes","--","pen-7f3a9c","sh '-c' 'true'"],
    probe: ["ssh","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=accept-new","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ClearAllForwardings=yes","--","pen-7f3a9c","echo ocx-link-probe"],
    routeProbe: ["ssh","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ClearAllForwardings=yes","--","pen-7f3a9c","echo ocx-link-probe"],
    windowsProbe: ["ssh","-T","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ClearAllForwardings=yes","--","pen-7f3a9c","cmd /c echo %OS%"],
  };

  test("without a route every builder emits exactly the argv it emitted before explicit routes", () => {
    expect(builders(null)).toEqual(BEFORE_EXPLICIT_ROUTES);
  });

  test("a builder refuses a route object that is not an accepted form, before any process starts", () => {
    const bad = { ...ROUTE, proxyCommand: "/usr/bin/pen pipe; id" };
    expect(() => buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route: bad })).toThrow(LinkSshArgumentError);
    expect(() => buildTunnelArgv({ alias: "pen-7f3a9c", direction: "R", bindPort: 1, targetPort: 2, knownHostsFile: KNOWN_HOSTS, route: { ...ROUTE, user: "-x" } })).toThrow(LinkSshArgumentError);
  });

  test("the route options are exactly ProxyCommand, ProxyUseFdpass, User and Port", () => {
    expect(explicitRouteSshOptions(ROUTE)).toEqual(["-o", "ProxyCommand=" + ROUTE.proxyCommand, "-o", "ProxyUseFdpass=no", "-o", "User=ubuntu", "-o", "Port=22"]);
  });
});

test("link status names an exclusive link's route and adds nothing to any other row; ocx link status accepts it", () => {
  const value: LinkStore = { version: 1, listenerPort: 19001, links: [record({ explicitRoute: ROUTE, exclusive: true }), record({ id: "lnk_fedcba9876543210", alias: "plain" })] };
  const dto = projectLinkStatus(value, [], { state: "listening", port: 19001 }, { runtimeRole: "hub" }, { version: 1, entries: {} });
  expect(dto.links[0]).toMatchObject({ exclusive: true, explicitRoute: ROUTE });
  expect("exclusive" in dto.links[1]! || "explicitRoute" in dto.links[1]!).toBe(false);
  const parsed = validateStatus(JSON.parse(JSON.stringify(dto)));
  expect(parsed.links[0]).toMatchObject({ exclusive: true, explicitRoute: ROUTE });
  const bad = JSON.parse(JSON.stringify(dto));
  delete bad.links[0].exclusive;
  expect(() => validateStatus(bad)).toThrow("link 0 fields");
});

function fakeRunner() {
  const spawned: string[][] = [];
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      spawned.push([...argv]);
      return { pid: 4100 + spawned.length, argv: [...argv], exited: new Promise<number>(() => {}), stderr: Promise.resolve(""), kill: () => {} } as unknown as SshChild;
    },
  };
  return { runner, spawned };
}

function startedTunnel(links: LinkRecord[]): string[] {
  const { runner, spawned } = fakeRunner();
  const value: LinkStore = { version: 1, listenerPort: 19001, links };
  const supervisor = createLinkSupervisor({
    readStore: () => structuredClone(value), runner, now: () => 0, random: () => 0.5,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setInterval>, clearTimer: () => {},
  });
  supervisor.start();
  expect(spawned.length).toBe(1);
  return spawned[0]!;
}

test("the supervisor starts an exclusive link's tunnel over its explicit route", () => {
  const argv = startedTunnel([record({ explicitRoute: ROUTE, exclusive: true })]);
  expect(options(argv, "ProxyCommand")).toEqual([ROUTE.proxyCommand]);
  expect(options(argv, "User")).toEqual(["ubuntu"]);
  expect(options(argv, "Port")).toEqual(["22"]);
  expect(argv.at(-1)).toBe("pen-7f3a9c");
});

test("the supervisor starts a link without an explicit route exactly as before", () => {
  const argv = startedTunnel([record()]);
  expect(options(argv, "ProxyCommand")).toEqual([]);
  expect(options(argv, "User")).toEqual([]);
});

test("a links.json edit of the explicit route on a running Home restarts the tunnel on the new route", async () => {
  const spawned: string[][] = [];
  let killed = 0;
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      spawned.push([...argv]);
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      return { pid: 4200 + spawned.length, argv: [...argv], exited, stderr: Promise.resolve(""), kill: () => { killed += 1; exit(143); } } as unknown as SshChild;
    },
  };
  let value: LinkStore = { version: 1, listenerPort: 19001, links: [record({ explicitRoute: ROUTE, exclusive: true })] };
  const supervisor = createLinkSupervisor({
    readStore: () => structuredClone(value), runner, now: () => 0, random: () => 0.5,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setInterval>, clearTimer: () => {},
  });
  supervisor.start();
  expect(options(spawned[0]!, "Port")).toEqual(["22"]);
  value = { ...value, links: [record({ explicitRoute: { ...ROUTE, port: 2222 }, exclusive: true })] };
  await supervisor.reload();
  expect(killed).toBe(1);
  expect(spawned.length).toBe(2);
  expect(options(spawned[1]!, "Port")).toEqual(["2222"]);
  await supervisor.stop();
});

test("a links.json edit that only drops exclusive does not restart the tunnel: exclusive alone does not change its argv", async () => {
  const spawned: string[][] = [];
  let killed = 0;
  const runner: SshRunner = {
    async run() { return { code: 0, stdout: "", stderr: "" }; },
    spawnTunnel(argv) {
      spawned.push([...argv]);
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => { exit = resolve; });
      return { pid: 4300 + spawned.length, argv: [...argv], exited, stderr: Promise.resolve(""), kill: () => { killed += 1; exit(143); } } as unknown as SshChild;
    },
  };
  let value: LinkStore = { version: 1, listenerPort: 19001, links: [record({ exclusive: true })] };
  const supervisor = createLinkSupervisor({
    readStore: () => structuredClone(value), runner, now: () => 0, random: () => 0.5,
    readPidfile: () => null, writePidfile: () => {}, removePidfile: () => {},
    setTimer: () => 1 as unknown as ReturnType<typeof setInterval>, clearTimer: () => {},
  });
  supervisor.start();
  value = { ...value, links: [record()] };
  await supervisor.reload();
  expect({ killed, spawned: spawned.length }).toEqual({ killed: 0, spawned: 1 });
  await supervisor.stop();
});

/** The configuration ssh would use if it read config: the argv from its first -o (dropping -F none) with -F <config>. */
function effective(argv: readonly string[], config: string): Map<string, string> {
  const tail = argv.slice(argv.indexOf("-o"));
  const result = Bun.spawnSync([SSH!, "-G", "-F", config, ...tail], { stdin: "ignore" });
  expect(result.exitCode).toBe(0);
  const values = new Map<string, string>();
  for (const line of result.stdout.toString().split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) values.set(line.slice(0, space), line.slice(space + 1));
  }
  return values;
}

// Second line of defence: effective() runs the argv from its first -o with -F <config>, so it reads ssh_config on purpose,
// which an explicit-route link no longer does (-F none, link-explicit-route-no-ssh-config.test.ts). It shows the route on the
// command line would still win if ssh_config were read.
describe.skipIf(SSH === null)("an ssh_config edit after enrollment, were ssh_config read (ssh -G, second line of defence)", () => {
  const hostile = () => {
    const config = join(dir, "hostile.conf");
    writeFileSync(config, [
      "Host pen-7f3a9c",
      "  ProxyCommand /usr/bin/evil-relay %h %p",
      "  ProxyJump intruder@jumphost",
      "  User intruder",
      "  Port 2222",
      "  HostName elsewhere.example",
      "  ProxyUseFdpass yes",
      "Match host pen-7f3a9c",
      "  ProxyCommand /usr/bin/matched-relay",
      "  User matched",
      "",
    ].join("\n"));
    return config;
  };

  test("does not change the route of any command an exclusive link runs", () => {
    const config = hostile();
    const tunnel = startedTunnel([record({ explicitRoute: ROUTE, exclusive: true })]);
    const others = [
      buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route: ROUTE }).slice(0, -1),
      buildProbeArgv({ alias: "pen-7f3a9c", tempKnownHostsFile: KNOWN_HOSTS, route: ROUTE }).slice(0, -1),
      buildWindowsProbeArgv({ alias: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route: ROUTE }).slice(0, -1),
    ];
    for (const argv of [tunnel, ...others]) {
      const values = effective(argv, config);
      expect({ proxy: values.get("proxycommand"), jump: values.get("proxyjump"), user: values.get("user"), port: values.get("port"), fdpass: values.get("proxyusefdpass") })
        .toEqual({ proxy: ROUTE.proxyCommand, jump: undefined, user: "ubuntu", port: "22", fdpass: "no" });
    }
  });

  test("still decides the route of a link without an explicit route (today's behaviour)", () => {
    const values = effective(startedTunnel([record()]), hostile());
    expect(values.get("user")).toBe("intruder");
    expect(values.get("port")).toBe("2222");
  });
});

