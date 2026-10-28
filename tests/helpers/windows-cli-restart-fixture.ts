import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hardenSecretDirAsync } from "../../src/lib/windows-secret-acl";
import { trackBackgroundWork } from "../../src/lib/background-work";
import { createCodexCliTestRoot } from "./codex-cli-fixture-root";
import { helperPath } from "./repo-root";
import type { WindowsRecoveryProbe } from "./windows-cli-recovery-state";

// The hosted case exceeded its 30s poll; a delayed native guardian proved safe
// recovery at 44.23s after stop. Allow twice that measured window, rounded up,
// for cold PowerShell/Add-Type startup, receipt flush and fresh ACL probes.
export const WINDOWS_RECOVERY_PROOF_MS = 90_000;
export const WINDOWS_RESTART_FIXTURE_MS = 300_000;

function recoveryProved(probe: WindowsRecoveryProbe): boolean {
  if (!probe.entered) return false;
  const guardian = "guardian" in probe.recovery ? probe.recovery.guardian : undefined;
  return guardian ? ["absent", "reused", "exited"].includes(guardian.state) : probe.guardianStarted === false;
}

/** Each probe gets only the time left in the proof window; proof that lands after it is not accepted. */
export async function waitForWindowsRecovery(probe: (timeoutMs: number) => WindowsRecoveryProbe,
  now: () => number = () => performance.now()) {
  const deadline = now() + WINDOWS_RECOVERY_PROOF_MS;
  let last: WindowsRecoveryProbe | string = "no_probe_completed";
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("native_recovery_proof_timeout: " + (typeof last === "string" ? last : JSON.stringify(last)));
    try {
      last = probe(Math.ceil(remaining));
      if (recoveryProved(last) && now() <= deadline) return last;
    } catch (error) { last = String(error); }
    await Bun.sleep(Math.min(50, Math.max(0, deadline - now())));
  }
}

export async function drainWindowsRestartRecovery(owner: Pick<Bun.Subprocess, "exited" | "kill">,
  probe: (timeoutMs: number) => WindowsRecoveryProbe, settled: () => void, ownerExitMs = WINDOWS_RECOVERY_PROOF_MS,
  now?: () => number) {
  let timer: ReturnType<typeof setTimeout> | undefined, ownerExitError: unknown;
  try {
    await Promise.race([owner.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("fixture_owner_exit_timeout")), ownerExitMs);
    })]);
  } catch (error) {
    ownerExitError = error;
    try { owner.kill(); }
    catch (stopError) { ownerExitError = new AggregateError([error, stopError], "fixture_owner_stop_failed"); }
  } finally { clearTimeout(timer); }
  await waitForWindowsRecovery(probe, now);
  settled(); // Actual Job/receipt proof even when the test body throws.
  if (ownerExitError) throw ownerExitError;
}

/** Failure cleanup must prove recovery too; a failed drain stays tracked. */
export async function withWindowsRestartRecoveryFixture<T>(descendant: boolean,
  body: (fixture: { root: string; config: string; alias: string; owner: Bun.Subprocess<"ignore", "pipe", "pipe">;
    probe: (home?: string, timeoutMs?: number) => WindowsRecoveryProbe }) => Promise<T>): Promise<T> {
  const root = createCodexCliTestRoot("ocx-windows-restart-");
  await hardenSecretDirAsync(root, { required: true });
  const config = join(root, "config"), alias = join(root, "home-alias");
  const helper = helperPath("windows-cli-restart-recovery.ts"), env = { ...process.env, OPENCODEX_HOME: config };
  const owner = Bun.spawn([process.execPath, helper, descendant ? "owner-descendant" : "owner", root], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let settled!: () => void;
  trackBackgroundWork("native restart recovery fixture", new Promise<void>(resolve => { settled = resolve; }));
  const probe = (home = config, timeoutMs = 30_000): WindowsRecoveryProbe => {
    const result = Bun.spawnSync([process.execPath, helper, "probe", root], {
      env: { ...env, OPENCODEX_HOME: home }, timeout: Math.min(30_000, timeoutMs),
    });
    if (result.exitCode !== 0) throw new Error("fixture_probe_failed: " + result.stderr.toString());
    return { ...JSON.parse(result.stdout.toString()),
      guardianStarted: owner.exitCode !== null ? existsSync(join(root, "native-starting")) : undefined };
  };
  try { return await body({ root, config, alias, owner, probe }); }
  finally {
    writeFileSync(join(root, "stop"), "stop");
    await drainWindowsRestartRecovery(owner, timeoutMs => probe(config, timeoutMs), settled);
  }
}
