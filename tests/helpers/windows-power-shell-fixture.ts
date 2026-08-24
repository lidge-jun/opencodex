import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WindowsPowerShellFixture {
  executable: string;
  cleanup: () => void | Promise<void>;
}

let sharedFixture: Promise<WindowsPowerShellFixture> | undefined;

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
  if (sharedFixture) return sharedFixture;
  sharedFixture = process.platform === "win32"
    ? buildWindowsExecutableFixture()
    : Promise.resolve(createPosixShellFixture());
  return sharedFixture;
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
