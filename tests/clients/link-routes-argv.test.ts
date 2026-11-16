import { expect, test } from "bun:test";
import { buildExecArgv, buildRouteProbeArgv, buildTunnelArgv, LinkSshArgumentError } from "../../src/link/ssh-argv";

const KNOWN_HOSTS = "/tmp/ocx-link-routes/known_hosts";

function option(argv: readonly string[], name: string): string | undefined {
  const values = argv.filter((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "="));
  expect(values.length).toBeLessThanOrEqual(1);
  return values[0]?.slice(name.length + 1);
}

function destination(argv: readonly string[]): string | undefined {
  return argv[argv.indexOf("--") + 1];
}

test("a tunnel on a route keeps the link alias as the pinned host key name and connects to the route", () => {
  const argv = buildTunnelArgv({ alias: "pen-alpha", destination: "alpha-lan", direction: "R", bindPort: 10100, targetPort: 20100, knownHostsFile: KNOWN_HOSTS });
  expect(option(argv, "HostKeyAlias")).toBe("pen-alpha");
  expect(option(argv, "StrictHostKeyChecking")).toBe("yes");
  expect(option(argv, "UserKnownHostsFile")).toBe(KNOWN_HOSTS);
  expect(destination(argv)).toBe("alpha-lan");
  expect(argv.at(-1)).toBe("alpha-lan");
  expect(argv.filter(value => value === "pen-alpha")).toEqual([]);
});

test("a tunnel without a route is the argv an origin/dev Home builds", () => {
  const base = { alias: "pen-alpha", direction: "R" as const, bindPort: 10100, targetPort: 20100, knownHostsFile: KNOWN_HOSTS };
  expect(buildTunnelArgv({ ...base, destination: "pen-alpha" })).toEqual(buildTunnelArgv(base));
  expect(destination(buildTunnelArgv(base))).toBe("pen-alpha");
});

test("the route probe is pinned and strict: it never trusts a key on first use", () => {
  const argv = buildRouteProbeArgv({ alias: "pen-alpha", destination: "alpha-lan", knownHostsFile: KNOWN_HOSTS });
  expect(argv.slice(0, 2)).toEqual(["ssh", "-T"]);
  expect(option(argv, "HostKeyAlias")).toBe("pen-alpha");
  expect(option(argv, "StrictHostKeyChecking")).toBe("yes");
  expect(option(argv, "UserKnownHostsFile")).toBe(KNOWN_HOSTS);
  expect(option(argv, "UpdateHostKeys")).toBe("no");
  expect(option(argv, "GlobalKnownHostsFile")).toBe("none");
  expect(option(argv, "ClearAllForwardings")).toBe("yes");
  expect(argv).not.toContain("StrictHostKeyChecking=accept-new");
  expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["alpha-lan", "echo ocx-link-probe"]);
});

test("an exec on a route keeps the pin and connects to the route", () => {
  const argv = buildExecArgv({ alias: "pen-alpha", destination: "alpha-lan", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS });
  expect(option(argv, "HostKeyAlias")).toBe("pen-alpha");
  expect(destination(argv)).toBe("alpha-lan");
  expect(buildExecArgv({ alias: "pen-alpha", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS }))
    .toEqual(buildExecArgv({ alias: "pen-alpha", destination: "pen-alpha", argv: ["sh", "-c", "true"], knownHostsFile: KNOWN_HOSTS }));
});

test.each(["-oProxyCommand=sh", "alpha lan", "", "alpha\nlan"])("route %j is refused by every builder", route => {
  expect(() => buildTunnelArgv({ alias: "pen-alpha", destination: route, direction: "R", bindPort: 10100, targetPort: 20100, knownHostsFile: KNOWN_HOSTS })).toThrow(LinkSshArgumentError);
  expect(() => buildRouteProbeArgv({ alias: "pen-alpha", destination: route, knownHostsFile: KNOWN_HOSTS })).toThrow(LinkSshArgumentError);
  expect(() => buildExecArgv({ alias: "pen-alpha", destination: route, argv: ["true"], knownHostsFile: KNOWN_HOSTS })).toThrow(LinkSshArgumentError);
});
