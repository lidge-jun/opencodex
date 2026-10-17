import { expect, test } from "bun:test";
import { createUpdateServiceHomePolicy, isUpdateHomeProbe, parseUpdateHomeProbe, type UpdateServiceHomeAuthority } from "../../src/update/service-home-policy.mjs";
import { probeUpdatePackageOnlyLauncher, probeUpdateServiceHome, probeUpdateLauncherHome, updateHomeProbeEnvironment } from "../../src/update/service-home-probe.mjs";

const subject = "a".repeat(64);
const other = "b".repeat(64);
test("narrow update-home command requires exact ordered argv", () => {
  expect(isUpdateHomeProbe(["__update-home-probe"])).toBe(true);
  for (const argv of [["status", "--json"], ["status", "--update-home-only", "--json"],
    ["status", "--json", "--update-home-only", "extra"], ["update", "--json", "--update-home-only"]]) {
    expect(isUpdateHomeProbe(argv)).toBe(false);
  }
});

test("child schema is not evidence of its Node parent's protocol", () => {
  const child = { schemaVersion: 1, kind: "foreign", subject };
  expect(parseUpdateHomeProbe(child)).toEqual({ kind: "foreign", subject });
  // An old launcher can forward the new CLI response verbatim.
  expect(parseUpdateHomeProbe(child, { requireLauncher: true })).toEqual({ kind: "unknown" });
  expect(parseUpdateHomeProbe({ ...child, launcherProtocolVersion: 1 }, { requireLauncher: true }))
    .toEqual({ kind: "foreign", subject });
});

test("unsupported or malformed protocol is unknown, never absence", () => {
  for (const value of [undefined, null, "", [], {}, { schemaVersion: 1, kind: "foreign" },
    { schemaVersion: 2, kind: "absent" }, { schemaVersion: 1, kind: "same", subject },
    { schemaVersion: 1, kind: "absent", launcherProtocolVersion: 2 },
    { schemaVersion: 1, kind: "foreign", subject: "private-path" },
    { schemaVersion: 1, kind: "same", startup: {} }]) {
    expect(parseUpdateHomeProbe(value)).toEqual({ kind: "unknown" });
  }
  for (const kind of ["same", "absent", "unknown"] as const) {
    expect(parseUpdateHomeProbe({ schemaVersion: 1, kind })).toEqual({ kind });
  }
});

test("transition policy preserves only stable foreign foreground authority", () => {
  const cases: [UpdateServiceHomeAuthority, UpdateServiceHomeAuthority, boolean][] = [
    [{ kind: "same" }, { kind: "same" }, true], [{ kind: "same" }, { kind: "absent" }, true],
    [{ kind: "same" }, { kind: "foreign", subject }, false], [{ kind: "same" }, { kind: "unknown" }, false],
    [{ kind: "absent" }, { kind: "absent" }, true], [{ kind: "absent" }, { kind: "same" }, false],
    [{ kind: "foreign", subject }, { kind: "foreign", subject }, true],
    [{ kind: "foreign", subject }, { kind: "foreign", subject: other }, false],
    [{ kind: "foreign", subject }, { kind: "absent" }, false],
    [{ kind: "foreign" }, { kind: "foreign" }, false], [{ kind: "unknown" }, { kind: "absent" }, false],
  ];
  for (const [initial, current, allowed] of cases) {
    const messages: string[] = [];
    const policy = createUpdateServiceHomePolicy(() => initial, message => messages.push(message));
    expect(policy.check(current)).toBe(allowed);
    expect(policy.serviceAllowed).toBe(current.kind === "same");
    expect(messages.length).toBe(allowed ? 0 : 1);
    expect(messages.join()).not.toContain(subject);
  }
});

test("probe rejects old CLI, timeout, nonzero and oversized output without another command", () => {
  for (const result of [{ status: 1, stdout: "unknown flag" }, { status: null, error: new Error("timeout") },
    { status: 0, stdout: "{" }, { status: 0, stdout: " ".repeat(4097) },
    { status: 0, stdout: '{"schemaVersion":1,"kind":"absent"}', signal: "SIGTERM" }]) {
    let calls = 0;
    expect(probeUpdateServiceHome((_bin, args, options) => {
      calls++;
      expect(args).toEqual(["/fixed/launcher", "__update-home-probe"]);
      expect(options).toMatchObject({ timeout: 8000, maxBuffer: 4096, windowsHide: true });
      return result;
    }, "/fixed/node", ["/fixed/launcher"], { requireLauncher: true })).toEqual({ kind: "unknown" });
    expect(calls).toBe(1);
  }
  expect(probeUpdateServiceHome(() => { throw new Error("spawn failed"); }, "/node", []))
    .toEqual({ kind: "unknown" });
});

test("missing or invalid package capability never executes the old launcher", () => {
  for (const read of [() => { throw new Error("missing"); }, () => "{}", () => '{"schemaVersion":2}']) {
    let calls = 0;
    expect(probeUpdateLauncherHome("/fixed/launcher", () => { calls++; return { status: 0 }; }, "/node", {}, read))
      .toEqual({ kind: "unknown" });
    expect(calls).toBe(0);
  }
  const read = () => '{"schemaVersion":1,"launcherProtocolVersion":1,"entry":"__update-home-probe"}';
  for (const marker of [undefined, 1]) {
    expect(probeUpdateLauncherHome("/fixed/launcher", () => ({ status: 0,
      stdout: JSON.stringify({ schemaVersion: 1, kind: "same", launcherProtocolVersion: marker }) }), "/node", {}, read))
      .toEqual({ kind: marker ? "same" : "unknown" });
  }
});

test("probe pins homes, keeps authoritative SQLite/auth inputs and scrubs only internal tokens", () => {
  const env = updateHomeProbeEnvironment({ CODEX_HOME: "old", OPENCODEX_HOME: "old", CODEX_SQLITE_HOME: "sqlite",
    ANTHROPIC_API_KEY: "fixture", OCX_USER_CHOICE: "keep", OCX_UPDATE_RESTART_CHILD: "remove",
    OCX_OWNERSHIP_MUTATION_LEASE_TOKEN: "remove", OCX_SERVICE: "remove", OCX_NODE_LAUNCH_CONTEXT: "remove" },
  { codexHome: "codex", opencodexHome: "proxy" });
  expect(env).toEqual({ CODEX_HOME: "codex", OPENCODEX_HOME: "proxy", CODEX_SQLITE_HOME: "sqlite",
    ANTHROPIC_API_KEY: "fixture", OCX_USER_CHOICE: "keep" });
});

test("initial unknown permits package replacement but never grants runtime control", () => {
  let home: UpdateServiceHomeAuthority = { kind: "unknown" };
  const messages: string[] = [];
  const policy = createUpdateServiceHomePolicy(() => home, message => messages.push(message));
  expect(policy.packageOnly).toBe(true);
  expect(policy.checkPackage()).toBe(true);
  expect(policy.check()).toBe(false);
  expect(policy.serviceAllowed).toBe(false);
  for (const kind of ["same", "absent", "foreign"] as const) {
    home = { kind, ...(kind === "foreign" ? { subject } : {}) };
    expect(policy.checkPackage()).toBe(false);
    expect(policy.packageOnly).toBe(true);
    expect(policy.serviceAllowed).toBe(false);
  }
  const known = createUpdateServiceHomePolicy(() => ({ kind: "same" }), () => {});
  expect(known.checkPackage({ kind: "unknown" })).toBe(false);
});

test("package-only capability rejects old declarations and malformed or failed responses", () => {
  const declaration = (path: string) => path.endsWith("service-home-protocol.json")
    ? '{"schemaVersion":1,"launcherProtocolVersion":1,"entry":"__update-home-probe"}'
    : '{"schemaVersion":1,"packageOnlyProtocolVersion":1,"entry":"__update-package-only-probe"}';
  const response = { schemaVersion: 1, packageOnlyProtocolVersion: 1 };
  for (const value of [response, { ...response, extra: true }, { ...response, packageOnlyProtocolVersion: 2 }, null]) {
    const result = probeUpdatePackageOnlyLauncher("/launcher", () => ({ status: 0, stdout: JSON.stringify(value) }), "/node", {}, declaration);
    expect(result).toBe(value === response);
  }
  expect(probeUpdatePackageOnlyLauncher("/launcher", () => ({ status: null, error: new Error("timeout") }), "/node", {}, declaration)).toBe(false);
  let calls = 0;
  expect(probeUpdatePackageOnlyLauncher("/launcher", () => { calls++; return { status: 0 }; }, "/node", {}, path => {
    if (path.endsWith("service-home-package-only-protocol.json")) throw new Error("old package");
    return declaration(path);
  })).toBe(false);
  expect(calls).toBe(0);
});

test("a parent package-only restriction cannot be upgraded by a matching child probe", () => {
  const messages: string[] = [];
  const policy = createUpdateServiceHomePolicy(() => ({ kind: "same" }), message => messages.push(message), true);
  expect(policy.packageOnly).toBe(true); expect(policy.serviceAllowed).toBe(false);
  expect(policy.checkPackage()).toBe(true); expect(policy.check()).toBe(false);
  expect(messages.join()).toContain("ownership could not be verified");
  expect(policy.checkPackage({ kind: "foreign", subject })).toBe(false);
});
