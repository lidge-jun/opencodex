import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WindowsPowerShellFixture {
  executable: string;
  cleanup: () => void | Promise<void>;
}

/**
 * Run the fixture the way production runs PowerShell and return what happened.
 *
 * The collector under test swallows an enumeration error into `state: "unknown"`
 * with no processes, so a fixture that cannot execute is indistinguishable from
 * a machine with no Codex process running. That ambiguity is what made the two
 * #1852 cases read as behavioural failures on the Windows leg. Asserting this
 * first turns "the fixture is broken" into its own named, self-describing
 * failure.
 */
export async function probeWindowsPowerShellFixture(
  fixture: WindowsPowerShellFixture,
  timeoutMs = 5_000,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const child = Bun.spawn([fixture.executable, "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", "probe"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    const completed = await Promise.race([
      Promise.all([stdoutPromise, stderrPromise, child.exited])
        .then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })),
      Bun.sleep(timeoutMs).then(() => null),
    ]);
    if (!completed) {
      try { child.kill(); } catch { /* already exited */ }
      let reaped = await Promise.race([
        child.exited.then(() => true, () => true),
        Bun.sleep(500).then(() => false),
      ]);
      if (!reaped) {
        try { child.kill(9); } catch { /* already exited */ }
        reaped = await Promise.race([
          child.exited.then(() => true, () => true),
          Bun.sleep(500).then(() => false),
        ]);
      }
      void stdoutPromise.catch(() => {});
      void stderrPromise.catch(() => {});
      return { ok: false, detail: `timed out after ${timeoutMs}ms; reaped=${reaped}` };
    }
    const { stdout, stderr, exitCode } = completed;
    if (exitCode === 0 && stdout.includes("codex app-server")) {
      return { ok: true, detail: `exit=0 stdout=${JSON.stringify(stdout)}` };
    }
    return {
      ok: false,
      detail: `exit=${exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr.slice(0, 400))}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

/**
 * Build a real Windows executable for tests that exercise the default execFile path.
 *
 * A .cmd file is not a CreateProcess target, so Node/Bun's shell-free execFile rejects
 * it with EINVAL on Windows. The compiled fixture consumes the same PowerShell-shaped
 * argv as production, waits long enough for an interval to run, and emits deterministic
 * rows for both the process and start-time queries. On POSIX, retain the small shell
 * fixture because the production Windows branch is only reached after the platform is
 * explicitly faked by the tests.
 */
export function createWindowsPowerShellFixture(): Promise<WindowsPowerShellFixture> {
  // Each suite owns its fixture. Sharing one directory across suites lets the
  // first cleanup remove the executable while another suite is still using it.
  return process.platform === "win32"
    ? buildWindowsExecutableFixture()
    : Promise.resolve(createPosixShellFixture());
}

async function buildWindowsExecutableFixture(): Promise<WindowsPowerShellFixture> {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ps-fixture-"));
  const source = join(dir, "fake-powershell.ts");
  const executable = join(dir, "fake-powershell.exe");
  writeFileSync(source, [
    "const command = process.argv.slice(2).join(' ');",
    "await new Promise(resolve => setTimeout(resolve, 200));",
    "if (command.includes('CreationDate')) {",
    "  process.stdout.write('42\\t1970-01-01T00:00:00.500Z\\n');",
    "} else {",
    "  process.stdout.write('42\\t/usr/local/bin/codex app-server\\tCONTOSO\\\\jun\\n');",
    "}",
  ].join("\n"));

  const result = await Bun.build({
    entrypoints: [source],
    compile: { target: "bun-windows-x64", outfile: executable },
  });
  if (!result.success) {
    rmSync(dir, { recursive: true, force: true });
    const details = result.logs.map(log => log.message).join("\n");
    throw new Error(`Could not compile Windows PowerShell test fixture: ${details}`);
  }
  return {
    executable,
    cleanup: () => removeFixtureDirectory(dir),
  };
}

function createPosixShellFixture(): WindowsPowerShellFixture {
  const dir = mkdtempSync(join(tmpdir(), "ocx-ps-fixture-"));
  const executable = join(dir, "fake-powershell.sh");
  writeFileSync(executable, [
    "#!/bin/sh",
    "sleep 0.2",
    "case \"$*\" in",
    "  *CreationDate*) printf '42\\t1970-01-01T00:00:00.500Z\\n' ;;",
    "  *) printf '42\\t/usr/local/bin/codex app-server\\tCONTOSO\\\\jun\\n' ;;",
    "esac",
  ].join("\n"), { mode: 0o755 });
  return {
    executable,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function removeFixtureDirectory(dir: string): Promise<void> {
  // Windows can keep a just-exited compiled child image open for a short interval.
  // Retry the temp cleanup so an antivirus/file-close race does not turn an otherwise
  // passing test file into an unnamed afterAll failure.
  const retryableCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (typeof code !== "string" || !retryableCodes.has(code)) throw error;
      lastError = error;
      await Bun.sleep(50);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not remove Windows PowerShell test fixture after 2s: ${detail}`);
}
