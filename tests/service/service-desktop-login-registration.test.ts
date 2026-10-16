import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { macLoginFactsFor } from "../../src/service/desktop-startup";
import { fixturePath } from "../helpers/repo-root";

// One registration judgment, two implementations: Startup safety here and the Desktop tray's
// Start at Login item in desktop/src-tauri/src/login_registration.rs. Both suites run every case
// in this fixture, so neither side can drift without failing (#6972).
interface LoginCase {
  name: string;
  plist: Record<string, unknown> | null;
  plutilFails?: boolean;
  proxy?: boolean;
  plistLink?: boolean;
  touchPlistOnRead?: boolean;
  disabled: string | null;
  disabledAfterFirstRead?: string;
  loaded: { stdout: string } | { status: number; stderr: string; signal?: string } | { failure: string };
  expect: { tray: string; loginEnabled: boolean; loginRegistration?: "loaded" | "registered-not-loaded" };
}

const { cases } = JSON.parse(readFileSync(fixturePath("desktop-login-registration-cases.json"), "utf8")) as { cases: LoginCase[] };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fill<T>(value: T, paths: Record<string, string>): T {
  if (typeof value === "string") return value.replace(/\{[A-Z_]+\}/g, key => paths[key.slice(1, -1)] ?? key) as T;
  if (Array.isArray(value)) return value.map(item => fill(item, paths)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, paths)])) as T;
  }
  return value;
}

function judge(raw: LoginCase) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-login-parity-")));
  roots.push(root);
  const home = join(root, "home");
  const paths = {
    APP: join(root, "OpenCodex.app", "Contents", "MacOS", "opencodex-desktop"),
    OTHER_APP: join(root, "Other", "OpenCodex.app", "Contents", "MacOS", "opencodex-desktop"),
    MISSING_APP: join(root, "Gone", "OpenCodex.app", "Contents", "MacOS", "opencodex-desktop"),
    PLIST: join(home, "Library", "LaunchAgents", "OpenCodex.plist"),
    OTHER_PLIST: join(home, "Other.plist"),
    UID: "501",
  };
  const c = fill(raw, paths);
  const files = [paths.APP, paths.OTHER_APP, join(dirname(paths.OTHER_APP), "ocx"), paths.OTHER_PLIST];
  if (c.proxy !== false) files.push(join(dirname(paths.APP), "ocx"));
  const realPlist = join(home, "Real.plist");
  if (c.plist !== null) files.push(c.plistLink ? realPlist : paths.PLIST);
  for (const file of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture");
    chmodSync(file, 0o700);
  }
  if (c.plist !== null && c.plistLink) {
    mkdirSync(dirname(paths.PLIST), { recursive: true });
    symlinkSync(realPlist, paths.PLIST);
  }
  let disabledReads = 0;
  const run = (command: string, args: string[]) => {
    if (command === "/usr/bin/plutil") {
      if (c.touchPlistOnRead) writeFileSync(paths.PLIST, "rewritten while it was read");
      if (c.plutilFails || c.plist === null) throw new Error("plutil failed");
      return JSON.stringify(c.plist);
    }
    if (command === "/bin/launchctl" && args[0] === "print-disabled") {
      disabledReads++;
      if (c.disabled === null) throw new Error("print-disabled failed");
      return disabledReads > 1 && c.disabledAfterFirstRead !== undefined ? c.disabledAfterFirstRead : c.disabled;
    }
    if (command === "/bin/launchctl" && args[0] === "print") {
      if ("stdout" in c.loaded) return c.loaded.stdout;
      if ("failure" in c.loaded) {
        throw Object.assign(new Error(`launchctl ${c.loaded.failure}`), { code: "ETIMEDOUT", signal: "SIGTERM", status: null });
      }
      throw Object.assign(new Error("launchctl print failed"), {
        status: c.loaded.status, stderr: Buffer.from(c.loaded.stderr), signal: c.loaded.signal ?? null,
      });
    }
    throw new Error(`unexpected command: ${command}`);
  };
  // diagnoseSupervisedStartup turns a thrown login probe into an uncredited registration.
  try {
    return macLoginFactsFor(realpathSync(paths.APP), { platform: "darwin", home, uid: 501, run });
  } catch {
    return { loginEnabled: false };
  }
}

// The judgment needs POSIX paths (the registered program must end in /Contents/MacOS/...) and
// symlinks, which Windows runners do not provide without privileges.
const parity = process.platform === "win32" ? test.skip : test;

test("the shared fixture keeps the tray's checked state equal to Startup safety's credit", () => {
  expect(cases.length).toBeGreaterThan(40);
  for (const c of cases) {
    expect({ name: c.name, checked: c.expect.tray === "on" }).toEqual({ name: c.name, checked: c.expect.loginEnabled });
    expect({ name: c.name, registration: c.expect.loginRegistration !== undefined }).toEqual({ name: c.name, registration: c.expect.loginEnabled });
  }
});

for (const c of cases) {
  parity(`Startup safety login credit: ${c.name}`, () => {
    const { loginEnabled, loginRegistration } = c.expect;
    expect(judge(c)).toEqual({ loginEnabled, ...(loginRegistration ? { loginRegistration } : {}) });
  });
}
