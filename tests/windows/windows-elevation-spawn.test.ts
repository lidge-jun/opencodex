import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OCX_ELEVATED_CREATE_FAILED,
  OCX_ELEVATED_PROTOCOL_CODES,
  OCX_ELEVATED_PROTOCOL_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
  OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
  OCX_ELEVATED_STAGING_UNREADABLE,
  OCX_ELEVATED_SUCCESS,
  OCX_ELEVATED_UAC_CANCELLED,
  WindowsElevationError,
  buildElevatedSchtasksCreateAndRunScript,
  classifyElevatedSchedulerExitCode,
  raceWithTimeout,
  runElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  runWindowsElevatedScheduledTaskRegistration,
  setWindowsElevationSpawnForTests,
  setTrustedWindowsElevationExecutablesForTests,
  startElevatedSchtasksCreateAndRun,
  startPowerShellCommand,
} from "../../src/lib/windows-elevation";
import {
  evaluateSchedulerInstallRestartReconciliation,
  finalizeWindowsSchedulerServiceRegistration,
  schedulerVerificationMaySettle,
  setFinalizeWindowsSchedulerHooksForTests,
  stageElevatedSchedulerRegistration,
  describeElevatedRegistrationFailure,
} from "../../src/service";
import type { WindowsSchedulerInstallVerification } from "../../src/service";
import {
  hardenSecretDir,
  hardenSecretPath,
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #4692: a file an administrator process will read is itself a privilege-escalation
 * surface, so access, redirection and tamper-evidence each have to hold.
 */
describe("elevated Task Scheduler payload staging", () => {
  test("hardens before writing, digests the exact bytes, and cleans up", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-elevated-stage-"));
    const stageDir = join(parent, "private-stage");
    const calls: string[] = [];
    try {
      const staged = stageElevatedSchedulerRegistration(
        "<Task><Description>new</Description></Task>",
        "<Task><Description>previous</Description></Task>",
        {
          createStageDir: () => {
            mkdirSync(stageDir, { mode: 0o700 });
            calls.push("create-stage-dir");
            return stageDir;
          },
          hardenDir: () => { calls.push("harden-dir"); },
          writePayload: (path, bytes) => {
            calls.push("write:" + path.slice(stageDir.length + 1));
            writeFileSync(path, bytes, { flag: "wx" });
          },
          hardenPath: path => { calls.push("harden:" + path.slice(stageDir.length + 1)); },
        },
      );

      // The directory is private before anything is written into it; hardening after the
      // write would leave a window where the payload is readable by another account.
      expect(calls).toEqual([
        "create-stage-dir",
        "harden-dir",
        "write:register.xml",
        "harden:register.xml",
        "write:expected.xml",
        "harden:expected.xml",
      ]);

      // The digest covers exactly the bytes on disk, and those bytes are UTF-16LE with no
      // BOM: the elevated process decodes them straight into Register-ScheduledTask, so
      // what is hashed here is what gets registered, with no trimming step in between.
      for (const [payload, value] of [
        [staged.xml, "<Task><Description>new</Description></Task>"],
        [staged.expectedExisting!, "<Task><Description>previous</Description></Task>"],
      ] as const) {
        const onDisk = readFileSync(payload.path);
        expect(onDisk.equals(Buffer.from(value, "utf16le"))).toBe(true);
        expect(onDisk[0]).not.toBe(0xff);
        expect(payload.sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
        expect(payload.byteLength).toBe(onDisk.length);
        expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(staged.xml.sha256).not.toBe(staged.expectedExisting!.sha256);

      staged.cleanup();
      expect(existsSync(stageDir)).toBe(false);
      // Idempotent: the success path calls it once, but a failure path may race it.
      expect(() => staged.cleanup()).not.toThrow();
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("refuses a redirected path and leaves nothing behind", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-elevated-stage-reparse-"));
    const stageDir = join(parent, "private-stage");
    try {
      // A staged payload reached through a reparse point is a payload somebody else chose
      // the destination for. Exclusive creation already refuses an existing name, so this
      // is the check that keeps the guarantee from resting on a reading of O_EXCL.
      expect(() => stageElevatedSchedulerRegistration("<Task />", undefined, {
        createStageDir: () => {
          mkdirSync(stageDir, { mode: 0o700 });
          return stageDir;
        },
        hardenDir: () => {},
        writePayload: (path, bytes) => { writeFileSync(path, bytes, { flag: "wx" }); },
        hardenPath: () => { throw new Error("must not harden a redirected payload"); },
        inspect: path => ({
          isSymbolicLink: () => path !== stageDir,
          isFile: () => true,
          isDirectory: () => path === stageDir,
        }),
      })).toThrow("redirected path");
      expect(existsSync(stageDir)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("cleans up when a payload write fails partway", () => {
    const parent = mkdtempSync(join(tmpdir(), "ocx-elevated-stage-partial-"));
    const stageDir = join(parent, "private-stage");
    try {
      // The predecessor is the second payload, so this leaves a real file behind unless
      // cleanup walks everything it created rather than only the one that failed.
      expect(() => stageElevatedSchedulerRegistration("<Task />", "<Task />", {
        createStageDir: () => {
          mkdirSync(stageDir, { mode: 0o700 });
          return stageDir;
        },
        hardenDir: () => {},
        writePayload: (path, bytes) => {
          if (path.endsWith("expected.xml")) throw new Error("synthetic predecessor write failure");
          writeFileSync(path, bytes, { flag: "wx" });
        },
        hardenPath: () => {},
      })).toThrow("synthetic predecessor write failure");
      expect(existsSync(stageDir)).toBe(false);
    } finally {
      removeTreeWithRetry(parent);
    }
  });

  test("the default staging ACL grants read to SYSTEM and administrators; secrets stay owner-only", () => {
    // #4779: an over-the-shoulder UAC prompt answered with a DIFFERENT administrator's
    // credentials produces an elevated token that is not the staging account, so an
    // owner-only staged payload could not be opened by the elevated process at all.
    // The payloads are task definitions, not credentials, and their bytes ride a
    // SHA-256 pinned before UAC — so the staging ACL grants Administrators and SYSTEM
    // read while every secret call site keeps the owner-only shape.
    const parent = mkdtempSync(join(tmpdir(), "ocx-elevated-stage-acl-"));
    const stageDir = join(parent, "private-stage");
    const secretDir = join(parent, "secret-dir");
    const secretFile = join(parent, "secret.txt");
    mkdirSync(secretDir, { mode: 0o700 });
    writeFileSync(secretFile, "x");
    const icaclsCalls: string[][] = [];
    resetHardenedStateForTests();
    setPlatformForTests("win32");
    setIcaclsRunnerForTests(args => {
      icaclsCalls.push(args);
      return { success: true, exitCode: 0, timedOut: false, stdout: "" };
    });
    try {
      const staged = stageElevatedSchedulerRegistration("<Task />", "<Task />", {
        createStageDir: () => {
          mkdirSync(stageDir, { mode: 0o700 });
          return stageDir;
        },
      });
      try {
        const grantsFor = (target: string) => icaclsCalls
          .filter(args => args[0] === target && args.includes("/grant:r"))
          .map(args => args.slice(args.indexOf("/grant:r") + 1));

        // The staging directory grants owner full control plus read/traverse for
        // SYSTEM and BUILTIN\Administrators, so an elevated process running as a
        // different administrator can still open the payloads it contains.
        const dirAces = grantsFor(stageDir);
        expect(dirAces).toHaveLength(1);
        expect(dirAces[0]).toHaveLength(3);
        expect(dirAces[0]![0]).toMatch(/^\*S-1-5-\d+(-\d+)*:\(OI\)\(CI\)\(F\)$/);
        expect(dirAces[0]).toContain("*S-1-5-18:(OI)(CI)(RX)");
        expect(dirAces[0]).toContain("*S-1-5-32-544:(OI)(CI)(RX)");

        // Each payload grants read — never write — to the same elevated principals.
        for (const payload of [staged.xml, staged.expectedExisting!]) {
          const fileAces = grantsFor(payload.path);
          expect(fileAces).toHaveLength(1);
          expect(fileAces[0]).toHaveLength(3);
          expect(fileAces[0]![0]).toMatch(/^\*S-1-5-\d+(-\d+)*:\(F\)$/);
          expect(fileAces[0]).toContain("*S-1-5-18:(R)");
          expect(fileAces[0]).toContain("*S-1-5-32-544:(R)");
        }
      } finally {
        staged.cleanup();
      }

      // The widened shape must not leak into the secret API: a real-secret call site
      // keeps exactly the owner grant and nothing else.
      icaclsCalls.length = 0;
      hardenSecretPath(secretFile, { required: true });
      hardenSecretDir(secretDir, { required: true });
      const fileAces = icaclsCalls
        .filter(args => args[0] === secretFile && args.includes("/grant:r"))
        .map(args => args.slice(args.indexOf("/grant:r") + 1));
      const dirAces = icaclsCalls
        .filter(args => args[0] === secretDir && args.includes("/grant:r"))
        .map(args => args.slice(args.indexOf("/grant:r") + 1));
      expect(fileAces).toHaveLength(1);
      expect(fileAces[0]![0]).toMatch(/^\*S-1-5-\d+(-\d+)*:\(F\)$/);
      expect(dirAces).toHaveLength(1);
      expect(dirAces[0]).toHaveLength(1);
      expect(dirAces[0]![0]).toMatch(/^\*S-1-5-\d+(-\d+)*:\(OI\)\(CI\)\(F\)$/);
    } finally {
      setPlatformForTests(null);
      setIcaclsRunnerForTests(null);
      resetHardenedStateForTests();
      removeTreeWithRetry(parent);
    }
  });

  test("an unreadable staged payload is reported with its cause and its remedy", () => {
    // The elevated process runs hidden, so nothing it writes survives and the exit code is
    // the entire user-facing error. Reporting that as a bare number would reproduce what
    // made #4692 expensive to diagnose in the first place.
    const message = describeElevatedRegistrationFailure(
      "Background service install failed",
      OCX_ELEVATED_STAGING_UNREADABLE,
      "C:\\Temp\\opencodex-service-stage-aaaaaa",
    );
    expect(message).toContain("could not read the staged task definition");
    expect(message).toContain("C:\\Temp\\opencodex-service-stage-aaaaaa");
    expect(message).toContain("administrators");
    expect(message).toContain("elevated as an administrator");
    expect(message).not.toMatch(/exit code \d+/);

    // Every other code keeps the plain form; this is a named cause, not a catch-all.
    for (const code of [1, 10, 13, 1223]) {
      expect(describeElevatedRegistrationFailure("Task Scheduler rollback failed", code, "C:\\Temp\\x"))
        .toBe("Task Scheduler rollback failed with exit code " + code + ".");
    }
  });
});

/** Linux CI fakes win32 without a real System32; keep elevation paths production-shaped. */
const FAKE_TRUSTED_ELEVATION_EXES = {
  powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  schtasks: "C:\\Windows\\System32\\schtasks.exe",
} as const;

describe("runWindowsElevated spawn contract", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    setTrustedWindowsElevationExecutablesForTests(FAKE_TRUSTED_ELEVATION_EXES);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setTrustedWindowsElevationExecutablesForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  function fakeChild(opts: {
    code?: number | null;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    stdout?: string;
    emitError?: NodeJS.ErrnoException;
    hang?: boolean;
  }) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding?: (enc: string) => void };
      stderr: EventEmitter & { setEncoding?: (enc: string) => void };
      kill: ReturnType<typeof mock>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stderr.setEncoding = () => undefined;
    child.kill = mock(() => true);
    setWindowsElevationSpawnForTests((() => {
      queueMicrotask(() => {
        if (opts.emitError) {
          child.emit("error", opts.emitError);
          return;
        }
        if (opts.hang) return;
        if (opts.stdout) child.stdout.emit("data", opts.stdout);
        if (opts.stderr) child.stderr.emit("data", opts.stderr);
        child.emit("close", "code" in opts ? opts.code! : 0, opts.signal ?? null);
      });
      return child as never;
    }) as never);
    return child;
  }

  test("an armed test cannot launch the live Windows elevation boundary", async () => {
    // The probe is deliberately inert: if the guard regresses, it can only start an
    // non-RunAs PowerShell executing a fixed exit 0, never UAC or Task Scheduler mutation.
    const execution = startPowerShellCommand("exit 0");
    expect(execution.launcherPid).toBeNull();
    await expect(execution.completion).rejects.toThrow(
      "Refusing to launch a live Windows elevation process from an armed test process",
    );
  });

  test("returns exit code 0", async () => {
    fakeChild({ code: 0 });
    await expect(runWindowsElevated("schtasks.exe", ["/query"])).resolves.toBe(0);
  });

  test("PowerShell script treats a missing ExitCode as protocol failure", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    await runWindowsElevated("schtasks.exe", ["/create"]);
    expect(commandScript).toContain(`if ($null -eq $p.ExitCode) { exit ${OCX_ELEVATED_PROTOCOL_FAILED} }`);
    expect(commandScript).toContain("$null = $p.Handle;");
    expect(commandScript).not.toContain("$p.Handleif");
    expect(commandScript).toMatch(/\$null = \$p\.Handle;\s*if \(\$null -eq \$p\.ExitCode\)/);
  });

  test("returns non-zero exit codes from completed elevated processes", async () => {
    fakeChild({ code: 1, stderr: "failed" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("keeps scheduled-task elevation arguments in one Start-Process statement", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    await expect(runWindowsElevatedScheduledTaskRegistration(
      "opencodex-proxy",
      { path: "C:\\Temp\\opencodex-service-stage-aaaaaa\\register.xml", byteLength: 42, sha256: "0".repeat(64) },
    )).resolves.toBe(0);

    const startProcessIndex = commandScript.indexOf("Start-Process");
    const filePathIndex = commandScript.indexOf(" -FilePath ");
    const argumentListIndex = commandScript.indexOf(" -ArgumentList ");
    const verbIndex = commandScript.indexOf(" -Verb RunAs ");
    const waitIndex = commandScript.indexOf(" -Wait");
    const firstTerminator = commandScript.indexOf(";", startProcessIndex);

    expect(startProcessIndex).toBeGreaterThanOrEqual(0);
    expect(filePathIndex).toBeGreaterThan(startProcessIndex);
    expect(argumentListIndex).toBeGreaterThan(filePathIndex);
    expect(verbIndex).toBeGreaterThan(argumentListIndex);
    expect(waitIndex).toBeGreaterThan(verbIndex);
    expect(firstTerminator).toBeGreaterThan(waitIndex);
    expect(commandScript.match(/Start-Process/g)).toHaveLength(1);
    expect(commandScript).not.toMatch(/powershell\.exe';\s+-ArgumentList/i);
    expect(commandScript).not.toMatch(/-ArgumentList\s+'[^']*';\s+-Verb RunAs/);
  });

  test("scheduled-task registration locks staged paths before elevation and bounds reads", async () => {
    let commandScript = "";
    setWindowsElevationSpawnForTests(((
      _cmd: string,
      args: ReadonlyArray<string>,
    ) => {
      commandScript = String(args[args.length - 1] ?? "");
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);

    const xml = "<Task><Description>fixed-definition</Description></Task>";
    const stageDir = "C:\\Temp\\opencodex-service-stage-aaaaaa";
    const staged = { path: stageDir + "\\register.xml", byteLength: 108, sha256: "a".repeat(64) };
    await expect(runWindowsElevatedScheduledTaskRegistration("opencodex-proxy", staged)).resolves.toBe(0);
    const match = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(commandScript);
    expect(match).not.toBeNull();
    const elevatedScript = Buffer.from(match![1]!, "base64").toString("utf16le");
    expect(elevatedScript).toContain(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1",
    );
    expect(elevatedScript).toContain("Microsoft.PowerShell.Core\\Import-Module");
    expect(elevatedScript).toContain("$module.ExportedCommands['Register-ScheduledTask']");
    expect(elevatedScript).toContain(
      "Trusted ScheduledTasks module does not export Register-ScheduledTask.",
    );
    expect(elevatedScript).toContain("& $registerTask -TaskName $taskName -Xml $xml -ErrorAction Stop");
    expect(elevatedScript).not.toContain("-Xml $xml -Force");
    expect(elevatedScript.match(/\bRegister-ScheduledTask\b/g)).toHaveLength(2);

    // #4692: the definition now travels as a path plus a digest. A pathname on its own
    // would be a promise about content, so the elevated side has to check it: read the
    // bytes once, hash exactly those bytes, and refuse BEFORE decoding them. Hashing and
    // then rereading would leave the swap window this check exists to close.
    expect(elevatedScript).toContain(staged.path);
    expect(elevatedScript).toContain(staged.sha256);
    // Pin the CALLS, not the declaration: moving every Lock-OcxStage call after
    // Start-Process would still satisfy a name-substring check while nothing is
    // held during UAC.
    const startProcessAt = commandScript.indexOf("Start-Process");
    for (const lockCall of [
      "ForEach-Object { Lock-OcxStage $_ $true }",
      `Lock-OcxStage '${staged.path}' $false`,
    ]) {
      const at = commandScript.indexOf(lockCall);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(startProcessAt);
    }
    expect(commandScript).toContain("GetFileInformationByHandleEx");
    expect(commandScript).toContain("0x00200000");
    expect(commandScript).toContain("0x400");
    expect(elevatedScript).toContain("$stream.Length -ne $expectedLength");
    expect(elevatedScript).toContain("[byte[]]::new($expectedLength)");
    expect(elevatedScript).toContain("$sha.ComputeHash($bytes)");
    expect(elevatedScript).toContain("Task Scheduler staged payload failed its integrity check.");
    // #4692 follow-up: the one failure this staging design introduces has to be readable.
    // A hidden elevated process has nowhere to print, so an unreadable payload rides its
    // own exit code instead of collapsing into a generic non-zero status.
    expect(elevatedScript).toContain("catch [System.UnauthorizedAccessException] { exit " + OCX_ELEVATED_STAGING_UNREADABLE + " }");
    expect(elevatedScript).toContain("catch [System.Security.SecurityException] { exit " + OCX_ELEVATED_STAGING_UNREADABLE + " }");
    // It is not part of the create-and-run transaction's alphabet, and cannot be mistaken
    // for UAC denial.
    expect(OCX_ELEVATED_PROTOCOL_CODES).not.toContain(OCX_ELEVATED_STAGING_UNREADABLE);
    expect(OCX_ELEVATED_STAGING_UNREADABLE).not.toBe(OCX_ELEVATED_UAC_CANCELLED);
    expect(elevatedScript.indexOf("-cne $expectedHash"))
      .toBeLessThan(elevatedScript.indexOf("[Text.Encoding]::Unicode.GetString($bytes)"));
    // No payload rides the command line any more, in either encoding layer.
    expect(elevatedScript).not.toContain(Buffer.from(xml, "utf16le").toString("base64"));
    expect(elevatedScript).not.toContain("FromBase64String");
    expect(commandScript).not.toContain("/xml");

    // The regression itself. The old form embedded base64(utf16le) of the XML inside a
    // script that was base64(utf16le)-encoded again — about 14.2 command-line characters
    // per XML character, twice over for a replacement — so a ~2 KB definition pushed the
    // spawn past the Windows command-line limit and failed with ENAMETOOLONG. What is
    // pinned here is independence, not one lucky measurement: the same staging shape must
    // produce the same command length no matter how large the definition behind it is.
    const smallLength = commandScript.length;
    const largeStaged = { path: stageDir + "\\register.xml", byteLength: 20_000, sha256: "b".repeat(64) };
    await expect(runWindowsElevatedScheduledTaskRegistration("opencodex-proxy", largeStaged)).resolves.toBe(0);
    expect(commandScript.length).toBeLessThanOrEqual(smallLength + 8);
    expect(commandScript.length).toBeLessThan(8192);

    const predecessor = "<Task><Description>captured-predecessor</Description></Task>";
    const stagedPredecessor = { path: stageDir + "\\expected.xml", byteLength: 126, sha256: "c".repeat(64) };
    await expect(
      runWindowsElevatedScheduledTaskRegistration("opencodex-proxy", staged, true, stagedPredecessor),
    ).resolves.toBe(0);
    const replaceMatch = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(commandScript);
    expect(replaceMatch).not.toBeNull();
    const replaceScript = Buffer.from(replaceMatch![1]!, "base64").toString("utf16le");
    // The predecessor payload is pinned before elevation too, alongside the ancestors
    // and the replacement payload.
    for (const lockCall of [
      "ForEach-Object { Lock-OcxStage $_ $true }",
      `Lock-OcxStage '${staged.path}' $false`,
      `Lock-OcxStage '${stagedPredecessor.path}' $false`,
    ]) {
      const at = commandScript.indexOf(lockCall);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(commandScript.indexOf("Start-Process"));
    }
    expect(replaceScript).toContain("& $registerTask -TaskName $taskName -Xml $xml -Force");
    expect(replaceScript).toContain(stagedPredecessor.path);
    expect(replaceScript).toContain(stagedPredecessor.sha256);
    expect(replaceScript).not.toContain(Buffer.from(predecessor, "utf16le").toString("base64"));
    // The predecessor is verified the same way before it is used as a precondition: two
    // call sites, both digest-checked. The helper is declared as
    // "Read-OcxStagedTaskXml([string]$path", so the trailing space matches calls only.
    expect(replaceScript.match(/Read-OcxStagedTaskXml /g)).toHaveLength(2);
    expect(elevatedScript.match(/Read-OcxStagedTaskXml /g)).toHaveLength(1);
    expect(replaceScript).toContain("$currentXml = & $schtasks /query /tn $taskName /xml");
    expect(replaceScript).toContain("Task Scheduler replacement precondition changed.");
    // A replacement used to carry TWO payloads, which is what made this the reported
    // failure. It stays bounded now.
    expect(commandScript.length).toBeLessThan(8192);
  });

  test("an elevated replacement still refuses without a captured predecessor", () => {
    // The post-UAC compare-before-Force is the only thing standing between a repair and
    // overwriting a registration somebody else changed while the prompt was open.
    expect(() => runWindowsElevatedScheduledTaskRegistration(
      "opencodex-proxy",
      { path: "C:\\Temp\\opencodex-service-stage-aaaaaa\\register.xml", byteLength: 42, sha256: "a".repeat(64) },
      true,
    )).toThrow("requires a captured existing definition");
  });

  test("refuses a staged payload whose path escapes the pinned directory", () => {
    const stageDir = "C:\\Temp\\opencodex-service-stage-aaaaaa";
    const staged = { path: `${stageDir}\\register.xml`, byteLength: 42, sha256: "a".repeat(64) };
    const digest = "c".repeat(64);
    // `..` slips past a startsWith prefix check but resolves outside the pinned
    // directory — on either payload, and with either separator. A nested child
    // directory passes the same prefix check while sitting outside the locked
    // folder, so the parent directory has to match, not just the prefix.
    for (const escaped of [
      `${stageDir}\\..\\elsewhere\\expected.xml`,
      `${stageDir}/../elsewhere/expected.xml`,
      `${stageDir}\\sub\\expected.xml`,
    ]) {
      expect(() => runWindowsElevatedScheduledTaskRegistration(
        "opencodex-proxy",
        staged,
        true,
        { path: escaped, byteLength: 42, sha256: digest },
      )).toThrow("must share one staging directory");
    }
    expect(() => runWindowsElevatedScheduledTaskRegistration(
      "opencodex-proxy",
      { path: `${stageDir}\\sub\\..\\..\\register.xml`, byteLength: 42, sha256: "a".repeat(64) },
    )).toThrow("must share one staging directory");
  });

  test("maps exit 1223 to cancelled", async () => {
    fakeChild({ code: OCX_ELEVATED_UAC_CANCELLED });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      name: "WindowsElevationError",
      reason: "cancelled",
    });
  });

  test("maps PowerShell cancellation text to cancelled", async () => {
    fakeChild({ code: 1, stderr: "Start-Process : The operation was canceled by the user." });
    try {
      await runWindowsElevated("schtasks.exe", ["/create"]);
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsElevationError);
      expect((error as WindowsElevationError).reason).toBe("cancelled");
      expect((error as Error).message).toContain("UAC prompt was cancelled");
    }
  });

  test("does not treat UAC-cancel text as cancelled when exit code is 0", async () => {
    fakeChild({ code: 0, stderr: "Start-Process : The operation was canceled by the user." });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(0);
  });

  test("maps ENOENT launch failure", async () => {
    fakeChild({ emitError: Object.assign(new Error("spawn powershell ENOENT"), { code: "ENOENT" }) });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });

  test("maps signal termination", async () => {
    fakeChild({ code: null, signal: "SIGTERM" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "terminated",
    });
  });

  test("request timeout does not kill the launcher; late close still settles once", async () => {
    const child = fakeChild({ hang: true });
    const started = startPowerShellCommand("Start-Process -Verb RunAs");
    const raced = await raceWithTimeout(started.completion, 30);
    expect(raced.status).toBe("timed-out");
    expect(child.kill).not.toHaveBeenCalled();

    let late: { exitCode: number } | null = null;
    const lateWait = started.completion.then(value => { late = value; });
    child.emit("close", OCX_ELEVATED_SUCCESS, null);
    await lateWait;
    expect(late).toEqual({ exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" });
    child.emit("close", 1, null); // second close must not double-settle
    await Promise.resolve();
    expect(late?.exitCode).toBe(OCX_ELEVATED_SUCCESS);
  });

  test("launcher error before elevation settles as launch-failed without hang", async () => {
    fakeChild({ emitError: Object.assign(new Error("spawn failed"), { code: "EACCES" }) });
    const started = startPowerShellCommand("Start-Process -Verb RunAs");
    await expect(started.completion).rejects.toMatchObject({ reason: "launch-failed" });
  });

  test("bounds captured stdout and stderr", async () => {
    const huge = "x".repeat(300_000);
    fakeChild({ code: 1, stdout: huge, stderr: huge });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).resolves.toBe(1);
  });

  test("startElevatedSchtasksCreateAndRun exposes completion after request race timeout", async () => {
    const child = fakeChild({ hang: true });
    const started = startElevatedSchtasksCreateAndRun(
      "schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    const raced = await raceWithTimeout(started.completion, 20);
    expect(raced.status).toBe("timed-out");
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", OCX_ELEVATED_CREATE_FAILED, null);
    await expect(started.completion).resolves.toMatchObject({
      outcome: "create-failed",
      exitCode: OCX_ELEVATED_CREATE_FAILED,
    });
  });

  test("rejects on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await expect(runWindowsElevated("schtasks.exe", ["/create"])).rejects.toMatchObject({
      reason: "launch-failed",
    });
  });
});

describe("elevated scheduler protocol codes", () => {
  test("reserved codes are unique and exclude UAC cancellation", () => {
    const set = new Set<number>(OCX_ELEVATED_PROTOCOL_CODES);
    expect(set.size).toBe(OCX_ELEVATED_PROTOCOL_CODES.length);
    expect(set.has(OCX_ELEVATED_UAC_CANCELLED)).toBe(false);
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_SUCCESS)).toBe("success");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_CREATE_FAILED)).toBe("create-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLED_BACK)).toBe("run-failed-rolled-back");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED)).toBe("run-failed-rollback-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_PROTOCOL_FAILED)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(-1)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(99999)).toBe("protocol-failed");
    expect(classifyElevatedSchedulerExitCode(OCX_ELEVATED_UAC_CANCELLED)).toBe("protocol-failed");
  });
});

describe("one-UAC create/run/rollback elevated script", () => {
  test("embeds create, run, and delete rollback without a second RunAs or temp file writes", () => {
    const script = buildElevatedSchtasksCreateAndRunScript(
      "C:\\Windows\\System32\\schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/xml", "C:\\Users\\Jane Doe\\task.xml", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(script).toContain("Invoke-OcxSchtasks");
    expect(script).toContain(`exit ${OCX_ELEVATED_CREATE_FAILED}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_SUCCESS}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLED_BACK}`);
    expect(script).toContain(`exit ${OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED}`);
    expect(script).toContain('"C:\\Users\\Jane Doe\\task.xml"');
    expect(script).not.toContain("-Verb RunAs");
    expect(script).not.toMatch(/Set-Content|Out-File|Add-Content|New-Item/i);
    expect(script).not.toMatch(/TEMP|tmpdir|ocx-elev/i);
  });
});

describe("finalizeWindowsSchedulerServiceRegistration", () => {
  const originalPlatform = process.platform;
  let elevateLaunches = 0;
  let writeCount = 0;
  let parentRollbackLaunches = 0;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" });
    setTrustedWindowsElevationExecutablesForTests(FAKE_TRUSTED_ELEVATION_EXES);
    elevateLaunches = 0;
    writeCount = 0;
    parentRollbackLaunches = 0;
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    setTrustedWindowsElevationExecutablesForTests(null);
    setFinalizeWindowsSchedulerHooksForTests(null);
    setWindowsElevationSpawnForTests(null);
  });

  function okVerify() {
    return {
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: true,
      detail: "ok",
    };
  }

  function mockParentRollbackSpawn() {
    setWindowsElevationSpawnForTests((() => {
      parentRollbackLaunches += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    }) as never);
  }

  test("successful create+run uses exactly one elevated launcher and writes install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
    });

    const result = await finalizeWindowsSchedulerServiceRegistration("C:\\Users\\x\\.opencodex\\opencodex-service.cmd");
    expect(result).toEqual({ kind: "done" });
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(1);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("create failure does not write install state or parent-rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "create-failed", exitCode: OCX_ELEVATED_CREATE_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/\/create failed/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("run failure with in-process rollback does not write install state or launch a second UAC", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rolled-back",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/rolled the task back/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("run failure with in-process rollback failure reports partial install", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return {
          outcome: "run-failed-rollback-failed",
          exitCode: OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
          stdout: "",
          stderr: "",
        };
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/partial Task Scheduler/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("UAC cancellation during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError(
          "cancelled",
          "Windows administrator approval was required, but the UAC prompt was cancelled or denied.",
        );
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "cancelled" });
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("request timeout returns indeterminate, keeps observing, and reconciles late success", async () => {
    let resolveCompletion!: (value: {
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => {
        elevateLaunches += 1;
        return { completion, launcherPid: 4242 };
      },
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 25,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration(
      "C:\\Users\\x\\.opencodex\\opencodex-service.cmd",
    );
    expect(result.kind).toBe("indeterminate");
    expect(writeCount).toBe(0);

    resolveCompletion({
      outcome: "success",
      exitCode: OCX_ELEVATED_SUCCESS,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(1);
    expect(elevateLaunches).toBe(1);
  });

  test("late create-failed after timeout does not write install state and releases", async () => {
    let resolveCompletion!: (value: {
      outcome: "create-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "create-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => {
        elevateLaunches += 1;
        return { completion, launcherPid: 1 };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result.kind).toBe("indeterminate");
    resolveCompletion({
      outcome: "create-failed",
      exitCode: OCX_ELEVATED_CREATE_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("late run-failed-rolled-back after timeout releases without writing state", async () => {
    let resolveCompletion!: (value: {
      outcome: "run-failed-rolled-back";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "run-failed-rolled-back";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    resolveCompletion({
      outcome: "run-failed-rolled-back",
      exitCode: OCX_ELEVATED_RUN_FAILED_ROLLED_BACK,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("late run-failed-rollback-failed after timeout blocks further installs", async () => {
    let resolveCompletion!: (value: {
      outcome: "run-failed-rollback-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "run-failed-rollback-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    resolveCompletion({
      outcome: "run-failed-rollback-failed",
      exitCode: OCX_ELEVATED_RUN_FAILED_ROLLBACK_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("blocked-partial");
    expect(writeCount).toBe(0);
  });

  test("late protocol-failed with unknown task probe stays blocked-partial and never writes state", async () => {
    let resolveCompletion!: (value: {
      outcome: "protocol-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "protocol-failed";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      writeInstallState: () => { writeCount += 1; },
      probeTask: () => ({ status: "unknown", detail: "Access is denied…" }),
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result.kind).toBe("indeterminate");
    resolveCompletion({
      outcome: "protocol-failed",
      exitCode: OCX_ELEVATED_PROTOCOL_FAILED,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("blocked-partial");
    expect(writeCount).toBe(0);
  });

  test("stale attempt ownership prevents late write", async () => {
    let resolveCompletion!: (value: {
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }) => void;
    const completion = new Promise<{
      outcome: "success";
      exitCode: number;
      stdout: string;
      stderr: string;
    }>(resolve => { resolveCompletion = resolve; });
    const owned = new Set<string>(["attempt-a"]);

    setFinalizeWindowsSchedulerHooksForTests({
      startElevateCreateAndRun: () => ({ completion, launcherPid: 1 }),
      verify: okVerify,
      writeInstallState: () => { writeCount += 1; },
      stillOwnsAttempt: id => owned.has(id),
      requestTimeoutMs: 20,
    });

    const result = await finalizeWindowsSchedulerServiceRegistration(
      undefined,
      { attemptId: "attempt-a" },
    );
    expect(result.kind).toBe("indeterminate");
    owned.delete("attempt-a");
    resolveCompletion({
      outcome: "success",
      exitCode: OCX_ELEVATED_SUCCESS,
      stdout: "",
      stderr: "",
    });
    if (result.kind !== "indeterminate") throw new Error("expected indeterminate");
    await expect(result.reconciliation).resolves.toBe("released");
    expect(writeCount).toBe(0);
  });

  test("launch failure during create+run does not write install state", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("launch-failed", "Windows PowerShell was not found for elevation.");
      },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toMatchObject({ reason: "launch-failed" });
    expect(writeCount).toBe(0);
  });

  test("signal termination during create+run surfaces reconciliation detail", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("terminated", "Windows elevation terminated by SIGTERM.");
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(writeCount).toBe(0);
  });

  test("signal termination with leftover task reports cleanup guidance", async () => {
    mockParentRollbackSpawn();
    let calls = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        throw new WindowsElevationError("terminated", "Windows elevation terminated by SIGTERM.");
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => {
        calls += 1;
        return calls === 1;
      },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result|Cleanup/);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("protocol-failed with no task present reconciles without inventing a phase", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: 99, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(writeCount).toBe(0);
  });

  test("protocol-failed with task present attempts parent cleanup and does not write state", async () => {
    mockParentRollbackSpawn();
    let calls = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "protocol-failed", exitCode: OCX_ELEVATED_PROTOCOL_FAILED, stdout: "", stderr: "" };
      },
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => {
        calls += 1;
        return calls === 1; // present before cleanup, absent after
      },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/unknown result/);
    expect(elevateLaunches).toBe(1);
    expect(parentRollbackLaunches).toBe(1);
    expect(writeCount).toBe(0);
  });

  test("verification conflict rolls back and does not write install state", async () => {
    mockParentRollbackSpawn();
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        registrationInvalid: false,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: false,
        conflict: true,
        ok: false,
        detail: "CONFLICT: Task Scheduler and native WinSW are both present.",
      }),
      writeInstallState: () => { writeCount += 1; },
      taskInstalled: () => false,
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/CONFLICT/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("unknown WinSW status fails closed without claiming conflict and without rollback", async () => {
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: async () => {
        elevateLaunches += 1;
        return { outcome: "success", exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
      },
      verify: () => ({
        taskInstalled: true,
        registrationHealthy: true,
        registrationInvalid: false,
        assetsHealthy: true,
        nativeServiceAbsent: false,
        nativeStatusUnknown: true,
        conflict: false,
        ok: false,
        detail: "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent.",
      }),
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/could not verify/);
    expect(elevateLaunches).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  // --- Post-create settle (#868) -------------------------------------------------
  //
  // Task Scheduler's non-elevated view can lag an elevated /create, so a one-shot
  // verification rolls back a task that is merely not visible yet. These cases pin
  // both halves: the lagging view must settle, and every fail-closed state must
  // still fail closed without spending a single delay.

  function absentVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler task is not installed.",
    };
  }

  // Transient lag: the task is visible but its XML has not been published yet.
  function unhealthyVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler registration is present but unhealthy.",
    };
  }

  // Permanent invalidity: the XML IS published and violates the contract.
  function invalidVerify(): WindowsSchedulerInstallVerification {
    return {
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: true,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler registration is present but unhealthy.",
    };
  }

  function succeedingElevation() {
    return async () => {
      elevateLaunches += 1;
      return { outcome: "success" as const, exitCode: OCX_ELEVATED_SUCCESS, stdout: "", stderr: "" };
    };
  }

  test("a lagging scheduler view settles into a healthy install instead of rolling back", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    const sequence = [absentVerify(), unhealthyVerify(), okVerify()];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => sequence[probes++] ?? okVerify(),
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    const result = await finalizeWindowsSchedulerServiceRegistration();
    expect(result).toEqual({ kind: "done" });
    expect(probes).toBe(3);
    expect(delays).toEqual([50, 150]);
    expect(writeCount).toBe(1);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("a persistently unhealthy registration exhausts the bounded budget and then rolls back", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return unhealthyVerify(); },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/present but unhealthy/);
    expect(probes).toBe(5);
    expect(delays).toEqual([50, 150, 300, 600]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a published-but-invalid registration rolls back immediately with zero delays", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return invalidVerify(); },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    // Permanent invalidity: ONE probe, no settle delay, rollback right away —
    // waiting can never repair published-but-violating XML.
    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/present but unhealthy/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a proven conflict is never retried into success", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: false,
          conflict: true,
          ok: false,
          detail: "CONFLICT: Task Scheduler and native WinSW are both present.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/CONFLICT/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("missing assets fail immediately — waiting does not create files", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: false,
          nativeServiceAbsent: true,
          nativeStatusUnknown: false,
          conflict: false,
          ok: false,
          detail: "Required scheduler service assets are missing.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/assets are missing/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("a proven-present WinSW service blocks retry even before the task becomes visible", async () => {
    // conflict only turns true once the task itself is visible, so an invisible task
    // beside a running WinSW is `conflict: false, nativeServiceAbsent: false`. A
    // predicate that only checked `!conflict` would happily retry this.
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: false,
          registrationHealthy: false,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: false,
          conflict: false,
          ok: false,
          detail: "Task Scheduler task is not installed.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/not installed/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(1);
  });

  test("unknown WinSW status is unproven, not transient, and still preserves the task", async () => {
    mockParentRollbackSpawn();
    const delays: number[] = [];
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        return {
          taskInstalled: true,
          registrationHealthy: true,
          registrationInvalid: false,
          assetsHealthy: true,
          nativeServiceAbsent: false,
          nativeStatusUnknown: true,
          conflict: false,
          ok: false,
          detail: "The Task Scheduler task was created, but OpenCodex could not verify that the native WinSW service is absent.",
        };
      },
      settleDelay: async ms => { delays.push(ms); },
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).rejects.toThrow(/could not verify/);
    expect(probes).toBe(1);
    expect(delays).toEqual([]);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("the settle predicate refuses every unproven state on its own terms", () => {
    // The end-to-end unknown-SCM test above cannot isolate this: its fixture has
    // taskInstalled and registrationHealthy both true, so the FINAL clause is
    // already false and deleting an earlier guard leaves it green. Exercising the
    // predicate directly with a transient-looking tail (invisible task) is what
    // proves each guard carries its own weight.
    const transientTail: WindowsSchedulerInstallVerification = {
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeServiceAbsent: true,
      nativeStatusUnknown: false,
      conflict: false,
      ok: false,
      detail: "Task Scheduler task is not installed.",
    };

    // Baseline: a scheduler view that has genuinely not caught up may settle.
    expect(schedulerVerificationMaySettle(transientTail)).toBe(true);

    // Each of these is unproven or permanent, and must refuse even though the
    // transient tail below it still looks retryable.
    expect(schedulerVerificationMaySettle({ ...transientTail, ok: true })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, conflict: true })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, assetsHealthy: false })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, nativeServiceAbsent: false })).toBe(false);
    expect(schedulerVerificationMaySettle({ ...transientTail, registrationInvalid: true })).toBe(false);

    // And a fully healthy-but-not-ok view has nothing left to wait for.
    expect(schedulerVerificationMaySettle({
      ...transientTail,
      taskInstalled: true,
      registrationHealthy: true,
    })).toBe(false);
  });

  test("ownership lost during a settle delay stops without rollback or state write", async () => {
    mockParentRollbackSpawn();
    let owned = true;
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => { probes += 1; return absentVerify(); },
      settleDelay: async () => { owned = false; },
      stillOwnsAttempt: () => owned,
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).resolves.toEqual({ kind: "done" });
    expect(probes).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("ownership lost around a non-retryable failure skips rollback too", async () => {
    // The settle loop never awaits for a non-retryable verdict, so this is the only
    // path that reaches the pre-rollback ownership fence: a stale attempt must not
    // delete a task that a newer attempt now owns.
    mockParentRollbackSpawn();
    let owned = true;
    let probes = 0;
    setFinalizeWindowsSchedulerHooksForTests({
      elevateCreateAndRun: succeedingElevation(),
      verify: () => {
        probes += 1;
        owned = false;
        return unhealthyVerify();
      },
      settleDelay: async () => { throw new Error("must not settle a non-retryable verdict"); },
      stillOwnsAttempt: () => owned,
      writeInstallState: () => { writeCount += 1; },
    });

    await expect(finalizeWindowsSchedulerServiceRegistration()).resolves.toEqual({ kind: "done" });
    expect(probes).toBe(1);
    expect(writeCount).toBe(0);
    expect(parentRollbackLaunches).toBe(0);
  });

  test("runElevatedSchtasksCreateAndRun launches PowerShell once and classifies protocol exit", async () => {
    let launches = 0;
    setWindowsElevationSpawnForTests((() => {
      launches += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { setEncoding?: (enc: string) => void };
        stderr: EventEmitter & { setEncoding?: (enc: string) => void };
        kill: ReturnType<typeof mock>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => undefined;
      child.stderr.setEncoding = () => undefined;
      child.kill = mock(() => true);
      queueMicrotask(() => child.emit("close", OCX_ELEVATED_SUCCESS, null));
      return child as never;
    }) as never);

    const result = await runElevatedSchtasksCreateAndRun(
      "schtasks.exe",
      ["/create", "/tn", "opencodex-proxy", "/f"],
      ["/run", "/tn", "opencodex-proxy"],
      ["/delete", "/tn", "opencodex-proxy", "/f"],
    );
    expect(launches).toBe(1);
    expect(result.outcome).toBe("success");
    expect(result.exitCode).toBe(OCX_ELEVATED_SUCCESS);
  });
});

describe("evaluateSchedulerInstallRestartReconciliation", () => {
  test("reports orphan task when scheduler task exists without install state", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: null,
    }).status).toBe("orphan-task");
  });

  test("reports stale install state when task is absent", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: false,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("stale-install-state");
  });

  test("reports conflict when task and WinSW are both present", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "stopped",
      installStateBackend: "scheduler",
    }).status).toBe("conflict");
  });

  test("reports healthy for verified scheduler-only install", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("healthy");
  });

  test("reports unverified when WinSW status is unknown", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "unknown",
      installStateBackend: "scheduler",
    }).status).toBe("unverified");
  });

  test("reports unhealthy for bad XML or missing assets", () => {
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: false,
      registrationInvalid: false,
      assetsHealthy: true,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("unhealthy");
    expect(evaluateSchedulerInstallRestartReconciliation({
      taskInstalled: true,
      registrationHealthy: true,
      registrationInvalid: false,
      assetsHealthy: false,
      nativeStatus: "nonexistent",
      installStateBackend: "scheduler",
    }).status).toBe("unhealthy");
  });
});
