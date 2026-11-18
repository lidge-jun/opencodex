import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync,
  truncateSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setWindowsHardeningForTests } from "../../src/config/atomic-write";
import { GATEWAY_CLIENTS, type GatewayClientContext } from "../../src/integrations/gateway-clients";
import * as atomicReplace from "../../src/lib/windows-atomic-replace";
import { setIcaclsRunnerForTests, setPlatformForTests } from "../../src/lib/windows-secret-acl";

const target = { url: "http://127.0.0.1:10100", apiKey: "opencodex-local" };
const originals = { antigravity: '{"theme":"dark","models":{"defaultModelId":"mine"}}\n', agy: "# original\n" };
let root: string;
let ctx: GatewayClientContext;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocx-gw-safety-")));
  ctx = { home: join(root, "home"), platform: "linux", env: { SHELL: "/bin/zsh" },
    stateDir: join(root, "state"), adminSettingsPath: join(root, "admin.json") };
  mkdirSync(join(ctx.home, ".antigravity"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = (path: string) => readFileSync(path, "utf8");
const recordPath = (id: string) => join(ctx.stateDir, "gateway-clients", id + ".json");
const settings = () => join(ctx.home, ".antigravity", "settings.json");
const profile = () => join(ctx.home, ".zshrc");

for (const [id, pathOf] of [["antigravity", settings], ["agy", profile]] as const) {
  const client = GATEWAY_CLIENTS[id];
  test(id + " refuses an out-of-scope restore path and retains its record", () => {
    const path = pathOf();
    writeFileSync(path, originals[id]);
    expect(client.connect(ctx, target).ok).toBe(true);
    const connected = read(path);
    const other = join(root, "unrelated");
    writeFileSync(other, connected);
    const record = JSON.parse(read(recordPath(id)));
    (id === "agy" ? record.files[0] : record).path = other;
    writeFileSync(recordPath(id), JSON.stringify(record));
    expect(client.disconnect(ctx)).toMatchObject({ ok: false, changed: false });
    expect(read(other)).toBe(connected);
    expect(read(path)).toBe(connected);
    expect(existsSync(recordPath(id))).toBe(true);
  });

  for (const action of ["connect", "disconnect"] as const) {
    test(id + " refuses a concurrent edit before " + action + " publishes", () => {
      const path = pathOf();
      writeFileSync(path, originals[id]);
      if (action === "disconnect") expect(client.connect(ctx, target).ok).toBe(true);
      const edit = id === "antigravity" ? '{"theme":"new"}\n' : "# new edit\n";
      const originalRename = atomicReplace.renameAtomicFile;
      const rename = spyOn(atomicReplace, "renameAtomicFile").mockImplementation((...args) => {
        if (args[1] === path) writeFileSync(path, edit);
        return originalRename(...args);
      });
      try {
        const result = action === "connect" ? client.connect(ctx, target) : client.disconnect(ctx);
        expect(result).toMatchObject({ ok: false, code: "io-error", changed: false });
      } finally { rename.mockRestore(); }
      expect(read(path)).toBe(edit);
      expect(existsSync(recordPath(id))).toBe(true);
    });
  }
}

test("both connector mutations obey the shared config lock", () => {
  expect(GATEWAY_CLIENTS.antigravity.connect(ctx, target).ok).toBe(true);
  const db = new Database(join(ctx.stateDir, "config-mutation.sqlite"));
  db.exec("BEGIN IMMEDIATE");
  try {
    expect(GATEWAY_CLIENTS.agy.connect(ctx, target)).toMatchObject({ ok: false, code: "io-error" });
    expect(GATEWAY_CLIENTS.antigravity.disconnect(ctx)).toMatchObject({ ok: false, code: "io-error" });
    expect(existsSync(profile())).toBe(false);
    expect(existsSync(recordPath("antigravity"))).toBe(true);
  } finally { db.close(); }
});

test.skipIf(process.platform === "win32")("a symlinked profile is read, written and restored without replacing the link", () => {
  const actual = join(root, "dotfiles-zshrc");
  writeFileSync(actual, originals.agy);
  symlinkSync(actual, profile());
  expect(GATEWAY_CLIENTS.agy.connect(ctx, target).ok).toBe(true);
  expect(read(actual)).toContain("opencodex agy");
  expect(lstatSync(profile()).isSymbolicLink()).toBe(true);
  expect(GATEWAY_CLIENTS.agy.disconnect(ctx).restore).toBe("exact");
  expect(lstatSync(profile()).isSymbolicLink()).toBe(true);
  expect(read(actual)).toBe(originals.agy);
});

test.skipIf(process.platform === "win32")("restore refuses a profile symlink retargeted after connect", () => {
  const first = join(root, "dotfiles-zshrc");
  const second = join(root, "other-zshrc");
  writeFileSync(first, originals.agy);
  symlinkSync(first, profile());
  expect(GATEWAY_CLIENTS.agy.connect(ctx, target).ok).toBe(true);
  const connected = read(first);
  writeFileSync(second, connected);
  rmSync(profile());
  symlinkSync(second, profile());
  expect(GATEWAY_CLIENTS.agy.disconnect(ctx)).toMatchObject({ ok: false, changed: false });
  expect(read(first)).toBe(connected);
  expect(read(second)).toBe(connected);
  expect(existsSync(recordPath("agy"))).toBe(true);
});

test("client reads refuse an oversized profile and a non-regular settings file", () => {
  writeFileSync(profile(), "");
  truncateSync(profile(), 4 * 1024 * 1024);
  writeFileSync(profile(), " ", { flag: "a" });
  mkdirSync(settings());
  expect(GATEWAY_CLIENTS.agy.connect(ctx, target)).toMatchObject({ ok: false, changed: false });
  expect(GATEWAY_CLIENTS.antigravity.connect(ctx, target)).toMatchObject({ ok: false, changed: false });
  expect(existsSync(recordPath("agy"))).toBe(false);
  expect(existsSync(recordPath("antigravity"))).toBe(false);
});

test("Windows ACL hardening applies to restore records and leaves client files inherited", () => {
  ctx.platform = "win32";
  const ps = join(ctx.home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
  mkdirSync(dirname(ps), { recursive: true });
  writeFileSync(ps, originals.agy);
  writeFileSync(settings(), originals.antigravity);
  const aclPaths: string[] = [];
  setPlatformForTests("win32");
  setWindowsHardeningForTests(true);
  setIcaclsRunnerForTests(args => {
    if (args.includes("/inheritance:r")) aclPaths.push(args[0]!);
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });
  try {
    expect(GATEWAY_CLIENTS.antigravity.connect(ctx, target).ok).toBe(true);
    expect(GATEWAY_CLIENTS.agy.connect(ctx, target).ok).toBe(true);
    expect(GATEWAY_CLIENTS.antigravity.disconnect(ctx).ok).toBe(true);
    expect(GATEWAY_CLIENTS.agy.disconnect(ctx).ok).toBe(true);
    const under = (dir: string) => aclPaths.some(path => dirname(path) === dir);
    expect(under(join(ctx.stateDir, "gateway-clients"))).toBe(true);
    expect(under(dirname(settings()))).toBe(false);
    expect(under(dirname(ps))).toBe(false);
  } finally {
    setWindowsHardeningForTests(null);
    setIcaclsRunnerForTests(null);
    setPlatformForTests(null);
  }
  expect(read(ps)).toBe(originals.agy);
  expect(read(settings())).toBe(originals.antigravity);
});

test("agy keeps an undecodable tracked profile and its restore record", () => {
  writeFileSync(profile(), originals.agy);
  expect(GATEWAY_CLIENTS.agy.connect(ctx, target).ok).toBe(true);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(read(profile()), "utf16le").swap16()]);
  writeFileSync(profile(), utf16be);
  expect(GATEWAY_CLIENTS.agy.disconnect(ctx)).toMatchObject({ ok: false, code: "unsupported-file" });
  expect(existsSync(recordPath("agy"))).toBe(true);
  expect(readFileSync(profile())).toEqual(utf16be);
});

test("agy refuses BOM-less UTF-16 instead of appending a different encoding", () => {
  const utf16 = Buffer.from(originals.agy, "utf16le");
  writeFileSync(profile(), utf16);
  expect(GATEWAY_CLIENTS.agy.connect(ctx, target)).toMatchObject({ ok: false, code: "unsupported-file" });
  expect(readFileSync(profile())).toEqual(utf16);
});

test("Antigravity reconnect retains a matching pending default after an unrelated edit", () => {
  writeFileSync(settings(), originals.antigravity);
  expect(GATEWAY_CLIENTS.antigravity.connect(ctx, target).ok).toBe(true);
  const old = JSON.parse(read(recordPath("antigravity")));
  expect(GATEWAY_CLIENTS.antigravity.connect(ctx, { ...target, defaultModel: "pending" }).ok).toBe(true);
  const { written, writtenSha256 } = JSON.parse(read(recordPath("antigravity")));
  writeFileSync(recordPath("antigravity"), JSON.stringify({ ...old, pending: { written, writtenSha256 } }));
  const doc = JSON.parse(read(settings()));
  writeFileSync(settings(), JSON.stringify({ ...doc, theme: "light" }));
  expect(GATEWAY_CLIENTS.antigravity.connect(ctx, target).ok).toBe(true);
  expect(GATEWAY_CLIENTS.antigravity.disconnect(ctx).restore).toBe("path-wise");
  expect(JSON.parse(read(settings()))).toEqual({ theme: "light", models: { defaultModelId: "mine" } });
});
