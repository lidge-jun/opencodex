import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExplicitRoute } from "../../src/link/explicit-route";
import { buildExecArgv, buildProbeArgv, buildRouteProbeArgv, buildTunnelArgv, buildWindowsProbeArgv } from "../../src/link/ssh-argv";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * O6b: a link with an explicit route reads no ssh_config (-F none). Its route names the transport, user and port and its
 * host key is pinned, so nothing may come from the owner's or the system's configuration: forwards and SendEnv would
 * accumulate, a RemoteCommand breaks every exec, and no command-line option can remove a configured forward from the
 * tunnel. Links without an explicit route keep reading ssh_config (their argv is pinned in link-explicit-route.test.ts).
 */
const ROUTE: ExplicitRoute = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c 22", user: "ubuntu", port: 22 };
const KNOWN_HOSTS = "/tmp/ocx-no-ssh-config/known_hosts";
const SSH = process.platform === "win32" ? null : Bun.which("ssh");

const builders = (route: ExplicitRoute | null) => ({
  tunnel: buildTunnelArgv({ alias: "pen-7f3a9c", direction: "R", bindPort: 19002, targetPort: 19001, knownHostsFile: KNOWN_HOSTS, route }),
  exec: buildExecArgv({ alias: "pen-7f3a9c", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS, route }),
  probe: buildProbeArgv({ alias: "pen-7f3a9c", tempKnownHostsFile: KNOWN_HOSTS, route }),
  routeProbe: buildRouteProbeArgv({ alias: "pen-7f3a9c", destination: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
  windowsProbe: buildWindowsProbeArgv({ alias: "pen-7f3a9c", knownHostsFile: KNOWN_HOSTS, route }),
});

const count = (argv: readonly string[], value: string) => argv.filter(item => item === value).length;

describe("argv of an explicit-route link", () => {
  test("every command reads no ssh_config: -F none exactly once, before the destination", () => {
    for (const [name, argv] of Object.entries(builders(ROUTE))) {
      expect({ name, flags: count(argv, "-F") }).toEqual({ name, flags: 1 });
      expect({ name, value: argv[argv.indexOf("-F") + 1] }).toEqual({ name, value: "none" });
      expect(argv.indexOf("-F")).toBeLessThan(argv.indexOf("--"));
    }
  });

  test("the tunnel carries only its own forward, fails when it cannot bind it, and keeps it (no ClearAllForwardings)", () => {
    const tunnel = builders(ROUTE).tunnel;
    expect(count(tunnel, "-R") + count(tunnel, "-L") + count(tunnel, "-D")).toBe(1);
    expect(tunnel).toContain("ExitOnForwardFailure=yes");
    expect(tunnel.some(item => item.startsWith("ClearAllForwardings"))).toBe(false);
  });

  test("a link without an explicit route still reads ssh_config", () => {
    for (const argv of Object.values(builders(null))) expect(argv).not.toContain("-F");
  });
});

describe.skipIf(SSH === null)("ssh -G with a hostile ssh_config", () => {
  let dir = "";
  let hostile = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ocx-no-ssh-config-"));
    mkdirSync(join(dir, "inc"));
    writeFileSync(join(dir, "inc", "extra.conf"), "Host *\n  IdentityFile /tmp/ocx-hostile-included-key\n");
    hostile = join(dir, "hostile.conf");
    writeFileSync(hostile, [
      "Include " + join(dir, "inc", "extra.conf"),
      "Host *",
      "  LocalForward 127.0.0.1:7001 127.0.0.1:22",
      "  RemoteForward 127.0.0.1:7002 127.0.0.1:22",
      "  DynamicForward 127.0.0.1:7003",
      "  SendEnv OCX_HOSTILE_SECRET",
      "  SetEnv OCX_HOSTILE_LEAK=yes",
      "  IdentityFile /tmp/ocx-hostile-key",
      "  CertificateFile /tmp/ocx-hostile-cert",
      "  IdentityAgent /tmp/ocx-hostile-agent.sock",
      "  ControlPersist yes",
      "  GSSAPIAuthentication yes",
      "  GSSAPIDelegateCredentials yes",
      "  Tunnel point-to-point",
      "  RemoteCommand echo hijacked",
      "",
    ].join("\n"));
  });
  afterAll(() => { if (dir) removeTreeWithRetry(dir); });

  /** ssh -G prints the configuration a command would use and connects to nothing; the ProxyCommand never runs. */
  function resolved(argv: readonly string[], config?: string): { code: number; values: Map<string, string[]> } {
    const args = argv.slice(1);
    if (config !== undefined) {
      const at = args.indexOf("-F");
      expect(args[at + 1]).toBe("none");
      args[at + 1] = config;
    }
    const result = Bun.spawnSync([SSH!, "-G", ...args], { stdin: "ignore" });
    const values = new Map<string, string[]>();
    for (const line of result.stdout.toString().split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0) values.set(line.slice(0, space), [...(values.get(line.slice(0, space)) ?? []), line.slice(space + 1)]);
    }
    return { code: result.exitCode ?? -1, values };
  }

  const leaks = (values: Map<string, string[]>) => ({
    localforward: values.get("localforward") ?? [], dynamicforward: values.get("dynamicforward") ?? [],
    sendenv: values.get("sendenv") ?? [], setenv: values.get("setenv") ?? [], certificatefile: values.get("certificatefile") ?? [],
    identityagent: values.get("identityagent") ?? [], remotecommand: values.get("remotecommand") ?? [],
    hostileIdentity: (values.get("identityfile") ?? []).filter(path => path.includes("hostile")),
    gssapi: values.get("gssapiauthentication")?.[0], delegation: values.get("gssapidelegatecredentials")?.[0], tunnel: values.get("tunnel")?.[0],
  });

  test("the harness sees the hostile values when the tunnel is made to read that config", () => {
    const { code, values } = resolved(builders(ROUTE).tunnel, hostile);
    expect(code).toBe(0);
    const seen = leaks(values);
    expect(seen.localforward.length).toBeGreaterThan(0);
    expect(seen.sendenv).toContain("OCX_HOSTILE_SECRET");
    expect(seen.hostileIdentity.length).toBe(2);
    expect(seen.remotecommand).toEqual(["echo hijacked"]);
    expect(values.get("remoteforward")?.length).toBe(2);
  });

  test("a configured RemoteCommand would make every explicit-route exec fail", () => {
    expect(resolved(builders(ROUTE).exec, hostile).code).not.toBe(0);
  });

  test("with -F none nothing from the configuration reaches any command, and the tunnel's only forward is its own", () => {
    const none = { localforward: [], dynamicforward: [], sendenv: [], setenv: [], certificatefile: [], identityagent: [], remotecommand: [], hostileIdentity: [], gssapi: "no", delegation: "no", tunnel: "false" };
    for (const [name, argv] of Object.entries(builders(ROUTE))) {
      const { code, values } = resolved(argv);
      expect({ name, code }).toEqual({ name, code: 0 });
      expect({ name, ...leaks(values) }).toEqual({ name, ...none });
      expect({ name, proxy: values.get("proxycommand"), user: values.get("user"), port: values.get("port"), alias: values.get("hostkeyalias") })
        .toEqual({ name, proxy: [ROUTE.proxyCommand], user: ["ubuntu"], port: ["22"], alias: ["pen-7f3a9c"] });
    }
    expect(resolved(builders(ROUTE).tunnel).values.get("remoteforward")).toEqual(["[127.0.0.1]:19002 [127.0.0.1]:19001"]);
  });
});

