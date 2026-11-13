import { expect, test } from "bun:test";
import { observeChild } from "../../src/link/child-observe";
import { pinnedSync } from "../../src/link/child-ops-runners";
import type { ChildOpsEnv } from "../../src/link/child-ops-types";
import { inspectRemoteChildRuntime, purgeDisconnectRemote } from "../../src/link/remote-plant";
import { requireRemotePlatform, requireRemotePlatformFramed } from "../../src/link/remote-platform";
import type { SshRunner, SshRunResult } from "../../src/link/ssh-runner";
import type { LinkRecord } from "../../src/link/store";

/**
 * O6: the commands a Home runs for an existing link (platform discovery, runtime inspection, purge,
 * observe, the pinned sync) carry the link's explicit route, and none without one.
 */
const ROUTE = { proxyCommand: "/usr/local/bin/pen pipe --node 7f3a9c 22", user: "ubuntu", port: 22 };
const KNOWN_HOSTS = "/tmp/ocx-explicit-route-paths/known_hosts";

function record(overrides: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: "lnk_0123456789abcdef", alias: "pen-7f3a9c", direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstu",
    tunnelPort: 19002, apiKeyId: "link-key", createdAt: "2026-11-13T00:00:00.000Z", ...overrides,
  };
}

function recording(answer: (argv: readonly string[]) => SshRunResult = () => ({ code: 1, stdout: "", stderr: "" })) {
  const seen: string[][] = [];
  const runner: Pick<SshRunner, "run"> = { async run(argv) { seen.push([...argv]); return answer(argv); } };
  return { runner, seen };
}

function routeOf(argv: readonly string[]): { proxy: string[]; user: string[]; port: string[] } {
  const take = (name: string) => argv.filter((value, index) => argv[index - 1] === "-o" && value.startsWith(name + "=")).map(value => value.slice(name.length + 1));
  return { proxy: take("ProxyCommand"), user: take("User"), port: take("Port") };
}

const WITH = { proxy: [ROUTE.proxyCommand], user: ["ubuntu"], port: ["22"] };
const WITHOUT = { proxy: [], user: [], port: [] };

test.each([[ROUTE, WITH], [null, WITHOUT]] as const)("platform discovery, inspection and purge with route %p", async (route, expected) => {
  const { runner, seen } = recording(argv => argv.at(-1) === "cmd /c echo %OS%" ? { code: 127, stdout: "", stderr: "" } : { code: 0, stdout: "Linux\nocx-platform:Linux\n", stderr: "" });
  await requireRemotePlatform(runner, "pen-7f3a9c", route, KNOWN_HOSTS);
  await requireRemotePlatformFramed(runner, "pen-7f3a9c", route, KNOWN_HOSTS);
  await inspectRemoteChildRuntime(runner, "pen-7f3a9c", route, KNOWN_HOSTS, "posix");
  await purgeDisconnectRemote(runner, "pen-7f3a9c", route, KNOWN_HOSTS, "posix", "ephemeral");
  expect(seen.length).toBe(6);
  for (const argv of seen) expect(routeOf(argv)).toEqual(expected);
});

test("observe sends its plan probe over the record's explicit route", async () => {
  const { runner, seen } = recording();
  await observeChild(record({ explicitRoute: ROUTE, exclusive: true, remotePlatform: "posix" }), {
    runner, knownHostsFile: KNOWN_HOSTS, homeVersion: "2.99.0", peer: () => ({ observed: null, refused: null }),
    platformOf: async () => "posix", inspect: inspectRemoteChildRuntime, now: () => new Date(0),
  });
  expect(seen.length).toBeGreaterThan(0);
  for (const argv of seen) expect(routeOf(argv)).toEqual(WITH);
});

test("the pinned sync runs over the record's explicit route", async () => {
  const { runner, seen } = recording();
  const env = { runner, knownHostsFile: KNOWN_HOSTS, catalogEtag: () => null, writeObservation: () => {} } as unknown as ChildOpsEnv;
  await pinnedSync(record({ explicitRoute: ROUTE, exclusive: true, remotePlatform: "posix" }), "posix", "none", env);
  expect(seen.length).toBe(1);
  expect(routeOf(seen[0]!)).toEqual(WITH);
});
