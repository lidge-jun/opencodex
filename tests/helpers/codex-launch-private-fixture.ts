import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolveTrustedWindowsPowerShellExe } from "../../src/lib/windows-elevation";
import { dirname, join } from "node:path";
import { buildCodexLaunchEnv } from "../../src/cli/codex-launcher";
import { codexCredentialDestinationIsTrusted } from "../../src/cli/codex-launch-auth";
import { codexLaunchHomeIsOwned } from "../../src/cli/codex-launch-ownership";
import { removeTreeWithRetry } from "./remove-tree";

let location: { base: string; owned: boolean; refusals: string[] } | undefined;

function fixtureLocation() {
  if (location) return location;
  if (process.platform !== "win32") return location = { base: tmpdir(), owned: true, refusals: [] };
  // The suite rewrites USERPROFILE/TEMP beneath its sandbox, which may live on
  // a writable CI work drive. Try real profile Temp without touching client data.
  // The explicit override is for reproducing that unsafe ancestor environment.
  const candidates = process.env.OCX_CODEX_TEST_FIXTURE_ROOT ? [process.env.OCX_CODEX_TEST_FIXTURE_ROOT] : [
    join(process.env.SystemRoot ?? "C:/Windows", "Temp"),
    ...(process.env.OCX_REAL_HOME ? [join(process.env.OCX_REAL_HOME, "AppData", "Local", "Temp")] : []),
    tmpdir(),
  ];
  const refusals: string[] = [];
  let fallback: string | undefined;
  for (const base of new Set(candidates)) {
    if (!existsSync(base)) continue;
    let root: string;
    try { root = realpathSync(mkdtempSync(join(base, "ocx-ownership-probe-"))); }
    catch (error) {
      if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    try {
      makeCodexLaunchFixturePrivate(root);
      writeFileSync(join(root, "config.toml"), 'model="fixture"\n');
      if (!codexLaunchHomeIsOwned(root)) {
        let reason: string | undefined;
        expect(codexCredentialDestinationIsTrusted(root, join(root, "system"), value => { reason = value; })).toBe(false);
        expect(reason).toBe("ownership");
        refusals.push(base); fallback ??= base;
        continue;
      }
      // A real profile can contain a distinct project config; never borrow it.
      let clean = true;
      for (let parent = base; ; parent = dirname(parent)) {
        if (existsSync(join(parent, ".codex", "config.toml"))) clean = false;
        if (dirname(parent) === parent) break;
      }
      if (clean) return location = { base, owned: true, refusals };
    } finally { removeTreeWithRetry(root); }
  }
  if (!fallback) throw new Error("No isolated Codex fixture location; no ownership refusal proved");
  return location = { base: fallback, owned: false, refusals };
}

export function createCodexLaunchFixtureRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(fixtureLocation().base, prefix)));
  makeCodexLaunchFixturePrivate(root);
  return root;
}

export function codexLaunchFixtureHasProtectedAncestors(): boolean {
  return fixtureLocation().owned;
}

/** Gate only assertions that need a protected starting point, with an executed refusal proof. */
export function codexLaunchOwnershipTest(name: string, body: () => void | Promise<void>, timeout?: number): void {
  const support = fixtureLocation();
  if (support.owned) { test(name, body, timeout); return; }
  test(`${name}: unsafe Windows fixture refuses before token read`, () => {
    const root = createCodexLaunchFixtureRoot("ocx-refused-fixture-");
    try {
      writeFileSync(join(root, "config.toml"), 'model="fixture"\n');
      expect(codexLaunchHomeIsOwned(root)).toBe(false);
      let reason: string | undefined, reads = 0;
      const env = buildCodexLaunchEnv({ CODEX_HOME: root }, {
        credentialDestination: (home, report) => codexCredentialDestinationIsTrusted(home, join(home, "system"), value => { reason = value; report?.(value); }),
        serviceToken: () => { reads++; return "ocx_fixture_must_not_read"; },
      });
      expect(reason).toBe("ownership");
      expect(reads).toBe(0);
      expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
      expect(support.refusals.length).toBeGreaterThan(0);
    } finally { removeTreeWithRetry(root); }
  });
  test.skip(`${name} (no protected Windows fixture ancestor chain; ownership refusal proved)`, body);
}

/** Still exercise the mutating negative scenario when its later diagnostic is unreachable. */
export function codexLaunchProjectRefusalTest(name: string, body: (reason: "project" | "ownership") => void | Promise<void>): void {
  // This is a negative scenario, so its body must never be replaced or skipped.
  test(name, () => body(fixtureLocation().owned ? "project" : "ownership"));
}

// Model a protected, empty machine configuration namespace inside this fixture.
// Every other authority check uses real config/ownership IO. Native probes use production defaults.
export const buildCodexPrivateFixtureLaunchEnv: typeof buildCodexLaunchEnv = (base, deps) => buildCodexLaunchEnv(base, {
  credentialDestination: (home, report) => codexCredentialDestinationIsTrusted(home, join(home, "system-namespace-fixture"), report), ...deps,
});

/** Windows Temp grants Users create rights to descendants; model a private Codex home. */
export function makeCodexLaunchFixturePrivate(path: string): void {
  if (process.platform !== "win32") { chmodSync(path, 0o700); return; }
  const script = String.raw`$ErrorActionPreference='Stop'
$user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @($user,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($env:OCX_TEST_PRIVATE_DIRECTORY,$acl)`;
  const result = Bun.spawnSync([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...process.env, OCX_TEST_PRIVATE_DIRECTORY: path }, stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  if (!result.success) throw new Error("Cannot create private Codex launch fixture");
}
