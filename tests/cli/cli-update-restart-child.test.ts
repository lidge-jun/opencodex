import { describe, expect, test } from "bun:test";
import { admitUpdateRestartChild, UPDATE_RESTART_CHILD_ENV, type UpdateRestartChildIo } from "../../src/cli/update-restart-child";
import { OWNERSHIP_MUTATION_LEASE_TOKEN_ENV } from "../../src/service/ownership-mutation-lease.mjs";

function setup() {
  const calls: string[] = [];
  let now = 1000;
  let exit: (() => void) | undefined;
  const marker = { home: { config: { path: "/test/ocx", dev: 1, ino: 2 }, codex: { path: "/test/codex", dev: 1, ino: 3 }, revision: 0, serviceRecord: { schema: 1 as const, digest: "a".repeat(64) } }, version: "2.77.0", port: 10100, hostname: "127.0.0.1", deadlineAt: 5000 };
  const env = { [UPDATE_RESTART_CHILD_ENV]: JSON.stringify(marker), [OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]: "parent-token" };
  const io: UpdateRestartChildIo = {
    checkState: () => {},
    env, now: () => now, version: () => "2.77.0", checkHome: () => { calls.push("home"); },
    acquire: () => { expect(env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]).toBeUndefined(); calls.push("acquire-own"); return { release: () => { calls.push("release-own"); } }; },
    onExit: release => { exit = release; }, armDeadline: () => () => { calls.push("cancel-deadline"); },
  };
  return { io, env, marker, calls, expire: () => { now = 5000; }, exit: () => exit?.() };
}
const argv = ["start", "--port", "10100"];
describe("update restart child admission", () => {
  test("normal invocations do not acquire a lease", () => {
    expect(admitUpdateRestartChild(argv, { env: {}, acquire: () => { throw new Error("unexpected"); } })).toBeUndefined();
  });
  test("strips delegation, owns lease until publication and releases once", () => {
    const s = setup(); const guard = admitUpdateRestartChild(argv, s.io)!;
    expect(s.env[UPDATE_RESTART_CHILD_ENV]).toBeUndefined();
    expect(s.calls).toEqual(["home", "acquire-own", "home"]);
    guard.check(10100); expect(s.calls).not.toContain("release-own");
    guard.complete(); s.exit();
    expect(s.calls.filter(x => x === "release-own")).toHaveLength(1);
  });
  test("expired or malformed marker and changed invocation refuse before acquisition", () => {
    for (const kind of ["expired", "json", "version", "command", "port"] as const) {
      const s = setup();
      if (kind === "expired") s.expire();
      if (kind === "json") s.env[UPDATE_RESTART_CHILD_ENV] = "{";
      if (kind === "version") s.env[UPDATE_RESTART_CHILD_ENV] = JSON.stringify({ ...s.marker, version: "unknown" });
      const args = kind === "command" ? ["ensure"] : kind === "port" ? ["start", "--port", "10101"] : argv;
      expect(() => admitUpdateRestartChild(args, s.io)).toThrow(); expect(s.calls).not.toContain("acquire-own");
    }
  });
  test("home/owner handoff drift after acquisition releases without admitting", () => {
    const s = setup(); let n = 0;
    s.io.checkHome = () => { if (++n === 2) throw new Error("foreign claim"); };
    expect(() => admitUpdateRestartChild(argv, s.io)).toThrow();
    expect(s.calls).toEqual(["acquire-own", "release-own"]);
  });
  test("parent exit does not release child's independently owned lease", () => {
    const s = setup(); const guard = admitUpdateRestartChild(argv, s.io)!;
    // There is no parent token/callback in this guard. Failed bind/rollback leaves custody here.
    s.expire(); expect(() => guard.check()).toThrow();
    expect(s.calls).not.toContain("release-own");
    s.exit(); expect(s.calls.at(-1)).toBe("release-own");
  });
  test("before-bind/publication checks reject deadline, version, port and ownership drift", () => {
    for (const kind of ["deadline", "version", "port", "home"] as const) {
      const s = setup(); const guard = admitUpdateRestartChild(argv, s.io)!;
      if (kind === "deadline") s.expire();
      if (kind === "version") s.io.version = () => "2.76.0";
      if (kind === "home") s.io.checkHome = () => { throw new Error("home changed"); };
      expect(() => guard.check(kind === "port" ? 10101 : 10100)).toThrow();
      expect(s.calls).not.toContain("release-own"); s.exit();
    }
  });
  test("lease timeout refuses without any admission or retry", () => {
    const s = setup(); s.io.acquire = () => { s.calls.push("acquire-own"); throw new Error("busy"); };
    expect(() => admitUpdateRestartChild(argv, s.io)).toThrow(); expect(s.calls).toEqual(["home", "acquire-own"]);
  });
});

test("child rejects client or competing runtime state before admission and later bind", () => {
  for (const phase of ["admission", "bind"] as const) {
    const s = setup();
    if (phase === "admission") s.io.checkState = () => { throw new Error("connected client or foreign runtime"); };
    if (phase === "admission") {
      expect(() => admitUpdateRestartChild(argv, s.io)).toThrow();
      expect(s.calls).not.toContain("acquire-own");
    } else {
      const guard = admitUpdateRestartChild(argv, s.io)!;
      s.io.checkState = () => { throw new Error("connected client or foreign runtime"); };
      expect(() => guard.check()).toThrow(); s.exit();
    }
  }
});
