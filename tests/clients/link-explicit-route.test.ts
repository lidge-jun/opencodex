import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkExplicitRoute, explicitRouteSshOptions, identityFileProblem, sameExplicitRoute, type ExplicitRoute } from "../../src/link/explicit-route";
import { readTombstones, recordTombstone } from "../../src/link/tombstones";
import { enrollOperationDigest } from "../../src/server/management/link-operation";
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

test("the supervisor's tunnel and link status use the identity file of a keyed route (O7)", () => {
  const KEY = "/home/hub/.ssh/goat_hub_ed25519";
  const keyed = { ...ROUTE, identityFile: KEY };
  const argv = startedTunnel([record({ explicitRoute: keyed, exclusive: true })]);
  expect({ only: options(argv, "IdentitiesOnly"), agent: options(argv, "IdentityAgent"), file: options(argv, "IdentityFile") }).toEqual({ only: ["yes"], agent: ["none"], file: [KEY] });
  // The path is not a secret: link status names it, and the CLI accepts it.
  const value: LinkStore = { version: 1, listenerPort: 19001, links: [record({ explicitRoute: keyed, exclusive: true })] };
  const dto = projectLinkStatus(value, [], { state: "listening", port: 19001 }, { runtimeRole: "hub" }, { version: 1, entries: {} });
  expect(dto.links[0]).toMatchObject({ explicitRoute: keyed });
  expect(validateStatus(JSON.parse(JSON.stringify(dto))).links[0]).toMatchObject({ explicitRoute: keyed });
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

/**
 * O7 (link.route/2): an explicit route may name the key the link authenticates with. ssh then offers that file alone:
 * IdentitiesOnly=yes, IdentityAgent=none and IdentityFile=<path>, on the command line beside the route.
 */
describe("the explicit route's identity file", () => {
  const KEY = "/home/hub/.ssh/goat_hub_ed25519";
  const ROUTE_KEY: ExplicitRoute = { ...ROUTE, identityFile: KEY };
  const builders = (route: ExplicitRoute) => ({
    tunnel: buildTunnelArgv({ alias: "pen-7f3a9c", direction: "R", bindPort: 19002, targetPort: 19001, knownHostsFile: KNOWN_HOSTS, route }),
    exec: buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route }),
    probe: buildProbeArgv({ alias: "pen-7f3a9c", tempKnownHostsFile: KNOWN_HOSTS, route }),
    routeProbe: buildRouteProbeArgv({ alias: "pen-7f3a9c", destination: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
    windowsProbe: buildWindowsProbeArgv({ alias: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
  });
  // What every builder emitted for an explicit route on origin/dev 28680d5c0, before the identity file existed.
  const BEFORE_IDENTITY_FILE: Record<string, string[]> = {"tunnel":["ssh","-N","-T","-F","none","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ProxyCommand=/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22","-o","ProxyUseFdpass=no","-o","User=ubuntu","-o","Port=22","-o","ExitOnForwardFailure=yes","-R","127.0.0.1:19002:127.0.0.1:19001","--","pen-7f3a9c"],"exec":["ssh","-T","-F","none","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ProxyCommand=/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22","-o","ProxyUseFdpass=no","-o","User=ubuntu","-o","Port=22","-o","ClearAllForwardings=yes","--","pen-7f3a9c","sh '-c' 'true'"],"probe":["ssh","-T","-F","none","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=accept-new","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ProxyCommand=/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22","-o","ProxyUseFdpass=no","-o","User=ubuntu","-o","Port=22","-o","ClearAllForwardings=yes","--","pen-7f3a9c","echo ocx-link-probe"],"routeProbe":["ssh","-T","-F","none","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ProxyCommand=/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22","-o","ProxyUseFdpass=no","-o","User=ubuntu","-o","Port=22","-o","ClearAllForwardings=yes","--","pen-7f3a9c","echo ocx-link-probe"],"windowsProbe":["ssh","-T","-F","none","-o","BatchMode=yes","-o","ConnectTimeout=10","-o","ServerAliveInterval=15","-o","ServerAliveCountMax=3","-o","StrictHostKeyChecking=yes","-o","HostKeyAlias=pen-7f3a9c","-o","UserKnownHostsFile=/tmp/ocx-explicit-route/known_hosts","-o","HashKnownHosts=no","-o","GlobalKnownHostsFile=none","-o","KnownHostsCommand=none","-o","VerifyHostKeyDNS=no","-o","CheckHostIP=no","-o","UpdateHostKeys=no","-o","ControlMaster=no","-o","ControlPath=none","-o","ForwardAgent=no","-o","ForwardX11=no","-o","PermitLocalCommand=no","-o","LogLevel=ERROR","-o","ProxyCommand=/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22","-o","ProxyUseFdpass=no","-o","User=ubuntu","-o","Port=22","-o","ClearAllForwardings=yes","--","pen-7f3a9c","cmd /c echo %OS%"]};

  test("a route without an identity file keeps every argv and its enrollment digest byte for byte", () => {
    expect(builders(ROUTE)).toEqual(BEFORE_IDENTITY_FILE);
    expect(enrollOperationDigest({ alias: "pen-7f3a9c", fingerprint: "SHA256:abcdefghijklmnopqrstu", route: { explicitRoute: ROUTE, exclusive: true }, requireEphemeral: false }))
      .toBe("2ac5dbb274c7476f31fadaec0536751aea7dc5edb8285fb7e1df123f44236846");
  });

  test("an absolute, plain path is accepted and kept", () => {
    expect(checkExplicitRoute(ROUTE_KEY)).toEqual({ ok: true, route: ROUTE_KEY });
    expect(checkExplicitRoute({ ...ROUTE, identityFile: "/a/b-c_d.e+f/id_ed25519" })).toEqual({ ok: true, route: { ...ROUTE, identityFile: "/a/b-c_d.e+f/id_ed25519" } });
  });

  test.each([
    ["a relative path", "id_ed25519"], ["a home path", "~/.ssh/id_ed25519"], ["a % token", "/home/%u/.ssh/id"], ["an environment variable", "/home/${USER}/.ssh/id"],
    ["a space", "/home/hub/.ssh/my key"], ["a quote", '/home/hub/.ssh/"id"'], ["a newline", "/home/hub/.ssh/id\nIdentityFile=/x"], ["a NUL", "/home/hub/.ssh/id\u0000"],
    ["a control character", "/home/hub/.ssh/\u001bid"], ["an equals sign", "/home/hub/.ssh/id=x"], ["a non-ASCII character", "/home/hub/.ssh/ключ"], ["a parent segment", "/home/hub/../root/.ssh/id"],
    ["a doubled slash", "/home//hub/id"], ["a trailing slash", "/home/hub/.ssh/"], ["the root", "/"], ["an option", "-oProxyCommand=/bin/sh"], ["a Windows path", "C:\\Users\\hub\\id"],
    ["an empty string", ""], ["1025 characters", "/" + "a".repeat(1024)], ["a number", 7], ["null", null],
  ])("%s is refused", (_label, identityFile) => {
    expect(checkExplicitRoute({ ...ROUTE, identityFile })).toEqual({ ok: false, reason: "identity_file_form" });
  });

  test("a Windows Home refuses an identity file whatever the path, before looking at the file", () => {
    // A POSIX-looking path resolves against the current drive there, and owner and mode bits say nothing about its ACL.
    const dir = mkdtempSync(join(tmpdir(), "ocx-identity-win32-"));
    const key = join(dir, "id_ed25519");
    writeFileSync(key, "x\n", { mode: 0o600 });
    try {
      expect(identityFileProblem(key)).toBe(process.platform === "win32" ? "identity_file_unsupported_platform" : null);
      expect(identityFileProblem(key, "win32")).toBe("identity_file_unsupported_platform");
      expect(identityFileProblem(join(dir, "missing"), "win32")).toBe("identity_file_unsupported_platform");
      // A Home always passes its own platform; naming another here applies the POSIX checks to this host's metadata. Windows
      // reports a writable file as 0o666 whatever mode it was created with, so those checks refuse it there, as they must.
      expect(identityFileProblem(key, "linux")).toBe(process.platform === "win32" ? "identity_file_permissions" : null);
      const windowsShaped = (path: string): Stats => path === key ? Object.create(lstatSync(path), { mode: { value: 0o100666 } }) as Stats : lstatSync(path);
      expect(identityFileProblem(key, "linux", windowsShaped)).toBe("identity_file_permissions");
    } finally { removeTreeWithRetry(dir); }
  });

  // The owner of a symlink cannot be faked without chown, so the walk takes its lstat as a parameter (as it takes the platform):
  // the link's real metadata with another owner. Skipped on Windows: process.getuid does not exist there, so the walk trusts every owner.
  test.skipIf(process.platform === "win32")("a symlink on the key's path must be owned by this user or root: another user could repoint it", () => {
    // The walk follows the real path (on macOS the temp directory is reached through /var -> /private/var).
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ocx-identity-link-")));
    try {
      mkdirSync(join(dir, "private"), { mode: 0o700 });
      const key = join(dir, "private", "id_ed25519");
      writeFileSync(key, "x\n", { mode: 0o600 });
      symlinkSync(join(dir, "private"), join(dir, "link"));
      const via = join(dir, "link", "id_ed25519");
      const ownedBy = (uid: number) => (path: string): Stats => {
        const stat = lstatSync(path);
        return path === join(dir, "link") ? Object.create(stat, { uid: { value: uid } }) as Stats : stat;
      };
      expect(identityFileProblem(via, "linux", ownedBy(process.getuid!()))).toBe(null);
      expect(identityFileProblem(via, "linux", ownedBy(0))).toBe(null);
      expect(identityFileProblem(via, "linux", ownedBy(process.getuid!() + 4242))).toBe("identity_file_ancestor");
    } finally { removeTreeWithRetry(dir); }
  });

  test("the options are the route's, then IdentitiesOnly=yes, IdentityAgent=none and IdentityFile=<path>, one argument each", () => {
    expect(explicitRouteSshOptions(ROUTE_KEY)).toEqual([
      "-o", "ProxyCommand=" + ROUTE.proxyCommand, "-o", "ProxyUseFdpass=no", "-o", "User=ubuntu", "-o", "Port=22",
      "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "IdentityFile=" + KEY,
    ]);
  });

  test("every builder passes the three options once, after -F none and before the destination", () => {
    for (const [name, argv] of Object.entries(builders(ROUTE_KEY))) {
      expect({ name, only: options(argv, "IdentitiesOnly"), agent: options(argv, "IdentityAgent"), file: options(argv, "IdentityFile") })
        .toEqual({ name, only: ["yes"], agent: ["none"], file: [KEY] });
      expect(argv.slice(argv.indexOf("-F"), argv.indexOf("-F") + 2)).toEqual(["-F", "none"]);
      expect(argv.indexOf("IdentityFile=" + KEY)).toBeLessThan(argv.indexOf("--"));
      // Everything else is the argv of the same route without a key.
      expect(argv.filter((value, index) => !/^Identit/.test(value) && !(value === "-o" && /^Identit/.test(argv[index + 1] ?? "")))).toEqual(BEFORE_IDENTITY_FILE[name]);
    }
  });

  test("a link record with an identity file round-trips, and one without parses exactly as before", () => {
    expect(parseLinkStore(store(record({ explicitRoute: ROUTE_KEY, exclusive: true }))).links[0]).toEqual(record({ explicitRoute: ROUTE_KEY, exclusive: true }));
    expect(parseLinkStore(store(record({ explicitRoute: ROUTE, exclusive: true }))).links[0]).toEqual(record({ explicitRoute: ROUTE, exclusive: true }));
    expect(() => parseLinkStore(store(record({ explicitRoute: { ...ROUTE, identityFile: "relative" }, exclusive: true })))).toThrow("links[0].explicitRoute is invalid");
  });

  test("a tombstone keeps the identity file, so recover reaches the machine with the link's key", () => {
    const path = join(dir, "tombstones-identity.json");
    const tombstone = { linkId: "lnk_0123456789abcdef", alias: "pen-7f3a9c", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstu", remotePlatform: "posix" as const,
      explicitRoute: ROUTE_KEY, exclusive: true as const, revokedAt: "2026-11-14T00:00:00.000Z" };
    recordTombstone(tombstone, path);
    expect(readTombstones(path).tombstones[0]!.explicitRoute).toEqual(ROUTE_KEY);
  });

  test("the enrollment digest names the identity file, so a repeat of an operation id with another key does not match", () => {
    const digest = (route: ExplicitRoute) => enrollOperationDigest({ alias: "pen-7f3a9c", fingerprint: "SHA256:abcdefghijklmnopqrstu", route: { explicitRoute: route, exclusive: true }, requireEphemeral: false });
    expect(digest(ROUTE_KEY)).not.toBe(digest(ROUTE));
    expect(digest(ROUTE_KEY)).not.toBe(digest({ ...ROUTE, identityFile: "/home/hub/.ssh/other_ed25519" }));
    expect(digest(ROUTE_KEY)).toBe(digest({ ...ROUTE_KEY }));
  });

  test("two routes are the same only with the same identity file", () => {
    expect(sameExplicitRoute(ROUTE_KEY, { ...ROUTE_KEY })).toBe(true);
    expect(sameExplicitRoute(ROUTE_KEY, ROUTE)).toBe(false);
    expect(sameExplicitRoute(ROUTE, { ...ROUTE })).toBe(true);
  });
});

/** Every value ssh -G resolves for one keyword, in order (identityfile repeats). */
function resolvedAll(args: readonly string[], keyword: string): string[] {
  const result = Bun.spawnSync([SSH!, "-G", ...args], { stdin: "ignore" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split("\n").filter(line => line.startsWith(keyword + " ")).map(line => line.slice(keyword.length + 1));
}

describe.skipIf(SSH === null)("the identity file as ssh resolves it (ssh -G)", () => {
  const KEY = "/home/hub/.ssh/goat_hub_ed25519";
  const ROUTE_KEY: ExplicitRoute = { ...ROUTE, identityFile: KEY };
  // A user's ssh_config that would add a key and an agent for every host.
  const adding = () => {
    const config = join(dir, "adds-identity.conf");
    writeFileSync(config, ["Host *", "  IdentityFile /home/hub/.ssh/id_other", "  IdentityAgent /tmp/other-agent.sock", "  IdentitiesOnly no", ""].join("\n"));
    return config;
  };
  const argvs = () => [
    buildTunnelArgv({ alias: "pen-7f3a9c", direction: "R", bindPort: 19002, targetPort: 19001, knownHostsFile: KNOWN_HOSTS, route: ROUTE_KEY }),
    buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route: ROUTE_KEY }).slice(0, -1),
    buildProbeArgv({ alias: "pen-7f3a9c", tempKnownHostsFile: KNOWN_HOSTS, route: ROUTE_KEY }).slice(0, -1),
  ];

  test("ssh offers exactly the route's key, with no agent and identities only, and no ssh_config can add one", () => {
    adding();
    for (const argv of argvs()) {
      // From -F none on: the argv as the link runs it.
      const args = argv.slice(argv.indexOf("-F"));
      expect({ files: resolvedAll(args, "identityfile"), only: resolvedAll(args, "identitiesonly"), agent: resolvedAll(args, "identityagent") })
        .toEqual({ files: [KEY], only: ["yes"], agent: ["none"] });
    }
  });

  test("control: were ssh_config read, it would add its key, which -F none prevents", () => {
    const argv = argvs()[1]!;
    const files = resolvedAll(["-F", adding(), ...argv.slice(argv.indexOf("-F") + 2)], "identityfile");
    expect(files).toContain(KEY);
    expect(files).toContain("/home/hub/.ssh/id_other");
  });
});
