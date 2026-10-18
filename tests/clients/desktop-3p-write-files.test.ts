import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveConfig } from "../../src/config";
import { atomicReplaceDesktopConfig, writeDesktop3pConfig } from "../../src/claude/desktop-3p";
import { MAX_DESKTOP_PROFILE_FILE_BYTES, parseMetadata, readDesktopProfileForeignKeys, readDesktopProfileSnapshot } from "../../src/claude/desktop-3p-library";
import * as desktopLibrary from "../../src/claude/desktop-3p-library";
import { isTestHomeGuardArmed } from "../../src/lib/test-home-guard";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

let root: string, library: string;
let priorHome: string | undefined, priorLibrary: string | undefined;
const writeProfile = (apiKey = "fixture-key") => writeDesktop3pConfig(4096, [], [{ provider: "test", id: "fixture-model" }],
  apiKey, "static", undefined, undefined, { lockPath: join(root, "locks", "desktop.sqlite") });

beforeEach(() => {
  expect(isTestHomeGuardArmed()).toBe(true);
  priorHome = process.env.OPENCODEX_HOME;
  priorLibrary = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ocx-desktop-write-files-")));
  library = join(root, "desktop");
  fs.mkdirSync(library);
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
  saveConfig({ port: 4096, defaultProvider: "test", providers: { test: {
    adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true,
    liveModels: false, models: ["fixture-model"],
  } }, clientIntegrations: { "claude-desktop": true } } as OcxConfig);
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  if (priorLibrary === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = priorLibrary;
  removeTreeWithRetry(root);
});

for (const kind of ["absent", "regular"] as const) {
  test(`${kind} metadata publishes exactly one referenced profile`, () => {
    const meta = join(library, "_meta.json");
    if (kind === "regular") fs.writeFileSync(meta, '{"entries":[]}\n');
    const result = writeProfile();
    expect(result.written).toBe(true);
    const metadata = parseMetadata(meta);
    expect(metadata.entries).toHaveLength(1);
    expect(`${metadata.appliedId}.json`).toBe(basename(result.path));
    expect(fs.readdirSync(library).sort()).toEqual(["_meta.json", basename(result.path)].sort());
  });
}

test.skipIf(process.platform === "win32")("dangling metadata refuses repeated apply without creating profiles", () => {
  const meta = join(library, "_meta.json"), target = join(root, "missing-meta.json");
  fs.symlinkSync(target, meta);
  expect(() => parseMetadata(meta)).toThrow("desktop_config_not_regular");
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(writeProfile()).toMatchObject({ written: false, reason: "desktop_config_not_regular" });
    expect(fs.readdirSync(library)).toEqual(["_meta.json"]);
    expect(fs.readlinkSync(meta)).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  }
});

test.skipIf(process.platform === "win32")("a dangling profile is not treated as absent", () => {
  const path = join(library, "profile.json");
  fs.symlinkSync(join(root, "missing-profile.json"), path);
  expect(() => readDesktopProfileForeignKeys(path)).toThrow("desktop_config_not_regular");
  expect(() => readDesktopProfileSnapshot(path)).toThrow("desktop_config_not_regular");
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(`${path}.bak`)).toBe(false);
});

test("metadata read errors propagate without publishing a profile", () => {
  const meta = join(library, "_meta.json");
  const stat = fs.lstatSync;
  const denied = Object.assign(new Error("fixture denied"), { code: "EACCES" });
  const reading = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
    if (path === meta) throw denied;
    return stat(path, options as { bigint: true });
  }) as typeof fs.lstatSync);
  try {
    expect(() => parseMetadata(meta)).toThrow(denied);
    expect(writeProfile()).toMatchObject({ written: false, reason: "fixture denied" });
    expect(fs.readdirSync(library)).toEqual([]);
  } finally { reading.mockRestore(); }
});

test("backup preserves exact bytes and an absent profile does not adopt a stale backup", () => {
  const path = join(library, "bytes.json");
  const bytes = Buffer.from([0x7b, 0xff, 0x00, 0xfe, 0x7d]);
  fs.writeFileSync(path, bytes);
  expect(atomicReplaceDesktopConfig(path, "{}\n", fs.readFileSync(path))).toEqual({ backupPath: `${path}.bak` });
  expect(fs.readFileSync(`${path}.bak`)).toEqual(bytes);
  fs.unlinkSync(path);
  expect(atomicReplaceDesktopConfig(path, "{}\n", undefined)).toEqual({});
  expect(fs.readFileSync(`${path}.bak`)).toEqual(bytes);
});

test("metadata publication failure removes a profile the same apply created", () => {
  const meta = join(library, "_meta.json");
  const rename = fs.renameSync;
  const publishing = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (destination === meta) throw new Error("fixture metadata failure");
    rename(source, destination);
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(writeProfile()).toMatchObject({ written: false, reason: "fixture metadata failure" });
      expect(fs.readdirSync(library)).toEqual([]);
    }
  } finally { publishing.mockRestore(); }
});

test("metadata publication failure restores the previous regular profile bytes", () => {
  const initial = writeProfile();
  expect(initial.written).toBe(true);
  const previous = fs.readFileSync(initial.path);
  const meta = join(library, "_meta.json"), metadata = fs.readFileSync(meta);
  const rename = fs.renameSync;
  const publishing = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
    if (destination === meta) throw new Error("fixture metadata failure");
    rename(source, destination);
  });
  try {
    expect(writeProfile("replacement-fixture-key")).toMatchObject({ written: false, reason: "fixture metadata failure" });
    expect(fs.readFileSync(initial.path)).toEqual(previous);
    expect(fs.readFileSync(`${initial.path}.bak`)).toEqual(previous);
    expect(fs.readFileSync(meta)).toEqual(metadata);
  } finally { publishing.mockRestore(); }
});

for (const change of ["edit", "replace", "remove", "create"] as const) {
  test(`normal apply refuses a concurrent profile ${change} without changing metadata or backup`, () => {
    const initial = writeProfile();
    expect(initial.written).toBe(true);
    const profile = initial.path, meta = join(library, "_meta.json");
    const metadata = fs.readFileSync(meta), original = fs.readFileSync(profile);
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), userSetting: "concurrent edit" }));
    const backup = Buffer.from("previous backup\n");
    fs.writeFileSync(`${profile}.bak`, backup);
    if (change === "create") fs.unlinkSync(profile);
    const readSnapshot = desktopLibrary.readDesktopProfileSnapshot;
    const reading = spyOn(desktopLibrary, "readDesktopProfileSnapshot").mockImplementation(path => {
      const snapshot = readSnapshot(path);
      if (path === profile) {
        if (change === "remove") fs.unlinkSync(path);
        else if (change === "replace") {
          const replacement = join(library, "replacement.json");
          fs.writeFileSync(replacement, edited);
          fs.renameSync(replacement, path);
        } else fs.writeFileSync(path, edited);
      }
      return snapshot;
    });
    try {
      expect(writeProfile("replacement-fixture-key")).toMatchObject({ written: false, reason: "desktop_profile_changed" });
      if (change === "remove") expect(fs.existsSync(profile)).toBe(false);
      else expect(fs.readFileSync(profile)).toEqual(edited);
      expect(fs.readFileSync(`${profile}.bak`)).toEqual(backup);
      expect(fs.readFileSync(meta)).toEqual(metadata);
    } finally { reading.mockRestore(); }
  });
}

test("normal apply refuses a profile edit while the replacement temp is being written", () => {
  const initial = writeProfile();
  expect(initial.written).toBe(true);
  const profile = initial.path, meta = join(library, "_meta.json"), metadata = fs.readFileSync(meta);
  const original = fs.readFileSync(profile), edited = Buffer.from('{"userSetting":"late edit"}\n');
  const open = fs.openSync, write = fs.writeFileSync;
  let profileTemp: number | undefined, changed = false;
  const opening = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
    const fd = open(path, flags, mode);
    if (String(path).startsWith(`${profile}.ocx.`)) profileTemp = fd;
    return fd;
  }) as typeof fs.openSync);
  const writing = spyOn(fs, "writeFileSync").mockImplementation(((path, bytes, options) => {
    write(path, bytes, options);
    if (path === profileTemp && !changed) { changed = true; write(profile, edited); }
  }) as typeof fs.writeFileSync);
  try {
    expect(writeProfile("replacement-fixture-key")).toMatchObject({ written: false, reason: "desktop_profile_changed" });
    expect(changed).toBe(true);
    expect(fs.readFileSync(profile)).toEqual(edited);
    expect(fs.readFileSync(`${profile}.bak`)).toEqual(original);
    expect(fs.readFileSync(meta)).toEqual(metadata);
    expect(fs.readdirSync(library).some(name => name.endsWith(".tmp"))).toBe(false);
  } finally { writing.mockRestore(); opening.mockRestore(); }
});

for (const existing of [true, false]) {
  test(`metadata failure remains primary if ${existing ? "profile restore" : "new-profile cleanup"} also fails`, () => {
    const initial = existing ? writeProfile() : undefined;
    const meta = join(library, "_meta.json"), metadata = existing ? fs.readFileSync(meta) : undefined;
    const rename = fs.renameSync, unlink = fs.unlinkSync;
    let metadataFailed = false;
    const publishing = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === meta) { metadataFailed = true; throw new Error("fixture metadata failure"); }
      if (metadataFailed && destination === initial?.path) throw new Error("fixture restore failure");
      rename(source, destination);
    });
    const removing = spyOn(fs, "unlinkSync").mockImplementation(path => {
      if (!existing && metadataFailed && String(path).endsWith(".json")) throw new Error("fixture cleanup failure");
      unlink(path);
    });
    try {
      expect(writeProfile("replacement-fixture-key")).toMatchObject({
        written: false,
        reason: `fixture metadata failure (profile rollback also failed: fixture ${existing ? "restore" : "cleanup"} failure)`,
      });
      if (existing) expect(fs.readFileSync(meta)).toEqual(metadata!);
      else expect(fs.existsSync(meta)).toBe(false);
    } finally { removing.mockRestore(); publishing.mockRestore(); }
  });
}

for (const timing of ["existing", "created", "restoring"] as const) {
  test(`metadata failure preserves a profile another writer changed after publish (${timing})`, () => {
    const initial = timing === "created" ? undefined : writeProfile();
    const meta = join(library, "_meta.json"), metadata = initial ? fs.readFileSync(meta) : undefined;
    const concurrent = Buffer.from('{"userSetting":"other writer"}\n');
    const rename = fs.renameSync, write = fs.writeFileSync;
    let metadataFailed = false, changed = false, profile = initial?.path;
    const publishing = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (destination === meta) {
        metadataFailed = true;
        if (timing !== "restoring") { write(profile!, concurrent); changed = true; }
        throw new Error("fixture metadata failure");
      }
      rename(source, destination);
      if (!metadataFailed && String(destination).endsWith(".json")) profile = String(destination);
    });
    // "restoring" edits the live profile while the rollback temp is written, after the first check.
    const writing = spyOn(fs, "writeFileSync").mockImplementation(((path, bytes, options) => {
      write(path, bytes, options);
      if (timing === "restoring" && metadataFailed && typeof path === "number" && !changed) {
        changed = true; write(profile!, concurrent);
      }
    }) as typeof fs.writeFileSync);
    try {
      expect(writeProfile("replacement-fixture-key")).toMatchObject({
        written: false, reason: "fixture metadata failure (profile rollback skipped: profile changed after publish)",
      });
      expect(changed).toBe(true);
      expect(fs.readFileSync(profile!)).toEqual(concurrent);
      if (metadata) expect(fs.readFileSync(meta)).toEqual(metadata);
      else expect(fs.existsSync(meta)).toBe(false);
      expect(fs.readdirSync(library).some(name => name.includes(".ocx."))).toBe(false);
    } finally { writing.mockRestore(); publishing.mockRestore(); }
  });
}


for (const scenario of ["backup", "rollback"] as const) {
  // Revalidation refuses a FIFO swapped onto the profile; rollback reuses verified bytes even if
  // the backup becomes a FIFO. Neither path can block on an unsafe synchronous read.
  test.skipIf(process.platform === "win32")(`normal writer never opens a ${scenario} path swapped to a FIFO`, () => {
    const initial = writeProfile();
    expect(initial.written).toBe(true);
    const profile = initial.path, meta = join(library, "_meta.json");
    const metadata = fs.readFileSync(meta), original = fs.readFileSync(profile), fifo = join(root, "replacement.fifo");
    expect(spawnSync("mkfifo", [fifo], { timeout: 5000 }).status).toBe(0);
    // Bound the process even if a regression blocks inside a synchronous copy. The real
    // writer and SQLite lifecycle lock run against this fixture with inherited home guards.
    const code = `
      import { spyOn } from "bun:test";
      import * as fs from "node:fs";
      import { writeDesktop3pConfig } from ${JSON.stringify(repoPath("src/claude/desktop-3p.ts"))};
      import { isTestHomeGuardArmed } from ${JSON.stringify(repoPath("src/lib/test-home-guard.ts"))};
      if (!isTestHomeGuardArmed()) throw new Error("guard not armed");
      const profile = ${JSON.stringify(profile)}, meta = ${JSON.stringify(meta)}, fifo = ${JSON.stringify(fifo)};
      const scenario = ${JSON.stringify(scenario)};
      const open = fs.openSync, read = fs.readSync, rename = fs.renameSync;
      let profileFd, swapped = false;
      spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        const fd = open(path, flags, mode);
        if (path === profile) profileFd = fd;
        return fd;
      });
      spyOn(fs, "readSync").mockImplementation((fd, buffer, offset, length, position) => {
        const count = read(fd, buffer, offset, length, position);
        if (scenario === "backup" && fd === profileFd && !swapped) {
          rename(fifo, profile); swapped = true;
        }
        return count;
      });
      spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (scenario === "rollback" && destination === meta) throw new Error("fixture metadata failure");
        rename(source, destination);
        if (scenario === "rollback" && destination === profile && !swapped) {
          rename(fifo, profile + ".bak"); swapped = true;
        }
      });
      const result = writeDesktop3pConfig(4096, [], [{provider:"test",id:"fixture-model"}],
        "replacement-fixture-key", "static", undefined, undefined,
        {lockPath:${JSON.stringify(join(root, "locks", "desktop.sqlite"))}});
      fs.writeSync(1, JSON.stringify({result, swapped}));
    `;
    const child = spawnSync(process.execPath, ["--no-env-file", "-e", code], {
      env: { ...process.env }, encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    if (scenario === "backup") {
      expect(JSON.parse(child.stdout)).toMatchObject({
        swapped: true, result: { written: false, reason: "desktop_config_not_regular" },
      });
      expect(fs.existsSync(`${profile}.bak`)).toBe(false);
      expect(fs.lstatSync(profile).isFIFO()).toBe(true);
      expect(fs.readFileSync(meta)).toEqual(metadata);
    } else {
      expect(JSON.parse(child.stdout)).toMatchObject({
        swapped: true, result: { written: false, reason: "fixture metadata failure" },
      });
      expect(fs.lstatSync(`${profile}.bak`).isFIFO()).toBe(true);
      expect(fs.readFileSync(profile)).toEqual(original);
      expect(fs.readFileSync(meta)).toEqual(metadata);
    }
  }, 20000);
}

test("oversized backup source refuses before backup or replacement writes", () => {
  const path = join(library, "oversized.json");
  const original = Buffer.alloc(MAX_DESKTOP_PROFILE_FILE_BYTES + 1, 32);
  fs.writeFileSync(path, original);
  let writes = 0;
  expect(() => atomicReplaceDesktopConfig(path, "{}\n", original, () => { writes++; }))
    .toThrow("desktop_config_too_large");
  expect(writes).toBe(0);
  expect(fs.readFileSync(path).equals(original)).toBe(true);
  expect(fs.existsSync(path + ".bak")).toBe(false);
});

for (const kind of ["profile", "metadata"] as const) for (const extra of [0, 1]) {
  test(`normal writer preflights exact ${kind} output limit+${extra}`, () => {
    const first = writeProfile(); expect(first.written).toBe(true);
    const meta = join(library, "_meta.json"), target = kind === "profile" ? first.path : meta;
    const value = { ...JSON.parse(fs.readFileSync(target, "utf8")), foreignPad: "" };
    value.foreignPad = "x".repeat(MAX_DESKTOP_PROFILE_FILE_BYTES + extra - Buffer.byteLength(JSON.stringify(value, null, 2) + "\n"));
    expect(Buffer.byteLength(JSON.stringify(value, null, 2) + "\n")).toBe(MAX_DESKTOP_PROFILE_FILE_BYTES + extra);
    const input = JSON.stringify(value); expect(Buffer.byteLength(input)).toBeLessThan(MAX_DESKTOP_PROFILE_FILE_BYTES);
    fs.writeFileSync(target, input);
    const beforeProfile = fs.readFileSync(first.path), beforeMeta = fs.readFileSync(meta);
    expect(fs.existsSync(first.path + ".bak")).toBe(false);
    const result = writeProfile();
    if (extra) {
      expect(result).toMatchObject({ written: false, reason: "desktop_config_too_large" });
      expect(fs.readFileSync(first.path)).toEqual(beforeProfile); expect(fs.readFileSync(meta)).toEqual(beforeMeta);
      expect(fs.existsSync(first.path + ".bak")).toBe(false);
    } else {
      expect(result.written).toBe(true); expect(fs.statSync(target).size).toBe(MAX_DESKTOP_PROFILE_FILE_BYTES);
      expect(JSON.parse(fs.readFileSync(target, "utf8")).foreignPad).toBe(value.foreignPad);
      expect(fs.readFileSync(first.path + ".bak")).toEqual(beforeProfile);
    }
  }, 20_000);
}
