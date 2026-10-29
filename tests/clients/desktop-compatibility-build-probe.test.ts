import { beforeAll, describe, expect, test } from "bun:test";
import { createInstalledBuildProbe, DESKTOP_COMPATIBILITY_ASSESSED_VERSION, DESKTOP_PACKAGE_PROOF_SCRIPT, DESKTOP_PACKAGE_PATH_GUARD_SCRIPT } from "../../src/codex/desktop-compatibility/installed-build";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { spawnTestChild } from "../helpers/spawn-test-child";
import { COLD_SPAWN_WARMUP_HOOK_BUDGET_MS, warmColdSpawn } from "../helpers/cold-spawn-warmup";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import type { DesktopPackageObservation as DesktopAppInstall } from "../../src/codex/desktop-compatibility/installed-build";
import { desktopPackageObservation } from "../helpers/desktop-package-observation";

const installed = desktopPackageObservation;

/**
 * One run of the ancestry probe: a fixture on the volume root, the real PowerShell guard, and the
 * assertions. The warm-up below replays this exact call, so the warmed path is the measured path.
 *
 * Each step writes a phase marker to stderr as it finishes. PowerShell only flushes the JSON verdict
 * when it exits, so a child killed at the deadline used to leave empty stdout and stderr (#7854);
 * the markers survive the kill and name the last step that completed.
 */
async function probeOwnedAncestry(deadlineMs: number): Promise<void> {
  // Ordinary volume-root fixture: never use a registered package or the installed application.
  const root = mkdtempSync(join(parse(process.cwd()).root, "ocx-package-ancestry-"));
  const first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias");
  let terminal = true;
  const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const phase = (name: string) => `[Console]::Error.WriteLine('phase:${name}')`;
  try {
    for (const directory of [first, second]) {
      mkdirSync(join(directory, "package", "app"), { recursive: true });
      writeFileSync(join(directory, "package", "app", "ChatGPT.exe"), "fixture, not executable");
      writeFileSync(join(directory, "package", "AppxManifest.xml"), "fixture, not Appx");
    }
    symlinkSync(first, alias, "junction");
    const script = [phase("started"), "$ErrorActionPreference='Stop'", DESKTOP_PACKAGE_PATH_GUARD_SCRIPT, phase("guard-defined"),
      `$alias=${quote(alias)}; $first=${quote(first)}; $second=${quote(second)}`,
      "$leaf=Join-Path $alias 'package\\app\\ChatGPT.exe'",
      // Leaf attributes alone cannot reveal the ancestor junction.
      "if((Get-Item -LiteralPath $leaf).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Fixture leaf is not ordinary'}",
      "function Refuses-BeforeRead([string]$File){$refused=$false; try{$null=Assert-DesktopPackagePath $File}catch{$refused=$true}; if(-not $refused){throw 'Guard admitted redirected ancestry'}; return $refused}",
      "$initial=Refuses-BeforeRead $leaf", phase("initial-refused"),
      "[IO.Directory]::Delete($alias); $null=New-Item -ItemType Junction -Path $alias -Target $second",
      "$retarget=Refuses-BeforeRead $leaf", phase("retarget-refused"),
      "$ordinary=Join-Path $first 'package\\app\\ChatGPT.exe'; $before=Assert-DesktopPackagePath $ordinary", phase("ordinary-admitted"),
      "$null=Move-Item -LiteralPath $first -Destination ($first+'-saved'); $null=New-Item -ItemType Junction -Path $first -Target $second",
      // The same revalidation used before publishing production proof must reject this change.
      "$publication=Refuses-BeforeRead $ordinary", phase("publication-refused"),
      "[pscustomobject]@{initial=$initial;retarget=$retarget;publication=$publication;ordinary=($before.Length -gt 0)}|ConvertTo-Json -Compress",
    ].join("; ");
    terminal = false;
    const result = await spawnTestChild([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command", script],
      { cwd: root, deadlineMs });
    terminal = result.reaped && result.pipesClosed;
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, reaped: true, pipesClosed: true });
    expect(JSON.parse(result.stdout)).toEqual({ initial: true, retarget: true, publication: true, ordinary: true });
  } finally {
    // An unreaped child retains its fixture; never recursively follow the owned junctions.
    if (terminal) {
      for (const path of [alias, first]) {
        try { if (lstatSync(path).isSymbolicLink()) unlinkSync(path); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      rmSync(root, { recursive: true });
    }
  }
}

describe.skipIf(process.platform !== "win32")("Windows package ancestry guard", () => {
  // The first PowerShell child in a shard pays the cold .NET and PowerShell load. Measured on a busy
  // Windows host, the script body finished in under 0.7s with 24 copies running at once while the
  // process around it took 2-8s to start and exit, so the 10s bound below was measuring process
  // lifecycle under load rather than the guard (#7854). Paying that once here, through the same
  // probe, leaves the unchanged bound measuring a warm run.
  beforeAll(async () => {
    await warmColdSpawn("powershell/desktop-package-ancestry-guard", deadlineMs => probeOwnedAncestry(deadlineMs));
  }, COLD_SPAWN_WARMUP_HOOK_BUDGET_MS);

  test("owned ancestor junctions and persistent retargets fail before proof publication", async () => {
    await probeOwnedAncestry(10_000);
  }, 20_000);
});

test("manifest and canonical executable facts are required without admitting another version", async () => {
  const good = installed();
  for (const proof of [undefined,
    { ...good.proof!, manifestName: "Foreign.Codex" }, { ...good.proof!, manifestPublisher: "CN=Foreign" },
    { ...good.proof!, appId: "Other" }, { ...good.proof!, executable: "other\\ChatGPT.exe" },
    { ...good.proof!, canonicalExecutable: good.root + "-foreign\\app\\ChatGPT.exe" },
    { ...good.proof!, packageFullName: good.proof!.packageFullName + "_extra" },
    { ...good.proof!, manifestDigest: "unverified" }, { ...good.proof!, ancestryIdentity: "" },
    { ...good.proof!, executableIdentity: "" }]) {
    const probe = createInstalledBuildProbe(async () => ({ ...good, proof }));
    expect(await probe.check()).toBe(false); expect(probe.binding().identity).toBeNull(); await probe.close();
  }
  const newer = createInstalledBuildProbe(async () => installed("26.1007.9446.0"));
  expect(await newer.check()).toBe(false); await newer.close();
  expect(DESKTOP_PACKAGE_PROOF_SCRIPT).toContain("Get-AppxPackageManifest");
  expect(DESKTOP_PACKAGE_PROOF_SCRIPT).toContain("ChatGPT.exe");
  expect(DESKTOP_PACKAGE_PROOF_SCRIPT).not.toContain("Activate");
});

test("same-version package proof changes and failure advance a private ABA fence", async () => {
  let value: DesktopAppInstall | null = installed();
  const probe = createInstalledBuildProbe(async () => value);
  expect(await probe.check()).toBe(true); const first = probe.binding();
  expect(await probe.check()).toBe(true); expect(probe.binding()).toEqual(first);
  value = { ...installed(), proof: { ...installed().proof!, manifestDigest: "b".repeat(64) } };
  expect(await probe.check()).toBe(true); expect(probe.binding().revision).toBeGreaterThan(first.revision);
  value = installed(); expect(await probe.check()).toBe(true);
  expect(probe.binding().identity).toBe(first.identity); expect(probe.binding().revision).toBeGreaterThan(first.revision);
  value = null; expect(await probe.check()).toBe(false); expect(probe.binding().identity).toBeNull();
  const failedRevision = probe.binding().revision;
  value = installed(); expect(await probe.check()).toBe(true); expect(probe.binding().revision).toBeGreaterThan(failedRevision);
  expect(JSON.stringify(probe.lastResult())).not.toContain(first.identity!);
  expect(JSON.stringify(probe.lastResult())).not.toContain("ChatGPT.exe");
  await probe.close(); expect(probe.binding().identity).toBeNull();
});

test("identical observed metadata cannot claim to detect a same-version reinstall", async () => {
  const probe = createInstalledBuildProbe(async () => structuredClone(installed()));
  expect(await probe.check()).toBe(true); const original = probe.binding();
  expect(await probe.check()).toBe(true); expect(probe.binding()).toEqual(original);
  await probe.close();
});

test("a successful query completed after close cannot restore private proof", async () => {
  let release!: (value: DesktopAppInstall) => void;
  const probe = createInstalledBuildProbe(() => new Promise(resolve => { release = resolve; }));
  const checking = probe.check(); await Promise.resolve();
  const closing = probe.close(); const closedBinding = probe.binding();
  release(installed()); expect(await checking).toBe(false); await closing;
  expect(probe.binding()).toEqual(closedBinding); expect(probe.lastResult()).toBeNull();
});

test("matching version text cannot qualify a foreign package family, publisher or app entry", async () => {
  const original = installed();
  for (const candidate of [{ ...original, id: "Foreign.Codex_2p2nqsd0c76g0" },
    { ...original, relaunch: `${original.id}!Other` },
    { ...original, root: original.root.replace("__2p2nqsd0c76g0", "__foreign") },
    { ...original, id: "OpenAI.Codex_foreign", relaunch: "OpenAI.Codex_foreign!App", root: original.root.replace("__2p2nqsd0c76g0", "__foreign") },
    { ...original, root: original.root + "_extra" }]) {
    const probe = createInstalledBuildProbe(async () => candidate);
    expect(await probe.check()).toBe(false); await probe.close();
  }
});

test("concurrent build checks share only the pending query and refresh after it settles", async () => {
  let calls = 0, release!: (value: DesktopAppInstall | null) => void;
  const probe = createInstalledBuildProbe(async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  const first = probe.check(), second = probe.check();
  await Bun.sleep(0); expect(calls).toBe(1);
  release(installed()); expect(await first).toBe(true); expect(await second).toBe(true);
  const changed = probe.check(); await Bun.sleep(0); expect(calls).toBe(2);
  release(installed("99.1.1.0")); expect(await changed).toBe(false);
  await probe.close();
});

test("shutdown aborts the owned query and waits for its cleanup before settling", async () => {
  let aborted = false, reaped!: () => void, closed = false;
  const probe = createInstalledBuildProbe(signal => new Promise(resolve => {
    reaped = () => resolve(null);
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
  }));
  const pending = probe.check(); await Bun.sleep(0);
  const closing = probe.close().then(() => { closed = true; });
  await Bun.sleep(0); expect(aborted).toBe(true); expect(closed).toBe(false);
  reaped(); await closing; expect(await pending).toBe(false); expect(await probe.check()).toBe(false);
});

test("a failed probe is closed and the next fresh query can recover", async () => {
  let calls = 0;
  const probe = createInstalledBuildProbe(async () => { if (++calls === 1) throw new Error("fixture failure"); return installed(); });
  expect(await probe.check()).toBe(false); expect(await probe.check()).toBe(true);
  await probe.close();
});

test("build assessment exposes only the last completed public package metadata", async () => {
  let install: DesktopAppInstall | null = null, calls = 0;
  const probe = createInstalledBuildProbe(async () => (++calls, install));
  expect(probe.lastResult()).toBeNull();
  install = installed("26.1007.9446.0");
  expect(await probe.check()).toBe(false);
  const unverified = probe.lastResult();
  expect(unverified).toMatchObject({ assessedVersion: DESKTOP_COMPATIBILITY_ASSESSED_VERSION, observedVersion: "26.1007.9446.0", verified: false });
  expect(unverified!.completedAt).toBeGreaterThan(0);
  expect(JSON.stringify(unverified)).not.toContain("WindowsApps");
  install = installed();
  expect(await probe.check()).toBe(true);
  expect(probe.lastResult()).toMatchObject({ observedVersion: DESKTOP_COMPATIBILITY_ASSESSED_VERSION, verified: true });
  install = { ...installed(), root: "E:\elsewhere\not-a-package-name" };
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()!.observedVersion).toBeNull();
  install = null;
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()!.observedVersion).toBeNull();
  const settled = probe.lastResult()!;
  expect(calls).toBe(4); await probe.close();
  expect(probe.lastResult()).toEqual(settled);
});

test("an interrupted in-flight check preserves the last completed assessment", async () => {
  let calls = 0, queryAborted = false, secondStarted!: () => void;
  const started = new Promise<void>(resolve => { secondStarted = resolve; });
  const probe = createInstalledBuildProbe(signal => { calls++; return calls === 1 ? Promise.resolve(installed())
    : new Promise<DesktopAppInstall | null>(resolve => { secondStarted(); signal.addEventListener("abort", () => { queryAborted = true; resolve(installed("9.9.9.9")); }, { once: true }); }); });
  expect(await probe.check()).toBe(true);
  const pending = probe.check();
  await started; expect(calls).toBe(2);
  let settled = false; void pending.then(() => { settled = true; });
  await Bun.sleep(0); expect(settled).toBe(false);
  const closing = probe.close(); expect(queryAborted).toBe(true);
  expect(await pending).toBe(false); await closing;
  expect(probe.lastResult()!.verified).toBe(true);
  expect(probe.lastResult()!.observedVersion).toBe(DESKTOP_COMPATIBILITY_ASSESSED_VERSION);
});

test("a completed probe failure reports unverified instead of retaining a stale verdict", async () => {
  let calls = 0;
  const probe = createInstalledBuildProbe(async () => (++calls === 1 ? installed() : Promise.reject(new Error("fixture failure"))));
  expect(await probe.check()).toBe(true);
  expect(await probe.check()).toBe(false);
  expect(probe.lastResult()).toMatchObject({ observedVersion: null, verified: false });
  await probe.close();
});
