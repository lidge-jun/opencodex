import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  codexRuntimeStatePath, resolveCodexRuntime, resolveCodexRuntimeAsync,
  setCodexRuntimeResolveCacheForTests, type ResolveCodexRuntimeDeps,
} from "../../src/codex/runtime";
import { loadBundledCodexCatalog, loadBundledCodexCatalogAsync } from "../../src/codex/catalog/bundled";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await removeTreeWithRetry(path); });
const SYSTEM = "/Applications/ChatGPT.app";
const CURRENT = "Contents/Resources/codex-cli/bin/codex";
const OLDER = "Contents/Resources/codex";
const BACKING = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const ID = "<key>CFBundleIdentifier</key><string>com.openai.codex</string>";
const plist = (body = ID) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${body}</dict></plist>`;

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ocx-mac-runtime-")));
  roots.push(home);
  const bundle = posix.join(home.replaceAll("\\", "/"), "Applications/ChatGPT.app");
  const configDir = join(home, "config");
  mkdirSync(configDir);
  mkdirSync(join(bundle, "Contents"), { recursive: true });
  const info = join(bundle, "Contents/Info.plist");
  writeFileSync(info, plist());
  const versions = new Map<string, string>();
  const probed: string[] = [];
  const exec = (file: string) => {
    probed.push(file);
    const version = versions.get(file);
    if (!version) throw new Error("not found");
    return `codex-cli ${version}`;
  };
  const deps: ResolveCodexRuntimeDeps = {
    platform: "darwin", env: { HOME: home.replaceAll("\\", "/"), PATH: "" }, configDir,
    existsSync: path => versions.has(path), execFileSync: exec, execFile: async file => exec(file),
    // Virtual executables stay injected; real fixture symlinks retain their
    // canonical targets. Both trust halves are stubbed so no dscl/codesign runs.
    executable: path => versions.has(path),
    realpath: path => { try { return realpathSync(path); } catch { return path; } },
    macBundleTrustReason: () => null,
    macBundleTrustReasonAsync: async () => null,
  };
  const pin = (command: string, origin?: "pinned" | "discovered") => writeFileSync(codexRuntimeStatePath(configDir), JSON.stringify({
    version: 1, command, source: "installed", selectedVersion: "0.150.0", updatedAt: "2026-10-13T00:00:00Z", origin,
  }));
  return { bundle, info, versions, probed, deps, pin, current: `${bundle}/${CURRENT}`, older: `${bundle}/${OLDER}` };
}

// These real XML fixtures use POSIX bundle paths; Windows cannot materialize them.
describe.skipIf(process.platform === "win32")("macOS Codex app runtime discovery (#6973)", () => {
  for (const layout of [CURRENT, OLDER]) test(`discovers ${layout} with matching XML identity`, () => {
    const f = fixture(), command = `${f.bundle}/${layout}`;
    f.versions.set(command, "0.162.0");
    expect(resolveCodexRuntime(f.deps).runtime).toEqual({ command, source: "installed", version: "0.162.0" });
  });

  test("system bundle precedes user bundle and current entrypoint precedes older layout", () => {
    const f = fixture();
    for (const bundle of [SYSTEM, f.bundle]) for (const layout of [CURRENT, OLDER]) f.versions.set(`${bundle}/${layout}`, "0.162.0");
    const read: string[] = [];
    f.deps.readBundleIdentifier = path => { read.push(path); return "com.openai.codex"; };
    expect(resolveCodexRuntime(f.deps).runtime.command).toBe(`${SYSTEM}/${CURRENT}`);
    expect(read).toContain(`${SYSTEM}/Contents/Info.plist`);
    f.versions.delete(`${SYSTEM}/${CURRENT}`);
    expect(resolveCodexRuntime(f.deps).runtime.command).toBe(`${SYSTEM}/${OLDER}`);
    f.versions.delete(`${SYSTEM}/${OLDER}`);
    expect(resolveCodexRuntime(f.deps).runtime.command).toBe(f.current);
  });

  test("rejects an app CLI that fails publisher or filesystem trust before probing", () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0");
    const checked: string[][] = [];
    f.deps.macBundleTrustReason = (bundle, binary) => { checked.push([bundle, binary]); return "untrusted"; };
    expect(resolveCodexRuntime(f.deps).runtime.source).toBe("fallback");
    expect(checked).toContainEqual([f.bundle, f.current]);
    expect(f.probed).not.toContain(f.current);
  });

  for (const source of ["environment", "configured", "shim", "path", "installed", "fallback"] as const) {
    test(`${source} precedes the app during version discovery`, () => {
      const f = fixture();
      const command = source === "fallback" ? "codex" : source === "installed" ? "/usr/local/bin/codex" : "/fixture/bin/codex";
      f.versions.set(source === "fallback" ? "/usr/bin/codex" : command, "0.150.0"); f.versions.set(f.current, "0.162.0");
      // No enumerated PATH candidates: execvp still finds the bare fallback on its default path.
      if (source === "fallback") delete f.deps.env!.PATH;
      if (source === "environment") f.deps.env!.CODEX_CLI_PATH = command;
      if (source === "configured") f.pin(command, "pinned");
      if (source === "shim") writeFileSync(join(f.deps.configDir!, "codex-shim.json"), JSON.stringify({ originalPath: command }));
      if (source === "path") f.deps.env!.PATH = "/fixture/bin";
      expect(resolveCodexRuntime(f.deps).runtime).toEqual({ command, source, version: "0.150.0" });
      if (source === "fallback") expect(f.probed).toContain("/usr/bin/codex");
    });
  }

  test("deferred discovery skips bare fallback and reaches the app without spawning", () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0"); f.versions.set("codex", "0.150.0");
    expect(resolveCodexRuntime({ ...f.deps, probeVersion: false, discoverAlternatives: false }).runtime)
      .toEqual({ command: f.current, source: "installed", version: null });
    expect(f.probed).toEqual([]);
    f.versions.clear();
    expect(resolveCodexRuntime({ ...f.deps, probeVersion: false }).runtime.source).toBe("fallback");
  });

  for (const origin of [undefined, "discovered", "pinned"] as const) for (const discoverAlternatives of [true, false]) {
    test(`persisted ${origin ?? "legacy"} selection stays (alternatives=${discoverAlternatives})`, () => {
      const f = fixture(), command = "/fixture/persisted/codex";
      f.pin(command, origin); f.versions.set(command, "0.150.0"); f.versions.set(f.current, "0.162.0");
      const result = resolveCodexRuntime({ ...f.deps, discoverAlternatives });
      expect(result.runtime.command).toBe(command);
      expect(result.supersededDiscovered).toBeUndefined();
      expect(result.replacedConfigured).toBeUndefined();
      if (discoverAlternatives) expect(result.newerAvailable?.command).toBe(f.current);
      else { expect(f.probed).not.toContain(f.current); expect(result.newerAvailable).toBeUndefined(); }
    });
  }

  const invalid = {
    missing: null, mismatched: plist(ID.replace("com.openai.codex", "com.openai.chat")),
    binary: "bplist00CFBundleIdentifiercom.openai.codex", oversized: plist() + " ".repeat(64 * 1024),
    duplicate: plist(ID + ID), encodedDuplicate: plist(ID + ID.replace("CFBundleIdentifier", "CFBundleIdentifi&#101;r")), nested: plist(`<key>Nested</key><dict>${ID}</dict>`),
    malformed: plist().replace("</dict>", "</array>"), nonXML: JSON.stringify({ CFBundleIdentifier: "com.openai.codex" }),
    trailingMarkup: plist() + "<", paddedIdentity: plist(ID.replace("com.openai.codex", " com.openai.codex ")), directory: null,
  };
  for (const [kind, content] of Object.entries(invalid)) test(`${kind} plist identity excludes the app`, () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0");
    if (content !== null) writeFileSync(f.info, content);
    else {
      unlinkSync(f.info);
      if (kind === "directory") mkdirSync(f.info);
    }
    expect(resolveCodexRuntime(f.deps).runtime.source).toBe("fallback");
    expect(f.probed).not.toContain(f.current);
  });

  test("nested duplicate keys do not shadow the single top-level identity", () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0");
    writeFileSync(f.info, plist(`${ID}<key>Nested</key><dict>${ID}</dict>`));
    expect(resolveCodexRuntime(f.deps).runtime.command).toBe(f.current);
  });

  const malformedOutsideIdentity = {
    undefinedEntity: plist(`${ID}<key>Other</key><string>a &bogus; b</string>`),
    literalNul: plist(`${ID}<key>Other</key><string>a\u0000b</string>`),
    keyWithoutValue: plist(`${ID}<key>Nested</key><dict><key>A</key><key>B</key></dict>`),
    unknownElement: plist(`${ID}<key>Other</key><widget>x</widget>`),
    badInteger: plist(`${ID}<key>Other</key><integer>12abc</integer>`),
    textInArray: plist(`${ID}<key>Other</key><array>loose<string>x</string></array>`),
    doctypeInsideIdentity: plist(ID.replace("com.openai.codex",
      'com.openai.<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">codex')),
    doctypeInsideIdentityWithoutProlog: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>${ID.replace("com.openai.codex",
      'com.openai.<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">codex')}</dict></plist>`,
    nonCharacterHexRef: plist(`${ID}<key>Other</key><string>&#xFFFF;</string>`),
    nonCharacterDecimalRef: plist(`${ID}<key>Other</key><string>&#65534;</string>`),
    doubleHyphenComment: plist(`${ID}<!-- a -- b --><key>Other</key><string>x</string>`),
    cdataTerminatorText: plist(`${ID}<key>Other</key><string>a ]]> b</string>`),
    garbageDeclaration: plist().replace('<?xml version="1.0" encoding="UTF-8"?>', "<?xml garbage?>"),
    nulInDeclaration: plist().replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0" \u0000?>'),
    latin1Declaration: plist().replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
  };
  for (const [kind, content] of Object.entries(malformedOutsideIdentity)) {
    test(`a matching identity inside a malformed document is rejected: ${kind}`, () => {
      const f = fixture(); f.versions.set(f.current, "0.162.0");
      writeFileSync(f.info, content);
      expect(resolveCodexRuntime(f.deps).runtime.source).toBe("fallback");
      expect(f.probed).not.toContain(f.current);
    });
  }

  test("a well-formed document with other value types keeps its identity", () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0");
    writeFileSync(f.info, plist(`${ID}<key>N</key><integer>-3</integer><key>R</key><real>1.5e3</real><key>D</key><date>2026-10-13T00:00:00Z</date>`
      + `<key>B</key><data>AAEC
  Aw==</data><key>T</key><true/><key>A</key><array><string>x &amp; y</string><dict/></array>`));
    expect(resolveCodexRuntime(f.deps).runtime.command).toBe(f.current);
  });

  // HOME reached through a symlink: the canonical bundle path must classify the same as the lexical one.
  function symlinkedHome() {
    const f = fixture();
    const real = realpathSync(posix.dirname(posix.dirname(f.bundle)));
    const link = join(mkdtempSync(join(tmpdir(), "ocx-mac-link-")), "home");
    roots.push(posix.dirname(link));
    symlinkSync(real, link);
    f.deps.env!.HOME = link;
    return { ...f, canonical: `${real}/Applications/ChatGPT.app/${CURRENT}` };
  }

  for (const matches of [true, false]) test(`a canonical path under a symlinked HOME is identity-checked (matches=${matches})`, () => {
    const f = symlinkedHome(); let reads = 0;
    f.deps.readBundleIdentifier = () => { reads++; return matches ? "com.openai.codex" : "com.example.other"; };
    f.deps.env!.CODEX_CLI_PATH = f.canonical; f.versions.set(f.canonical, "0.162.0");
    expect(resolveCodexRuntime({ ...f.deps, probeVersion: false }).runtime.source).toBe(matches ? "environment" : "fallback");
    expect(reads).toBeGreaterThan(0);
  });

  test("a canonical app path on PATH under a symlinked HOME never takes over a persisted selection", async () => {
    const f = symlinkedHome(), persisted = "/fixture/persisted/codex";
    f.pin(persisted, "discovered"); f.versions.set(persisted, "0.150.0"); f.versions.set(f.canonical, "0.162.0");
    f.deps.env!.PATH = posix.dirname(f.canonical);
    const result = resolveCodexRuntime(f.deps);
    expect(result.runtime.command).toBe(persisted);
    expect(result.supersededDiscovered).toBeUndefined();
    expect(result.replacedConfigured).toBeUndefined();
    expect(f.probed).toContain(persisted);
    expect(f.probed).toContain(f.canonical);
    expect(await resolveCodexRuntimeAsync(f.deps)).toEqual(result);
  });

  test("an established install path that links into the app keeps its precedence", () => {
    const f = fixture();
    mkdirSync(posix.dirname(f.current), { recursive: true });
    writeFileSync(f.current, "#!/bin/sh\n");
    const link = posix.join(f.deps.env!.HOME!, ".local/bin/codex");
    mkdirSync(posix.dirname(link), { recursive: true });
    symlinkSync(f.current, link);
    // The alias and its backing executable are one binary and expose one version.
    f.versions.set(link, "0.150.0"); f.versions.set(f.current, "0.150.0");
    let reads = 0;
    f.deps.readBundleIdentifier = () => { reads++; return "com.openai.codex"; };
    // The link is an established install: it precedes the app candidates and is identity-checked.
    expect(resolveCodexRuntime(f.deps).runtime).toEqual({ command: link, source: "installed", version: "0.150.0" });
    expect(f.probed).toContain(f.current);
    expect(f.probed).not.toContain(link);
    expect(reads).toBeGreaterThan(0);
    f.deps.readBundleIdentifier = () => "com.example.other";
    expect(resolveCodexRuntime(f.deps).runtime.source).toBe("fallback");
  });

  for (const probeVersion of [true, false]) test(`persisted app identity is rechecked after replacement (probe=${probeVersion})`, () => {
    const f = fixture(); f.pin(f.current); f.versions.set(f.current, "0.162.0");
    expect(resolveCodexRuntime({ ...f.deps, probeVersion }).runtime.command).toBe(f.current);
    writeFileSync(f.info, plist(ID.replace("com.openai.codex", "com.example.other")));
    f.versions.set("/usr/local/bin/codex", "0.150.0");
    const result = resolveCodexRuntime({ ...f.deps, probeVersion });
    expect(result.runtime.command).toBe("/usr/local/bin/codex");
    expect(result.replacedConfigured?.from.command).toBe(f.current);
    expect(result.replacedConfigured?.reason).toContain("identity");
  });

  test("a missing app copy recovers with replacedConfigured", () => {
    const f = fixture(); f.pin(f.current); f.versions.set(f.older, "0.162.0");
    const result = resolveCodexRuntime(f.deps);
    expect(result.runtime.command).toBe(f.older);
    expect(result.replacedConfigured?.from.command).toBe(f.current);
  });

  for (const probeVersion of [true, false]) for (const matches of [true, false]) test(`normalized backing override requires bundle identity (matches=${matches}, probe=${probeVersion})`, () => {
    const f = fixture(), command = `${f.bundle}/Contents/Resources/../Resources/${BACKING.slice("Contents/Resources/".length)}`;
    f.deps.env!.CODEX_CLI_PATH = command; f.versions.set(command, "0.162.0");
    if (!matches) writeFileSync(f.info, plist(ID.replace("com.openai.codex", "com.example.other")));
    expect(resolveCodexRuntime({ ...f.deps, probeVersion }).runtime.source).toBe(matches ? "environment" : "fallback");
    expect(f.probed.includes(command)).toBe(matches && probeVersion);
  });

  test("sibling prefix is outside the bundle and needs no identity check", () => {
    const f = fixture(), command = `${f.bundle}-other/${CURRENT}`;
    f.versions.set(command, "0.162.0"); f.deps.env!.CODEX_CLI_PATH = command;
    f.deps.readBundleIdentifier = () => { throw new Error("must not read"); };
    expect(resolveCodexRuntime(f.deps).runtime.source).toBe("environment");
  });

  for (const platform of ["linux", "win32"] as const) test(`${platform} never reads a macOS plist`, () => {
    const f = fixture(); let reads = 0;
    f.deps.readBundleIdentifier = () => { reads++; return "com.openai.codex"; };
    expect(resolveCodexRuntime({ ...f.deps, platform }).runtime.source).toBe("fallback");
    expect(reads).toBe(0);
  });

  test("sync and async agree", async () => {
    const f = fixture(); f.versions.set(f.current, "0.162.0");
    expect(await resolveCodexRuntimeAsync(f.deps)).toEqual(resolveCodexRuntime(f.deps));
  });

  test("an injected identity reader cannot populate the process memo", () => {
    expect(() => setCodexRuntimeResolveCacheForTests({ runtime: { command: "codex", version: null, source: "fallback" }, failures: [] },
      { readBundleIdentifier: () => "com.openai.codex" })).toThrow("Injected runtime dependencies");
  });

  test("an injected bundle trust check cannot populate the process memo", () => {
    expect(() => setCodexRuntimeResolveCacheForTests({ runtime: { command: "codex", version: null, source: "fallback" }, failures: [] },
      { macBundleTrustReason: () => null })).toThrow("Injected runtime dependencies");
  });
});

describe("bundled app catalog consumer", () => {
  for (const kind of ["valid", "unsupported", "spawn-failure", "null-row", "mixed-null-row", "array-row"] as const) {
    test(`${kind} output is handled by sync and async drivers`, async () => {
      const f = fixture();
      const native = { slug: "gpt-test", base_instructions: "Fixture instructions." };
      const exec = () => {
        if (kind === "unsupported") throw new Error("unrecognized subcommand 'models'");
        if (kind === "spawn-failure") throw Object.assign(new Error("not found"), { code: "ENOENT" });
        return JSON.stringify({ models: kind === "null-row" ? [null] : kind === "mixed-null-row" ? [native, null] : kind === "array-row" ? [[]] : [native] });
      };
      // A POSIX-absolute non-bundle candidate: the boundary resolves it on any
      // host (f.current is a Windows-flavored path this describe cannot use),
      // and it classifies outside the known bundles so output handling - not
      // trust - is what is exercised. Fixture versions drive exists/executable.
      const command = "/fixture/bin/codex";
      f.versions.set(command, "0.162.0");
      const deps = {
        platform: "darwin" as const, commandCandidates: () => [command], configDir: f.deps.configDir,
        execFileSync: exec, execFile: async () => exec(), env: f.deps.env,
        existsSync: f.deps.existsSync, executable: f.deps.executable, realpath: f.deps.realpath,
        macBundleTrustReason: f.deps.macBundleTrustReason, macBundleTrustReasonAsync: f.deps.macBundleTrustReasonAsync,
      };
      const sync = loadBundledCodexCatalog(deps), asyncResult = await loadBundledCodexCatalogAsync(deps);
      expect(asyncResult).toEqual(sync);
      if (kind === "valid") expect(sync?.models[0]?.slug).toBe("gpt-test");
      else expect(sync).toBeNull();
    });
  }
});
