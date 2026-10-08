import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTrustedWindowsElevationExecutablesForTests } from "../../src/lib/windows-elevation";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import {
  PICKER_CA_COMMON_NAME,
  PICKER_HOST,
  pickerCaFingerprints,
} from "../../src/claude/intercept/picker-ca";
import {
  inspectPickerTrust,
  trustPickerCa,
  untrustPickerCa,
} from "../../src/claude/intercept/picker-trust";
import {
  buildWindowsTrustInspectScript,
  buildWindowsTrustInstallScript,
  buildWindowsTrustRemoveScript,
  defaultWindowsPowerShellRunner,
  inspectPickerTrustWindows,
  normalizePickerTrustSha1,
  sanitizeWindowsPowerShellEnv,
  trustPickerCaWindows,
  untrustPickerCaWindows,
  WINDOWS_TRUST_IMPORT_TIMEOUT_MS,
  WINDOWS_TRUST_INSPECT_TIMEOUT_MS,
  WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX,
  WINDOWS_TRUST_POWERSHELL_PREFIX,
  WINDOWS_TRUST_UNTRUST_TIMEOUT_MS,
  type WindowsTrustResult,
  type WindowsTrustRunner,
} from "../../src/claude/intercept/picker-trust-windows";

// Mutations use fake runners; the native parser case only parses scripts, never executing them.
const SHA1 = "AB".repeat(20);
const LEAF = "C:\\ocx-test\\leaf.pem";

function result(stdout: string, code: number | null): WindowsTrustResult {
  return { code, stdout, stderr: "" };
}

interface Captured {
  run: WindowsTrustRunner;
  argv: string[][];
  timeouts: Array<number | undefined>;
}

function capture(...results: WindowsTrustResult[]): Captured {
  const argv: string[][] = [];
  const timeouts: Array<number | undefined> = [];
  const run: WindowsTrustRunner = async (args, options) => {
    argv.push([...args]);
    timeouts.push(options?.timeoutMs);
    return results.shift() ?? result("", 2);
  };
  return { run, argv, timeouts };
}

function scriptOf(call: string[], prefix: readonly string[]): string {
  expect(call.slice(0, -1)).toEqual([...prefix]);
  const script = call.at(-1) ?? "";
  expect(script.length).toBeGreaterThan(0);
  return script;
}

function decodedPaths(script: string): string[] {
  const found: string[] = [];
  const pattern = /FromBase64String\(\x27([^\x27]+)\x27\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script)) !== null) {
    found.push(Buffer.from(match[1]!, "base64").toString("utf8"));
  }
  return found;
}

function assertScriptShape(script: string, embeddedPaths: string[]): void {
  expect(script).toContain("X509Store('Root','CurrentUser')");
  expect(script).not.toContain("LocalMachine");
  expect(script).not.toContain("Import-Certificate");
  expect(decodedPaths(script)).toEqual(embeddedPaths);
}

test.skipIf(process.platform !== "win32")("generated trust scripts parse in Windows PowerShell without executing store changes", async () => {
  const path = "C:\\한글 'quoted'\\$certificate.pem";
  const scripts = [buildWindowsTrustInspectScript(path, SHA1), buildWindowsTrustInstallScript(path, SHA1), buildWindowsTrustRemoveScript(SHA1)];
  const literals = scripts.map(script => `'${Buffer.from(script).toString("base64")}'`).join(",");
  const parser = `$sources=@(${literals});foreach($source in $sources){$tokens=$null;$errors=$null;`+
    "$script=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($source));"+
    "[System.Management.Automation.Language.Parser]::ParseInput($script,[ref]$tokens,[ref]$errors) | Out-Null;"+
    "if($errors.Count -gt 0){exit 1}};exit 0";
  const parsed = await defaultWindowsPowerShellRunner([...WINDOWS_TRUST_POWERSHELL_PREFIX, parser]);
  expect(parsed.code).toBe(0);
}, 30_000);

test("windows inspection trusts only an exact thumbprint match with a chain marker", async () => {
  const captured = capture(result("OCX_PICKER_TRUST=TRUSTED\n", 0));
  expect(await inspectPickerTrustWindows(LEAF, SHA1, captured.run)).toBe("trusted");
  expect(captured.argv).toHaveLength(1);
  expect(captured.timeouts).toEqual([WINDOWS_TRUST_INSPECT_TIMEOUT_MS]);
  const script = scriptOf(captured.argv[0]!, WINDOWS_TRUST_POWERSHELL_PREFIX);
  assertScriptShape(script, [LEAF]);
  expect(script).toContain(SHA1);
  expect(script).toContain(PICKER_HOST);
  expect(script).toContain("Thumbprint -eq");
});

test("windows inspection is a single read-only call that never installs", async () => {
  const captured = capture(result("OCX_PICKER_TRUST=UNTRUSTED\n", 1));
  expect(await inspectPickerTrustWindows(LEAF, SHA1, captured.run)).toBe("untrusted");
  expect(captured.argv).toHaveLength(1);
  const script = scriptOf(captured.argv[0]!, WINDOWS_TRUST_POWERSHELL_PREFIX);
  expect(script).not.toContain("ReadWrite");
  expect(script).toContain("ReadOnly");
});

test("windows inspection maps errors and mismatched markers to unknown", async () => {
  expect(await inspectPickerTrustWindows(LEAF, SHA1, capture(result("OCX_PICKER_TRUST=ERROR\n", 2)).run)).toBe("unknown");
  expect(await inspectPickerTrustWindows(LEAF, SHA1, capture(result("OCX_PICKER_TRUST=TRUSTED\n", 1)).run)).toBe("unknown");
  expect(await inspectPickerTrustWindows(LEAF, SHA1, capture(result("OCX_PICKER_TRUST=UNTRUSTED\n", 0)).run)).toBe("unknown");
  expect(await inspectPickerTrustWindows(LEAF, SHA1, capture(result("noise\n", 0)).run)).toBe("unknown");
  expect(await inspectPickerTrustWindows(LEAF, SHA1, async () => { throw new Error("spawn failed"); })).toBe("unknown");
});

test("windows inspection rejects malformed fingerprints without spawning", async () => {
  const run: WindowsTrustRunner = async () => { throw new Error("runner must stay idle"); };
  for (const bad of ["", "xyz", "AB".repeat(19), `${SHA1}ZZ`, "A".repeat(41)]) {
    expect(await inspectPickerTrustWindows(LEAF, bad, run)).toBe("untrusted");
  }
  expect(normalizePickerTrustSha1("ab:".repeat(20).slice(0, -1))).toBe(SHA1);
  expect(normalizePickerTrustSha1("nope")).toBeNull();
});

test("powershell environment drops module paths case-insensitively", () => {
  const env = sanitizeWindowsPowerShellEnv({
    PSModulePath: "C:\\mods",
    psmodulepath: "C:\\mods2",
    PSMODULEPATH: "C:\\mods3",
    Path: "C:\\bin",
  } as NodeJS.ProcessEnv);
  expect(env).toEqual({ Path: "C:\\bin" });
});

function mintPickerCa(commonName: string): string {
  return createCertificateAuthority({ commonName, permittedDnsNames: [PICKER_HOST] }).certPem;
}

test("windows trust installs a private snapshot of the authorized bytes", async () => {
  const pem = mintPickerCa(PICKER_CA_COMMON_NAME);
  const { sha1 } = pickerCaFingerprints(pem);
  const dir = mkdtempSync(join(tmpdir(), "ocx-picker-win-shared-"));
  const shared = join(dir, "ca.pem");
  writeFileSync(shared, pem);
  let script = "";
  let installedPath = "";
  let installedContent = "";
  const timeouts: Array<number | undefined> = [];
  const run: WindowsTrustRunner = async (args, options) => {
    timeouts.push(options?.timeoutMs);
    script = scriptOf(args, WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX);
    const [snapshot] = decodedPaths(script);
    installedPath = snapshot ?? "";
    installedContent = readFileSync(installedPath, "utf8");
    return result("OCX_PICKER_TRUST=INSTALLED\n", 0);
  };
  try {
    expect(await trustPickerCaWindows(shared, run, { pem })).toEqual({ ok: true });
    expect(timeouts).toEqual([WINDOWS_TRUST_IMPORT_TIMEOUT_MS]);
    expect(installedPath).not.toBe(shared);
    expect(installedContent).toBe(pem);
    expect(script).toContain(sha1);
    assertScriptShape(script, [installedPath]);
    expect(existsSync(installedPath)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windows trust falls back to the ca file when no snapshot bytes are given", async () => {
  const pem = mintPickerCa(PICKER_CA_COMMON_NAME);
  const dir = mkdtempSync(join(tmpdir(), "ocx-picker-win-fallback-"));
  const caPath = join(dir, "ca.pem");
  writeFileSync(caPath, pem);
  try {
    const run: WindowsTrustRunner = async () => result("OCX_PICKER_TRUST=INSTALLED\n", 0);
    expect(await trustPickerCaWindows(caPath, run)).toEqual({ ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windows trust refuses foreign authorities and malformed input without spawning", async () => {
  const run: WindowsTrustRunner = async () => { throw new Error("runner must stay idle"); };
  expect(await trustPickerCaWindows(LEAF, run, { pem: mintPickerCa("unrelated root") }))
    .toEqual({ ok: false, reason: "declined_or_failed" });
  expect(await trustPickerCaWindows(LEAF, run, { pem: "not a certificate" }))
    .toEqual({ ok: false, reason: "declined_or_failed" });
  expect(await trustPickerCaWindows("C:\\definitely\\missing\\ca.pem", run))
    .toEqual({ ok: false, reason: "declined_or_failed" });
  expect(await trustPickerCaWindows(LEAF, async () => result("", 1), { pem: mintPickerCa(PICKER_CA_COMMON_NAME) }))
    .toEqual({ ok: false, reason: "declined_or_failed" });
});

test("windows untrust removes by exact thumbprint and reports failures", async () => {
  const removed = capture(result("OCX_PICKER_TRUST=REMOVED\n", 0));
  expect(await untrustPickerCaWindows(SHA1, removed.run)).toEqual({ ok: true });
  expect(removed.timeouts).toEqual([WINDOWS_TRUST_UNTRUST_TIMEOUT_MS]);
  const script = scriptOf(removed.argv[0]!, WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX);
  assertScriptShape(script, []);
  expect(script).toContain(SHA1);
  expect(script).toContain("Thumbprint -eq");
  expect(await untrustPickerCaWindows(SHA1, capture(result("OCX_PICKER_TRUST=ERROR\n", 1)).run))
    .toEqual({ ok: false });
  const idle: WindowsTrustRunner = async () => { throw new Error("runner must stay idle"); };
  expect(await untrustPickerCaWindows("garbage", idle)).toEqual({ ok: false });
});

test("generated scripts carry no module dependency and reject bad inputs", () => {
  assertScriptShape(buildWindowsTrustInspectScript(LEAF, SHA1), [LEAF]);
  assertScriptShape(buildWindowsTrustInstallScript(LEAF, SHA1), [LEAF]);
  assertScriptShape(buildWindowsTrustRemoveScript(SHA1), []);
  expect(() => buildWindowsTrustInspectScript("", SHA1)).toThrow();
  expect(() => buildWindowsTrustInspectScript(LEAF, "bad")).toThrow();
  expect(() => buildWindowsTrustInstallScript(LEAF, "bad")).toThrow();
  expect(() => buildWindowsTrustRemoveScript("bad")).toThrow();
});

test("the shared entry point dispatches win32 to the windows adapter", async () => {
  const trusted = capture(result("OCX_PICKER_TRUST=TRUSTED\n", 0));
  expect(await inspectPickerTrust(LEAF, SHA1, trusted.run, "win32")).toBe("trusted");
  expect(trusted.argv[0]!.slice(0, 4)).toEqual([...WINDOWS_TRUST_POWERSHELL_PREFIX]);
  const installed = capture(result("OCX_PICKER_TRUST=INSTALLED\n", 0));
  expect(await trustPickerCa(LEAF, installed.run, "win32", { pem: mintPickerCa(PICKER_CA_COMMON_NAME) }))
    .toEqual({ ok: true });
  expect(installed.argv[0]!.slice(0, -1)).toEqual([...WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX]);
  const removed = capture(result("OCX_PICKER_TRUST=REMOVED\n", 0));
  expect(await untrustPickerCa(LEAF, SHA1, removed.run, "win32")).toEqual({ ok: true });
  expect(removed.argv[0]!.slice(0, -1)).toEqual([...WINDOWS_TRUST_POWERSHELL_INTERACTIVE_PREFIX]);
});

const FAKE_TRUSTED_POWERSHELL =
  "C:\\trusted-system32\\WindowsPowerShell\\v1.0\\powershell.exe";

test("default runner kills the child and surfaces stdout read failures instead of timing out", async () => {
  setTrustedWindowsElevationExecutablesForTests({ powershell: FAKE_TRUSTED_POWERSHELL });
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("boom-stdout"));
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>(resolve => {
    resolveExited = resolve;
  });
  let kills = 0;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    stdout,
    stderr,
    exited,
    kill() {
      kills += 1;
      resolveExited(1);
    },
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const started = Date.now();
    const outcome = await defaultWindowsPowerShellRunner([...WINDOWS_TRUST_POWERSHELL_PREFIX, "exit 0"], {
      timeoutMs: 5_000,
    });
    expect(kills).toBe(1);
    expect(outcome.code).toBeNull();
    expect(outcome.stderr).toContain("boom-stdout");
    expect(outcome.stderr).not.toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    spawn.mockRestore();
    setTrustedWindowsElevationExecutablesForTests(null);
  }
});

test("default runner kills a hung child and reports a timeout", async () => {
  setTrustedWindowsElevationExecutablesForTests({ powershell: FAKE_TRUSTED_POWERSHELL });
  let resolveExited!: (code: number) => void;
  const exited = new Promise<number>(resolve => {
    resolveExited = resolve;
  });
  const stdout = new ReadableStream<Uint8Array>({});
  const stderr = new ReadableStream<Uint8Array>({});
  let kills = 0;
  const spawn = spyOn(Bun, "spawn").mockReturnValue({
    stdout,
    stderr,
    exited,
    kill() {
      kills += 1;
      resolveExited(1);
    },
  } as unknown as ReturnType<typeof Bun.spawn>);
  try {
    const outcome = await defaultWindowsPowerShellRunner([...WINDOWS_TRUST_POWERSHELL_PREFIX, "exit 0"], {
      timeoutMs: 20,
    });
    expect(kills).toBe(1);
    expect(outcome.code).toBeNull();
    expect(outcome.stderr).toContain("timed out after 20ms");
  } finally {
    spawn.mockRestore();
    setTrustedWindowsElevationExecutablesForTests(null);
  }
});
