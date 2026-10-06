import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

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
});
