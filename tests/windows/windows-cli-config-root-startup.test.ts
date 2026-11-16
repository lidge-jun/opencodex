import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as paths from "../../src/config/paths";
import { settleConfigRootForCli } from "../../src/cli/config-root-startup";
import { resetHardenedStateForTests, setAsyncIcaclsBeltSchedulerForTests, setAsyncIcaclsRunnerForTests,
  setIcaclsRunnerForTests, setNowForTests, setPlatformForTests, type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

/**
 * #7815 owner decision: the CLI waits once at startup for the optional config-root ACL flight
 * before an eligible command does its first write. Commands exempt from preflight repair
 * (skipsCodexShimAutoRestore), internal and hidden helpers, ensure and the long-lived server never
 * start or wait for it; other read-only commands do wait, as structure/config.md records.
 */
const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const turn = () => new Promise<void>(done => setImmediate(done));
const keys = ["OPENCODEX_HOME", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"] as const;
let root: string;
let previous: (string | undefined)[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-cli-config-root-startup-"));
  previous = keys.map(key => process.env[key]);
  process.env.OPENCODEX_HOME = root; process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  resetHardenedStateForTests(); setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001"); setIcaclsRunnerForTests(() => success);
});
afterEach(async () => {
  await paths.flushConfigDirHardeningAndReaps(root);
  setAsyncIcaclsRunnerForTests(null); setAsyncIcaclsBeltSchedulerForTests(null);
  setNowForTests(null); setIcaclsRunnerForTests(null); setPlatformForTests(null);
  setSyntheticWindowsPrincipalForTests(null); resetHardenedStateForTests();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  });
  removeTreeWithRetry(root);
});

function holdFlight() {
  let entered = 0;
  let release!: () => void;
  const released = new Promise<void>(done => { release = done; });
  setAsyncIcaclsRunnerForTests(async () => { entered += 1; await released; return success; });
  return { entered: () => entered, release };
}

test("a writing command waits for the config-root flight it starts", async () => {
  const flight = holdFlight();
  let settled = false;
  const work = settleConfigRootForCli("config", ["config", "set", "effortCap", "high"]).then(() => { settled = true; });
  await turn(); await turn();
  expect(flight.entered()).toBeGreaterThan(0);
  expect(settled).toBe(false);
  flight.release();
  await work;
  expect(settled).toBe(true);
});

test.each([
  ["resolve", ["resolve", "--json"]],
  ["system", ["system", "codex-cli-update", "check"]],
  ["stop", ["stop", "--json", "--expect-pid", "4242"]],
  ["codex", ["codex", "exec", "hi"]],
  ["service", ["service", "status", "--json"]],
  ["internal", ["internal", "chatgpt-app-server-filter"]],
  ["start", ["start"]],
  ["ensure", ["ensure"]],
  ["__startup-health", ["__startup-health"]],
  ["__tray-start", ["__tray-start"]],
] as const)("%s %j neither starts nor waits for the flight", async (command, args) => {
  const flight = holdFlight();
  await settleConfigRootForCli(command, [...args]);
  expect(flight.entered()).toBe(0);
});

test("POSIX never waits", async () => {
  setPlatformForTests("linux");
  const flight = holdFlight();
  await settleConfigRootForCli("config", ["config", "set", "effortCap", "high"]);
  expect(flight.entered()).toBe(0);
});

test("a flight that outlives the ACL deadline lets the command proceed", async () => {
  let now = 0;
  const timers = new Map<() => void, number>();
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests((callback, ms) => { timers.set(callback, now + ms); return () => { timers.delete(callback); }; });
  const flight = holdFlight();
  let settled = false;
  const work = settleConfigRootForCli("config", ["config", "set", "effortCap", "high"]).then(() => { settled = true; });
  await turn(); await turn();
  expect(settled).toBe(false);
  now += 1_000;
  for (const [callback, deadline] of timers) if (deadline <= now) { timers.delete(callback); callback(); }
  await work;
  expect(settled).toBe(true);
  flight.release();
});

test("runCli awaits the startup wait before the version-skew notice and the shim preflight", () => {
  const source = readFileSync(repoPath("src", "cli", "root.ts"), "utf8");
  const command = source.slice(source.indexOf('case "command":'));
  const wait = command.indexOf("await settleConfigRootForCli(head.command, head.args);");
  expect(wait).toBeGreaterThan(-1);
  expect(wait).toBeLessThan(command.indexOf("await maybeNoticeVersionSkew("));
  expect(wait).toBeLessThan(command.indexOf("await maybeAutoRestoreCodexShimAsync("));
});
