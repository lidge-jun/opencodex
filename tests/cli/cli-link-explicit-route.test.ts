import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { runLinkCommand, type LinkCliDeps } from "../../src/cli/link";

/** O6: ocx link probe|add carry --proxy-command, --ssh-user, --ssh-port and --exclusive to all three requests. */
const fingerprint = "SHA256:abcdefghijklmnop";
const probe = { alias: "pen-7f3a9c", fingerprint, keyType: "ED25519", ocxVersion: "2.99.0" };
const confirm = { alias: probe.alias, fingerprint, ocxVersion: probe.ocxVersion };
const linkId = "lnk_0123456789abcdef";
const COMMAND = "/usr/local/bin/pen pipe --node 7f3a9c --noise noise-pub-7f3a9c 22";
const ROUTE_FLAGS = ["--proxy-command", COMMAND, "--ssh-user", "ubuntu", "--ssh-port", "22", "--exclusive"];
const ROUTE_BODY = { explicitRoute: { proxyCommand: COMMAND, user: "ubuntu", port: 22 }, exclusive: true };

function harness(bodies: unknown[] = [probe, confirm, { linkId }]) {
  const calls: { path: string; body: unknown }[] = [], out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  const deps: LinkCliDeps = { baseUrl: "http://127.0.0.1:10100", readAdminToken: () => "ocx_admin_test",
    stdinImpl: Object.assign(Readable.from([]), { isTTY: false }),
    fetchImpl: async (url, init) => { calls.push({ path: new URL(String(url)).pathname, body: JSON.parse(String(init?.body)) }); return Response.json(bodies.shift()); } };
  return { calls, out, err, deps, restore: () => { console.log = log; console.error = error; } };
}

test("add sends the explicit route and exclusive with probe, confirm and apply", async () => {
  const h = harness(); try {
    expect(await runLinkCommand(["add", "pen-7f3a9c", "--expect-fingerprint", fingerprint, ...ROUTE_FLAGS, "--json"], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      { path: "/api/link/probe", body: { alias: "pen-7f3a9c", includeVersion: true, allowMissing: true, ...ROUTE_BODY } },
      { path: "/api/link/confirm-host", body: { alias: "pen-7f3a9c", fingerprint, ...ROUTE_BODY } },
      { path: "/api/link/apply", body: { alias: "pen-7f3a9c", fingerprint, ...ROUTE_BODY } },
    ]);
    expect(JSON.parse(h.out[0]!)).toEqual({ linkId, alias: "pen-7f3a9c", state: "connected", childRole: "client", exclusive: true });
  } finally { h.restore(); }
});

test("probe sends the route; exclusive alone is sent without a route", async () => {
  const h = harness([probe]); try {
    expect(await runLinkCommand(["probe", "pen-7f3a9c", ...ROUTE_FLAGS, "--json"], h.deps)).toBe(0);
    expect(h.calls).toEqual([{ path: "/api/link/probe", body: { alias: "pen-7f3a9c", includeVersion: true, ...ROUTE_BODY } }]);
  } finally { h.restore(); }
  const g = harness(); try {
    expect(await runLinkCommand(["add", "pen-7f3a9c", "--expect-fingerprint", fingerprint, "--exclusive"], g.deps)).toBe(0);
    expect(g.calls.map(call => call.body)).toEqual([
      { alias: "pen-7f3a9c", includeVersion: true, allowMissing: true, exclusive: true },
      { alias: "pen-7f3a9c", fingerprint, exclusive: true },
      { alias: "pen-7f3a9c", fingerprint, exclusive: true },
    ]);
  } finally { g.restore(); }
});

test.each([
  ["a route without --exclusive", ["--proxy-command", COMMAND, "--ssh-user", "ubuntu", "--ssh-port", "22"]],
  ["a route without a port", ["--proxy-command", COMMAND, "--ssh-user", "ubuntu", "--exclusive"]],
  ["a shell word", ["--proxy-command", "/usr/bin/pen pipe; id", "--ssh-user", "ubuntu", "--ssh-port", "22", "--exclusive"]],
  ["a relative program", ["--proxy-command", "pen pipe", "--ssh-user", "ubuntu", "--ssh-port", "22", "--exclusive"]],
  ["an option as the user", ["--proxy-command", COMMAND, "--ssh-user", "-oProxyCommand=x", "--ssh-port", "22", "--exclusive"]],
  ["a port with a sign", ["--proxy-command", COMMAND, "--ssh-user", "ubuntu", "--ssh-port", "+22", "--exclusive"]],
  ["port 0", ["--proxy-command", COMMAND, "--ssh-user", "ubuntu", "--ssh-port", "0", "--exclusive"]],
])("%s is a usage error before any request", async (_label, flags) => {
  const h = harness(); try {
    expect(await runLinkCommand(["add", "pen-7f3a9c", "--expect-fingerprint", fingerprint, ...flags], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  } finally { h.restore(); }
});

test("without the new flags every request body is what it was", async () => {
  const h = harness(); try {
    expect(await runLinkCommand(["add", "pen-7f3a9c", "--expect-fingerprint", fingerprint], h.deps)).toBe(0);
    expect(h.calls.map(call => call.body)).toEqual([
      { alias: "pen-7f3a9c", includeVersion: true, allowMissing: true },
      { alias: "pen-7f3a9c", fingerprint },
      { alias: "pen-7f3a9c", fingerprint },
    ]);
  } finally { h.restore(); }
});
