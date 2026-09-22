import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUpdateRuntimeTarget } from "../../src/update/ownership-transaction";
import { createTempHome } from "../helpers/temp-home";
import { helperPath, repoRoot } from "../helpers/repo-root";

type Event = { phase: string; contenderBlocked?: boolean; delegated?: boolean; canJoin?: boolean; reacquired?: boolean; parentToken?: boolean; pidBound?: boolean; healthy?: boolean; childPid?: number };
async function run(scenario: string) {
  const home = createTempHome("ocx-bun-update-lease-");
  try {
    mkdirSync(home.codexHome);
    writeFileSync(home.path("config.json"), JSON.stringify({ port: 23456, providers: {} }));
    const child = Bun.spawn([process.execPath, helperPath("update-bun-ownership-child.ts"), home.root, scenario], {
      cwd: repoRoot(), env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const receipt = out.split("\n").find(line => line.startsWith("UPDATE_LEASE_PROBE:"));
    expect(receipt, out + err).toBeDefined();
    const trace = JSON.parse(receipt!.slice("UPDATE_LEASE_PROBE:".length)) as Event[];
    const pid = trace.at(-1)?.childPid;
    if (pid) {
      const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const deadline = Date.now() + 2_000;
      while (alive() && Date.now() < deadline) await Bun.sleep(20);
      expect(alive(), "owned recovery fixture must exit").toBe(false);
    }
    return { exit, trace, log: out + err };
  } finally { home.remove(); }
}

test.skipIf(process.platform === "win32")("the actual Bun updater leases stop through replacement and strips package capabilities", async () => {
  const result = await run("success");
  expect(result.exit, result.log).toBe(0);
  for (const phase of ["stop", "replacement", "recovery"]) {
    const event = result.trace.find(row => row.phase === phase);
    expect(event, result.log).toBeDefined();
    expect(event?.contenderBlocked).toBe(true);
    expect(event?.delegated).toBe(phase !== "replacement");
    expect(event?.canJoin).toBe(phase !== "replacement");
  }
  expect(result.trace.at(-1)).toMatchObject({ phase: "after", reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["package-fail", "stop-throw", "replacement-throw", "recovery-throw"])("%s keeps recovery owned and releases before exit", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).not.toBe(0);
  const recovery = result.trace.find(row => row.phase === "recovery");
  expect(recovery, result.log).toMatchObject({ contenderBlocked: true, delegated: true, canJoin: true });
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["foreign-owner", "unknown-runtime"])("%s refuses automatic recovery", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).not.toBe(0);
  expect(result.trace.some(row => row.phase === "recovery")).toBe(false);
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test("current runtime observation distinguishes absent, malformed and a replacement target", () => {
  const home = createTempHome("ocx-update-target-");
  try {
    const path = join(home.root, "runtime-port.json");
    expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "absent" });
    for (const raw of ["{", "null", '{"pid":1,"port":0}', '{"pid":1,"port":42,"hostname":false}']) {
      writeFileSync(path, raw); expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "unknown" });
    }
    writeFileSync(path, JSON.stringify({ pid: 7, port: 4567, hostname: "::1" }));
    expect(readUpdateRuntimeTarget(path, "127.0.0.1")).toEqual({ kind: "target", target: { pid: 7, port: 4567, hostname: "::1" } });
    expect(readFileSync(path, "utf8")).toContain("4567");
  } finally { home.remove(); }
});

test.skipIf(process.platform === "win32")("unmanaged recovery joins the lease and waits for PID-bound health", async () => {
  const result = await run("direct-success");
  expect(result.exit, result.log).toBe(1); // The failed package install is still a failure.
  expect(result.trace.find(row => row.phase === "direct")).toMatchObject({ contenderBlocked: true, delegated: true, canJoin: true });
  expect(result.trace.find(row => row.phase === "health")).toMatchObject({ contenderBlocked: true, pidBound: true, healthy: true });
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);

test.skipIf(process.platform === "win32").each(["direct-spawn-error", "direct-timeout", "direct-foreign"])("%s releases authority without claiming healthy recovery", async scenario => {
  const result = await run(scenario);
  expect(result.exit, result.log).toBe(1);
  expect(result.trace.find(row => row.phase === "direct")).toMatchObject({ contenderBlocked: true, delegated: true, canJoin: true });
  expect(result.trace.some(row => row.phase === "health" && row.healthy)).toBe(false);
  if (scenario === "direct-foreign") expect(result.trace.some(row => row.phase === "health" && row.pidBound)).toBe(true);
  expect(result.trace.at(-1)).toMatchObject({ reacquired: true, parentToken: false });
}, 30_000);
