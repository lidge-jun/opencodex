import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";
import { recoverPromptJournal } from "../../src/codex/prompt-layers";
import { journalPathFor } from "../../src/codex/prompt-layers/paths";
import { encodeJournal, hashBytes } from "../../src/codex/prompt-journal";
import * as atomic from "../../src/lib/windows-atomic-replace";

/**
 * Whether a rename destination is this fixture file. The transaction publishes
 * to the native canonical path, and on Windows runners the plain realpath of a
 * temp-dir path can keep its 8.3 short form, so compare native resolutions.
 */
function sameTarget(destination: string, fixturePath: string): boolean {
  try { return realpathSync.native(destination) === realpathSync.native(fixturePath); } catch { return false; }
}

setDefaultTimeout(SPAWN_BUDGET_MS);

const original = '# original config\nmodel_provider = "openai"\n';
const injected = '# modified\nmodel_provider = "opencodex"\n';
const profile = '# generated profile\nmodel_provider = "opencodex"\n';
const deadPid = 1234567;
const incompleteWarning = "Codex journal recovery was incomplete; the journal was preserved — check the Codex files.";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function runScript(codexHome: string, script: string) {
  const result = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: SPAWN_BUDGET_MS - 5_000,
  });
  return { stdout: result.stdout?.trim() ?? "", stderr: result.stderr?.trim() ?? "", status: result.status ?? 1 };
}

// The fixture PID is dead by construction, independent of the host's process table.
const deadOwnerScript = `
  const { spyOn } = require("bun:test");
  const originalKill = process.kill;
  let probes = 0;
  const killSpy = spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === ${deadPid} && signal === 0) {
      probes += 1;
      throw Object.assign(new Error("fixture owner exited"), { code: "ESRCH" });
    }
    return originalKill.call(process, pid, signal);
  });
`;

describe("codex-journal recovery diagnostics", () => {
  let testDir: string;
  beforeEach(() => {
    testDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-journal-recovery-")));
    writeFileSync(join(testDir, "config.toml"), original);
  });
  afterEach(() => removeTreeWithRetry(testDir));

  function seed(owner: "process" | "client", config: string, generatedProfile: boolean) {
    writeFileSync(join(testDir, "config.toml"), config);
    if (generatedProfile) writeFileSync(join(testDir, "opencodex.config.toml"), profile);
    const journal = JSON.stringify({
      version: 1,
      originalConfig: Buffer.from(original).toString("base64"),
      originalProfile: null,
      ...(generatedProfile ? { injectedConfigHash: hash(config), injectedProfileHash: hash(profile) } : {}),
      pid: deadPid,
      ...(owner === "client" ? { owner: { kind: "client", apiKeyId: "fixture-client-owner" } } : {}),
      timestamp: new Date().toISOString(),
    });
    writeFileSync(join(testDir, "opencodex-journal.json"), journal);
    return journal;
  }

  test("recovery: store retry refuses newer in-place peer bytes and keeps the journal", () => {
    const paths = { configPath: join(testDir, "config.toml"), storePath: join(testDir, "store.json") };
    const preStore = JSON.stringify({ version: 1, layers: [] });
    const postStore = JSON.stringify({ version: 1, layers: [{ id: "active", title: "Custom", body: "attempt", enabled: true }] });
    const newer = JSON.stringify({ version: 1, layers: [{ id: "peer", title: "Peer", body: "newer draft", enabled: false }] });
    writeFileSync(paths.storePath, postStore);
    const journal = journalPathFor(paths.storePath);
    // Config is already pre-image, but store needs restoring from post-image.
    const preparedJournal = encodeJournal({
      ...paths, preConfig: hashBytes(original), postConfig: hashBytes(injected),
      preStore: hashBytes(preStore), postStore: hashBytes(postStore),
      preConfigBytes: original, postConfigBytes: injected,
      preStoreBytes: preStore, postStoreBytes: postStore,
    });
    writeFileSync(journal, preparedJournal);
    const rename = atomic.renameAtomicFile;
    let intercepted = false, attempts = 0, peerEdits = 0;
    const hook = spyOn(atomic, "renameAtomicFile").mockImplementation((source, destination, io, publisher, hooks) => {
      if (!sameTarget(destination, paths.storePath) || intercepted) return rename(source, destination, io, publisher, hooks);
      intercepted = true;
      return rename(source, destination, {
        platform: "win32",
        rename: (a, b) => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("fixture sharing violation"), { code: "EBUSY" });
          renameSync(a, b);
        },
        sleep: () => {
          const inode = statSync(paths.storePath).ino;
          writeFileSync(paths.storePath, newer);
          expect(statSync(paths.storePath).ino).toBe(inode);
          peerEdits += 1;
        },
      }, publisher, hooks);
    });
    let result;
    try { result = recoverPromptJournal(paths); }
    finally { hook.mockRestore(); }
    expect(intercepted).toBe(true);
    expect(peerEdits).toBe(1);
    expect(readFileSync(paths.storePath, "utf8")).toBe(newer);
    expect(existsSync(journal)).toBe(true);
    expect(readFileSync(journal, "utf8")).toBe(preparedJournal);
    expect(result).toMatchObject({ ok: false, error: "recovery_required" });
    expect(readFileSync(paths.configPath, "utf8")).toBe(original);
    expect(attempts).toBe(1);
  });

  for (const owner of ["process", "client"] as const) {
    test(`reconcileJournal stays silent when a ${owner === "process" ? "dead-owner" : "client-owner"} journal needs no rewrite`, () => {
      seed(owner, original, false);
      const r = runScript(testDir, `${deadOwnerScript}
        const config = require("./src/config");
        const originalWrite = config.atomicWriteFile;
        let writes = 0;
        const writeSpy = spyOn(config, "atomicWriteFile").mockImplementation((...args) => {
          writes += 1;
          return originalWrite(...args);
        });
        const { reconcileJournal } = require("./src/codex/journal");
        try { console.log(JSON.stringify({ restored: reconcileJournal(), probes, writes })); }
        finally { writeSpy.mockRestore(); killSpy.mockRestore(); }
      `);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ restored: false, probes: owner === "process" ? 1 : 0, writes: 0 });
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
      expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
      expect(r.stderr).toBe("");
    });

    test(`${owner}-owner no-rewrite recovery warns when the journal cannot be removed`, () => {
      const journal = seed(owner, original, false);
      const r = runScript(testDir, `${deadOwnerScript}
        const fs = require("node:fs");
        const { syncBuiltinESMExports } = require("node:module");
        const journalPath = require("node:path").join(process.env.CODEX_HOME, "opencodex-journal.json");
        const originalUnlink = fs.unlinkSync;
        let denied = 0;
        const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
          if (path === journalPath) {
            denied += 1;
            throw Object.assign(new Error("fixture journal locked"), { code: "EBUSY" });
          }
          return originalUnlink(path);
        });
        syncBuiltinESMExports();
        const { reconcileJournal } = require("./src/codex/journal");
        try { console.log(JSON.stringify({ restored: reconcileJournal(), denied })); }
        finally { unlinkSpy.mockRestore(); syncBuiltinESMExports(); killSpy.mockRestore(); }
      `);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ restored: false, denied: 1 });
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
      expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
      expect(r.stderr).toContain("the journal could not be removed");
      expect(r.stderr).not.toContain("restored");
    });

    for (const configRewritten of [false, true]) {
      test(`${owner}-owner incomplete recovery warns when ${configRewritten ? "config was rewritten" : "config is already original"} and profile unlink fails`, () => {
        const journal = seed(owner, configRewritten ? injected : original, true);
        const r = runScript(testDir, `${deadOwnerScript}
          const fs = require("node:fs");
          const { syncBuiltinESMExports } = require("node:module");
          const profilePath = require("node:path").join(process.env.CODEX_HOME, "opencodex.config.toml");
          const originalUnlink = fs.unlinkSync;
          let denied = 0;
          const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
            if (path === profilePath) {
              denied += 1;
              throw Object.assign(new Error("fixture profile unlink denied"), { code: "EPERM" });
            }
            return originalUnlink(path);
          });
          syncBuiltinESMExports();
          const { reconcileJournal } = require("./src/codex/journal");
          try { console.log(JSON.stringify({ restored: reconcileJournal(), denied, probes })); }
          finally { unlinkSpy.mockRestore(); syncBuiltinESMExports(); killSpy.mockRestore(); }
        `);
        expect(r.status).toBe(0);
        const out = JSON.parse(r.stdout);
        expect(out.denied).toBe(1);
        expect(out.probes).toBe(owner === "process" ? 1 : 0);
        expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
        expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(profile);
        expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
        expect(out.restored).toBe(false);
        expect(r.stderr).toBe(`⚠️ ${incompleteWarning}`);
        expect(r.stderr).not.toContain("restored");
        expect(r.stderr).not.toContain("fixture-client-owner");
        expect(r.stderr).not.toContain(testDir);
      });
    }
  }

  for (const mode of ["already-original", "rewrite-profile", "remove-profile", "unlink-ENOENT", "unlink-EPERM"] as const) {
    test(`restoreJournalState reports actual writes for ${mode}`, () => {
      seed("process", mode === "already-original" ? original : injected, mode !== "already-original");
      if (mode === "rewrite-profile") {
        const journalPath = join(testDir, "opencodex-journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8"));
        journal.originalProfile = Buffer.from("# original profile\n").toString("base64");
        writeFileSync(journalPath, JSON.stringify(journal));
      }
      const r = runScript(testDir, `
        const { spyOn } = require("bun:test");
        const fs = require("node:fs");
        const { syncBuiltinESMExports } = require("node:module");
        const profilePath = require("node:path").join(process.env.CODEX_HOME, "opencodex.config.toml");
        const originalUnlink = fs.unlinkSync;
        let denied = 0;
        const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation((path) => {
          if (path === profilePath && ${mode === "unlink-ENOENT" || mode === "unlink-EPERM"}) {
            denied += 1;
            if (${mode === "unlink-ENOENT"}) originalUnlink(path);
            throw Object.assign(new Error("fixture unlink result"), { code: ${JSON.stringify(mode === "unlink-ENOENT" ? "ENOENT" : "EPERM")} });
          }
          return originalUnlink(path);
        });
        syncBuiltinESMExports();
        const { restoreJournalState } = require("./src/codex/journal");
        try { console.log(JSON.stringify({ result: restoreJournalState(), denied })); }
        finally { unlinkSpy.mockRestore(); syncBuiltinESMExports(); }
      `);
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.result).toMatchObject({
        configRestored: true,
        profileRestored: mode !== "unlink-EPERM",
        configRewritten: mode !== "already-original",
        profileRewritten: mode === "rewrite-profile" || mode === "remove-profile",
        complete: mode !== "unlink-EPERM",
        unverified: false,
      });
      expect(out.result.profileRestoreFailed).toBe(mode === "unlink-EPERM" ? true : undefined);
      expect(out.denied).toBe(mode.startsWith("unlink-") ? 1 : 0);
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
      expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(mode === "unlink-EPERM");
      if (mode === "rewrite-profile") expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe("# original profile\n");
      else expect(existsSync(join(testDir, "opencodex.config.toml"))).toBe(mode === "unlink-EPERM");
    });
  }

  test("profile removal refusal rolls back published config", () => {
    const journal = seed("process", injected, true);
    const result = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { spyOn } = require("bun:test");
      const section = require("./src/codex/inject/config-write-section");
      const { removeCodexConfig } = require("./src/codex/inject/remove");
      let reached = false, publishedFirst = false, refused = false;
      const hook = spyOn(section, "removeCodexProfileEntry").mockImplementation(() => {
        reached = true;
        publishedFirst = !fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8").includes('model_provider = "opencodex"');
        throw new Error("fixture profile removal refused");
      });
      try { removeCodexConfig(); } catch { refused = true; }
      finally { hook.mockRestore(); }
      console.log(JSON.stringify({ reached, publishedFirst, refused }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ reached: true, publishedFirst: true, refused: true });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
    expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(profile);
    expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
  });
  for (const boundary of ["before-removal-read", "before-recovery-capture", "nested-before-removal-read", "nested-before-recovery-capture"] as const) {
    test(`profile removal preserves in-place edits ${boundary}`, () => {
      const journal = seed("process", injected, true);
      const edited = `${injected}# concurrent user edit\n`.replace(/\n/g, "\r\n");
      const result = runScript(testDir, `
        const fs = require("node:fs");
        const path = require("node:path");
        const { spyOn } = require("bun:test");
        const section = require("./src/codex/inject/config-write-section");
        const locks = require("./src/codex/config-write-lock");
        const { removeCodexConfig } = require("./src/codex/inject/remove");
        const configPath = path.join(process.env.CODEX_HOME, "config.toml");
        const edited = ${JSON.stringify(edited)};
        const beforeRead = ${JSON.stringify(boundary)}.endsWith("before-removal-read");
        const owner = beforeRead ? section : locks;
        const method = beforeRead ? "beginCodexWriteSection" : "withConfigWriteRecovery";
        const original = owner[method];
        let peerEdited = false, sameInode = false, publishedFirst = false, refused = false;
        const remove = (held) => {
          const editHook = spyOn(owner, method).mockImplementation((...args) => {
            if (!peerEdited) {
              const inode = fs.statSync(configPath, { bigint: true }).ino;
              fs.writeFileSync(configPath, edited);
              sameInode = fs.statSync(configPath, { bigint: true }).ino === inode;
              peerEdited = true;
            }
            return original(...args);
          });
          const profileHook = spyOn(section, "removeCodexProfileEntry").mockImplementation(() => {
            const published = fs.readFileSync(configPath, "utf8");
            publishedFirst = !published.includes('model_provider = "opencodex"')
              && published.includes("# concurrent user edit");
            throw new Error("fixture profile removal refused");
          });
          try { removeCodexConfig({ heldConfigWriteLock: held }); }
          finally { editHook.mockRestore(); profileHook.mockRestore(); }
        };
        try {
          if (${JSON.stringify(boundary)}.startsWith("nested-")) {
            locks.withConfigWriteLock(configPath, held => locks.withConfigWriteRecovery(configPath, held, () => remove(held)));
          } else remove();
        } catch { refused = true; }
        console.log(JSON.stringify({ peerEdited, sameInode, publishedFirst, refused }));
      `);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        peerEdited: true, sameInode: true, publishedFirst: boundary === "before-removal-read", refused: true,
      });
      expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(edited);
      expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(profile);
      expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
    });
  }
  test("nested removal retains the outer preimage after an owned publication", () => {
    const journal = seed("process", injected, true);
    const result = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { spyOn } = require("bun:test");
      const { atomicWriteFile } = require("./src/config");
      const section = require("./src/codex/inject/config-write-section");
      const locks = require("./src/codex/config-write-lock");
      const { removeCodexConfig } = require("./src/codex/inject/remove");
      const configPath = path.join(process.env.CODEX_HOME, "config.toml");
      let publishedFirst = false, refused = false;
      const hook = spyOn(section, "removeCodexProfileEntry").mockImplementation(() => {
        const published = fs.readFileSync(configPath, "utf8");
        publishedFirst = !published.includes('model_provider = "opencodex"') && published.includes("# owned edit");
        throw new Error("fixture profile removal refused");
      });
      try {
        locks.withConfigWriteLock(configPath, held => locks.withConfigWriteRecovery(configPath, held, () => {
          locks.publishConfigWrite(configPath, held, (target, hooks) =>
            atomicWriteFile(target, ${JSON.stringify(injected)} + "# owned edit\\n", undefined, hooks));
          removeCodexConfig({ heldConfigWriteLock: held });
        }));
      } catch { refused = true; }
      finally { hook.mockRestore(); }
      console.log(JSON.stringify({ publishedFirst, refused }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ publishedFirst: true, refused: true });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
    expect(readFileSync(join(testDir, "opencodex.config.toml"), "utf8")).toBe(profile);
    expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
  });
  test("dangling generated-profile metadata refuses the complete pair", () => {
    const journal = seed("process", injected, true);
    const result = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { spyOn } = require("bun:test");
      const profilePath = path.join(process.env.CODEX_HOME, "opencodex.config.toml");
      fs.unlinkSync(profilePath);
      const lstat = fs.lstatSync;
      const hook = spyOn(fs, "lstatSync").mockImplementation((target, ...args) =>
        path.basename(String(target)) === "opencodex.config.toml"
          ? { isSymbolicLink: () => true }
          : lstat(target, ...args));
      let out;
      try { out = require("./src/codex/journal").restoreJournalState(); }
      finally { hook.mockRestore(); }
      console.log(JSON.stringify(out));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, profileRestoreFailed: true, configRewritten: false, profileRewritten: false });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
    expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
  });
  test("generated profile disappearance at type observation is treated as absence", () => {
    seed("process", injected, true);
    const result = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const { spyOn } = require("bun:test");
      const profilePath = path.join(process.env.CODEX_HOME, "opencodex.config.toml");
      const lstat = fs.lstatSync;
      let vanished = false;
      const hook = spyOn(fs, "lstatSync").mockImplementation((target, ...args) => {
        if (!vanished && path.basename(String(target)) === "opencodex.config.toml") {
          vanished = true;
          fs.unlinkSync(profilePath);
          throw Object.assign(new Error("fixture missing profile"), { code: "ENOENT" });
        }
        return lstat(target, ...args);
      });
      let out;
      try { out = require("./src/codex/journal").restoreJournalState(); }
      finally { hook.mockRestore(); }
      console.log(JSON.stringify({ vanished, out }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ vanished: true, out: { complete: true, profileRestored: true } });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(testDir, "opencodex.config.toml"))).toBe(false);
    expect(existsSync(join(testDir, "opencodex-journal.json"))).toBe(false);
  });
  test.skipIf(process.platform === "win32")("a real dangling generated-profile symlink preserves recovery evidence", () => {
    const journal = seed("process", injected, true);
    const result = runScript(testDir, `
      const fs = require("node:fs");
      const path = require("node:path");
      const profilePath = path.join(process.env.CODEX_HOME, "opencodex.config.toml");
      fs.unlinkSync(profilePath);
      fs.symlinkSync(path.join(process.env.CODEX_HOME, "missing-profile-target.toml"), profilePath);
      const out = require("./src/codex/journal").restoreJournalState();
      console.log(JSON.stringify({ out, link: fs.lstatSync(profilePath).isSymbolicLink() }));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ link: true, out: { complete: false, profileRestoreFailed: true } });
    expect(readFileSync(join(testDir, "config.toml"), "utf8")).toBe(injected);
    expect(readFileSync(join(testDir, "opencodex-journal.json"), "utf8")).toBe(journal);
  });
});
