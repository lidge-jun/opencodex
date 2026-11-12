import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { buildRouteProbeArgv, buildTunnelArgv } from "../../src/link/ssh-argv";
import { createSshRunner, type SshChild } from "../../src/link/ssh-runner";
import { composeGrantTap, routeOutcomeOfStderr } from "../../src/link/route-select";
import { checkRouteTrust, confirmedLineTrust, keyFingerprint } from "../../src/link/route-trust";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Real OpenSSH evidence for multi-route links. ssh -G (no connection) shows the pin options win
 * over a hostile per-destination config. The opt-in fixture (OCX_OPENSSH_ROUTE_FIXTURE=1) starts
 * no daemon and opens no port of its own: each route's ProxyCommand runs a private "sshd -i" as
 * the current user with a temporary host key, so the actual builders meet a real server.
 */
// The opt-in fixture starts real sshd sessions; one ceiling for the whole file instead of one per test.
setDefaultTimeout(60_000);
const SSH = Bun.which("ssh");
const SSHD = "/usr/sbin/sshd";
const FIXTURE = process.env.OCX_OPENSSH_ROUTE_FIXTURE === "1" && SSH !== null && existsSync(SSHD);

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "ocx-route-ssh-")); });
afterAll(() => { if (dir) removeTreeWithRetry(dir); });

function effective(argv: readonly string[], config: string): Map<string, string> {
  // Same options and destination as the builder, but -G prints the resolved configuration and exits.
  const result = Bun.spawnSync([SSH!, "-G", "-F", config, ...argv.slice(argv.indexOf("-o"))]);
  expect(result.exitCode).toBe(0);
  const values = new Map<string, string>();
  for (const line of result.stdout.toString().split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) values.set(line.slice(0, space), line.slice(space + 1));
  }
  return values;
}

describe.skipIf(SSH === null)("ssh -G with a hostile per-destination config", () => {
  test("the pinned alias, strict checking and the link known_hosts win for tunnel and probe", () => {
    const config = join(dir, "hostile.conf");
    const knownHosts = join(dir, "link-known-hosts");
    writeFileSync(config, [
      "Host route-x",
      "  HostKeyAlias someone-else",
      "  StrictHostKeyChecking no",
      "  UserKnownHostsFile " + join(dir, "other-known-hosts"),
      "  GlobalKnownHostsFile " + join(dir, "other-global"),
      "  CheckHostIP yes",
      "  CanonicalizeHostname yes",
      "  CanonicalDomains example.test",
      "Match host route-x",
      "  HostKeyAlias matched-other",
      "  UpdateHostKeys yes",
      "",
    ].join("\n"));
    const tunnel = buildTunnelArgv({ alias: "pin-alias", destination: "route-x", direction: "R", bindPort: 19002, targetPort: 19001, knownHostsFile: knownHosts, logLevel: "DEBUG1" });
    const probe = buildRouteProbeArgv({ alias: "pin-alias", destination: "route-x", knownHostsFile: knownHosts });
    for (const argv of [tunnel, probe.slice(0, -1)]) {
      const values = effective(argv, config);
      expect(values.get("hostkeyalias")).toBe("pin-alias");
      expect(values.get("stricthostkeychecking")).toBe("true");
      expect(values.get("userknownhostsfile")).toBe(knownHosts);
      expect(values.get("globalknownhostsfile")).toBe("none");
      expect(values.get("checkhostip")).toBe("no");
      expect(values.get("updatehostkeys")).toBe("false");
    }
  });
});

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe.skipIf(!FIXTURE)("real OpenSSH routes (OCX_OPENSSH_ROUTE_FIXTURE=1)", () => {
  const keygen = (name: string) => expect(Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]).exitCode).toBe(0);
  let config = "";
  let knownHosts = "";
  const withConfig = (argv: readonly string[]) => [argv[0]!, "-F", config, ...argv.slice(1)];

  beforeAll(() => {
    keygen("hk-pinned"); keygen("hk-other"); keygen("client");
    writeFileSync(join(dir, "authorized_keys"), readFileSync(join(dir, "client.pub")));
    const sshd = (name: string, hostKey: string, forwarding: "yes" | "no") => writeFileSync(join(dir, name), [
      "HostKey " + join(dir, hostKey), "AuthorizedKeysFile " + join(dir, "authorized_keys"), "StrictModes no", "UsePAM no",
      "PasswordAuthentication no", "KbdInteractiveAuthentication no", "AllowTcpForwarding " + forwarding, "LogLevel ERROR", "",
    ].join("\n"));
    sshd("sshd-a.conf", "hk-pinned", "yes");
    sshd("sshd-b.conf", "hk-other", "yes");
    sshd("sshd-c.conf", "hk-pinned", "no");
    config = join(dir, "ssh.conf");
    const host = (name: string, sshdConfig: string) => [
      "Host " + name, "  ProxyCommand " + SSHD + " -i -f " + join(dir, sshdConfig), "  User " + userInfo().username,
      "  IdentityFile " + join(dir, "client"), "  IdentitiesOnly yes",
    ].join("\n");
    // route-d reaches the pinned machine but names another port: HostKeyAlias lookups ignore the port.
    writeFileSync(config, [host("route-a", "sshd-a.conf"), host("route-b", "sshd-b.conf"), host("route-c", "sshd-c.conf"), host("route-d", "sshd-a.conf") + "\n  Port 2222", ""].join("\n"));
    knownHosts = join(dir, "known_hosts");
    const [type, key] = readFileSync(join(dir, "hk-pinned.pub"), "utf8").split(" ");
    writeFileSync(knownHosts, "pin-alias " + type + " " + key + "\n");
  });

  test("the route probe passes on the pinned machine and is refused on another key, writing nothing", async () => {
    const runner = createSshRunner();
    const before = readFileSync(knownHosts, "utf8");
    const pinned = await runner.run(withConfig(buildRouteProbeArgv({ alias: "pin-alias", destination: "route-a", knownHostsFile: knownHosts })), { timeoutMs: 20_000 });
    expect({ code: pinned.code, stdout: pinned.stdout.trim() }).toEqual({ code: 0, stdout: "ocx-link-probe" });
    const other = await runner.run(withConfig(buildRouteProbeArgv({ alias: "pin-alias", destination: "route-b", knownHostsFile: knownHosts })), { timeoutMs: 20_000 });
    expect(other.code).toBe(255);
    expect(routeOutcomeOfStderr(other.stderr)).toBe("hostkey");
    expect(readFileSync(knownHosts, "utf8")).toBe(before);
  });

  test("OpenSSH confirms a granted -R, carries bytes through it, and refuses a second session the same port", async () => {
    const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("through the route") });
    const bind = await freePort();
    const runner = createSshRunner();
    const verdicts: string[] = [];
    const children: SshChild[] = [];
    const tunnel = (destination: string, onVerdict: (verdict: string) => void) => {
      const argv = buildTunnelArgv({ alias: "pin-alias", destination, direction: "R", bindPort: bind, targetPort: target.port!, knownHostsFile: knownHosts, logLevel: "DEBUG1" });
      const child = runner.spawnTunnel(withConfig(argv), { stderrLine: composeGrantTap(bind, target.port!, verdict => { verdicts.push(destination + ":" + verdict); onVerdict(verdict); }) });
      children.push(child);
      return child;
    };
    try {
      let granted!: () => void;
      const grant = new Promise<void>(resolve => { granted = resolve; });
      const first = tunnel("route-a", verdict => { if (verdict === "granted") granted(); });
      await Promise.race([grant, first.exited.then(code => { throw new Error("tunnel exited " + code); })]);
      expect(await (await fetch("http://127.0.0.1:" + bind + "/")).text()).toBe("through the route");

      const second = tunnel("route-a", () => {});
      expect(await second.exited).toBe(255);
      expect(verdicts).toContain("route-a:refused");
      expect(routeOutcomeOfStderr(await second.stderr!)).toBe("forward");
      expect(await (await fetch("http://127.0.0.1:" + bind + "/")).text()).toBe("through the route");

      first.kill("SIGTERM");
      await first.exited;
      const forbidden = tunnel("route-c", () => {});
      expect(await forbidden.exited).toBe(255);
      expect(verdicts).toContain("route-c:refused");
    } finally {
      for (const child of children) child.kill("SIGTERM");
      await Promise.allSettled(children.map(child => child.exited));
      target.stop(true);
    }
  });

  test("a route on another port is still checked under the bare alias", async () => {
    const runner = createSshRunner();
    const probe = await runner.run(withConfig(buildRouteProbeArgv({ alias: "pin-alias", destination: "route-d", knownHostsFile: knownHosts })), { timeoutMs: 20_000 });
    expect({ code: probe.code, stdout: probe.stdout.trim() }).toEqual({ code: 0, stdout: "ocx-link-probe" });
  });

  test("OpenSSH accepts a second key stored under a case variant of the alias; the route trust check refuses that file", async () => {
    const [type, pinnedKey] = readFileSync(join(dir, "hk-pinned.pub"), "utf8").split(" ");
    const [otherType, otherKey] = readFileSync(join(dir, "hk-other.pub"), "utf8").split(" ");
    const mixed = join(dir, "known_hosts-mixed-case");
    const text = "pin-alias " + type + " " + pinnedKey + "\nPIN-ALIAS " + otherType + " " + otherKey + "\n";
    writeFileSync(mixed, text);
    const runner = createSshRunner();
    const other = await runner.run(withConfig(buildRouteProbeArgv({ alias: "pin-alias", destination: "route-b", knownHostsFile: mixed })), { timeoutMs: 20_000 });
    expect({ code: other.code, stdout: other.stdout.trim() }).toEqual({ code: 0, stdout: "ocx-link-probe" });
    expect(checkRouteTrust(text, "pin-alias", keyFingerprint(pinnedKey!))).toEqual({ ok: false, code: "pin_mismatch" });
  });

  test("OpenSSH lowercases HostKeyAlias before it hashes it: a hashed line matches the lowercased alias only", async () => {
    const [type, pinnedKey] = readFileSync(join(dir, "hk-pinned.pub"), "utf8").split(" ");
    const hashed = (name: string) => {
      const salt = randomBytes(20);
      return "|1|" + salt.toString("base64") + "|" + createHmac("sha1", salt).update(name).digest("base64");
    };
    const runner = createSshRunner();
    const probe = async (alias: string, hashedName: string) => {
      const file = join(dir, "known_hosts-hashed-" + alias + "-" + hashedName);
      writeFileSync(file, hashed(hashedName) + " " + type + " " + pinnedKey!.trim() + "\n");
      const result = await runner.run(withConfig(buildRouteProbeArgv({ alias, destination: "route-a", knownHostsFile: file })), { timeoutMs: 20_000 });
      return result.code;
    };
    expect({ lowerLine: await probe("PIN-ALIAS", "pin-alias"), exactLine: await probe("PIN-ALIAS", "PIN-ALIAS"), plain: await probe("pin-alias", "pin-alias") })
      .toEqual({ lowerLine: 0, exactLine: 255, plain: 0 });
  });

  test("OpenSSH accepts another key from a wildcard, host list or hashed line beside the confirmed one; apply's check refuses each", async () => {
    const [type, pinnedKey] = readFileSync(join(dir, "hk-pinned.pub"), "utf8").split(" ");
    const [otherType, otherKey] = readFileSync(join(dir, "hk-other.pub"), "utf8").split(" ");
    const confirmed = "pin-alias " + type + " " + pinnedKey;
    const salt = randomBytes(20);
    const hashed = "|1|" + salt.toString("base64") + "|" + createHmac("sha1", salt).update("pin-alias").digest("base64");
    const runner = createSshRunner();
    for (const [label, host] of [["wildcard", "pin-*"], ["host list", "elsewhere,pin-alias"], ["hashed", hashed]] as const) {
      const file = join(dir, "known_hosts-extra-" + label.replace(" ", "-"));
      const text = confirmed + "\n" + host + " " + otherType + " " + otherKey!.trim() + "\n";
      writeFileSync(file, text);
      const other = await runner.run(withConfig(buildRouteProbeArgv({ alias: "pin-alias", destination: "route-b", knownHostsFile: file })), { timeoutMs: 20_000 });
      expect({ label, code: other.code, stdout: other.stdout.trim() }).toEqual({ label, code: 0, stdout: "ocx-link-probe" });
      // A hashed line for the alias is a second key for it; a pattern or list cannot be ruled out at all.
      expect({ label, trust: confirmedLineTrust(text, "pin-alias", confirmed) }).toEqual({ label, trust: label === "hashed" ? "key_changed" : "trust_file_unexpected" });
    }
  });
});
