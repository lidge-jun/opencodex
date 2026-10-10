import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBaseVariant, previewBaseImport, readPromptLayers, recoverPromptJournal, setToggle, writeCustomLayers } from "../../src/codex/prompt-layers";
import { journalPathFor } from "../../src/codex/prompt-layers/paths";
import { encodeJournal, hashBytes } from "../../src/codex/prompt-journal";
import * as atomic from "../../src/lib/windows-atomic-replace";
import { rootKeyValueForm, setRootBool, setRootString, setTableBool, UnsupportedTomlForm } from "../../src/codex/prompt-layers/toml-edit";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => { while (roots.length) removeTreeWithRetry(roots.pop()!); });

function fixture(config: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-scope-"));
  roots.push(root);
  const paths = { configPath: join(root, "config.toml"), storePath: join(root, "store.json"), baseVariantDir: join(root, "base") };
  writeFileSync(paths.configPath, config);
  return paths;
}

for (const quote of ['"""', "'''"]) {
  test(`scalar edits skip assignment-shaped prose inside ${quote} and edit only the real key`, () => {
    const config = `developer_instructions = ${quote}\n"model_instructions_file" = "example"\n"include_apps_instructions" = false\n[skills]\n"include_instructions" = false\n${quote}\nmodel_instructions_file = "source.md"\ninclude_apps_instructions = true\n[skills]\ninclude_instructions = true\n`;
    const before = Bun.TOML.parse(config) as Record<string, unknown>;
    expect(rootKeyValueForm(config, "model_instructions_file")).toBe("simple");
    const pathEdit = Bun.TOML.parse(setRootString(config, "model_instructions_file", "managed.md"));
    expect(pathEdit).toEqual({ ...before, model_instructions_file: "managed.md" });
    const { include_apps_instructions: _removed, ...withoutApps } = before;
    expect(Bun.TOML.parse(setRootBool(config, "include_apps_instructions", null))).toEqual(withoutApps);
    expect(Bun.TOML.parse(setTableBool(config, "skills", "include_instructions", false)))
      .toEqual({ ...before, skills: { include_instructions: false } });
  });
}

test("import retargets the real key and leaves assignment-shaped multiline prose untouched", () => {
  const config = 'developer_instructions = """\n"model_instructions_file" = "example"\n"""\nmodel_instructions_file = "source.md"\n';
  const paths = fixture(config);
  writeFileSync(join(roots.at(-1)!, "source.md"), "External body.");
  const preview = previewBaseImport(paths);
  expect(preview.previewSha256).toBeTruthy();
  expect(importBaseVariant({ previewSha256: preview.previewSha256! }, readPromptLayers(paths).revision, paths))
    .toMatchObject({ ok: true });
  const after = Bun.TOML.parse(readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
  expect(after.developer_instructions).toBe('"model_instructions_file" = "example"\n');
  expect(after.model_instructions_file).not.toBe("source.md");
  expect(existsSync(paths.baseVariantDir)).toBe(true);
});

test("table-shaped prose inside a multi-line array does not end the root scope", () => {
  const config = 'examples = [\n  "[skills]",\n]\nmodel = "x"\n';
  const after = setRootBool(config, "include_apps_instructions", false);
  expect(Bun.TOML.parse(after)).toEqual({ ...Bun.TOML.parse(config), include_apps_instructions: false });
  expect(after.indexOf("include_apps_instructions")).toBeGreaterThan(after.indexOf("]\n"));
});

test("an unterminated span refuses every scalar edit before any write", () => {
  for (const config of ['developer_instructions = """\nnever closed\nmodel_instructions_file = "a.md"\n', 'args = [\n  "x",\nmodel = "y"\n']) {
    expect(rootKeyValueForm(config, "model_instructions_file")).toBe("unsupported");
    expect(() => setRootString(config, "model_instructions_file", "b.md")).toThrow(UnsupportedTomlForm);
    expect(() => setRootBool(config, "include_apps_instructions", false)).toThrow(UnsupportedTomlForm);
    expect(() => setTableBool(config, "skills", "include_instructions", false)).toThrow(UnsupportedTomlForm);
  }
});

test("single-line quoted delimiters and comments do not prevent a genuine root edit", () => {
  const config = 'notes = "\\\"\\\"\\\" [skills] # prose" # """\nmodel_instructions_file = "old.md"\n';
  const after = setRootString(config, "model_instructions_file", "new.md");
  expect(Bun.TOML.parse(after)).toEqual({ ...Bun.TOML.parse(config), model_instructions_file: "new.md" });
});

for (const [rootKey, tableKey] of [
  ['"include_apps_instructions"', '"include_instructions"'],
  ["'include_apps_instructions'", "'include_instructions'"],
  ['"include_\\u0061pps_instructions"', '"include_\\u0069nstructions"'],
]) {
  test(`quoted toggle snapshots and successful write responses agree for ${rootKey}`, () => {
    const paths = fixture(`${rootKey} = true # root\n[skills]\n${tableKey} = true # table\n`);
    for (const id of ["apps", "skills"]) {
      const result = setToggle(id, false, readPromptLayers(paths).revision, paths);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.snapshot.toggles.find(t => t.id === id)).toMatchObject({ userFileValue: false, defaultedUserValue: false });
      const reset = setToggle(id, null, result.snapshot.revision, paths);
      expect(reset.ok).toBe(true);
      if (!reset.ok) throw new Error(reset.error);
      expect(reset.snapshot.toggles.find(t => t.id === id)).toMatchObject({ userFileValue: null, defaultedUserValue: true });
    }
  });
}
test("toggle snapshots ignore assignment-shaped prose inside a multiline value", () => {
  const prose = 'developer_instructions = """\n"include_apps_instructions" = false\n[skills]\n"include_instructions" = false\n"""\n';
  const paths = fixture(`${prose}include_apps_instructions = true\n[skills]\ninclude_instructions = true\n`);
  const before = readPromptLayers(paths);
  for (const id of ["apps", "skills"]) expect(before.toggles.find(t => t.id === id)).toMatchObject({ userFileValue: true });
  let revision = before.revision;
  for (const id of ["apps", "skills"]) {
    const result = setToggle(id, false, revision, paths);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.toggles.find(t => t.id === id)).toMatchObject({ userFileValue: false, defaultedUserValue: false });
    revision = result.snapshot.revision;
  }
  const parsed = Bun.TOML.parse(readFileSync(paths.configPath, "utf8")) as Record<string, unknown>;
  expect(parsed).toMatchObject({ include_apps_instructions: false, skills: { include_instructions: false } });
  expect(parsed.developer_instructions).toBe('"include_apps_instructions" = false\n[skills]\n"include_instructions" = false\n');
});
for (const quote of ['"""', "'''"]) {
  test(`the parser fallback ignores a model_instructions_file named inside ${quote} prose`, () => {
    // Bun refuses this i64 although Codex accepts it, which forces the line-scan fallback.
    const config = `model_context_window = 9223372036854775807\ndeveloper_instructions = ${quote}\nmodel_instructions_file = "fake.md"\n${quote}\nmodel_instructions_file = "real.md"\n`;
    const paths = fixture(config);
    writeFileSync(join(roots.at(-1)!, "real.md"), "Real body.");
    writeFileSync(join(roots.at(-1)!, "fake.md"), "Fake body.");
    expect(() => Bun.TOML.parse(config)).toThrow();
    expect(readPromptLayers(paths).modelInstructionsFile).toBe("real.md");
  });
}
test("the parser fallback reads a CRLF model_instructions_file line with a trailing comment", () => {
  const config = 'model_context_window = 9223372036854775807\r\nmodel_instructions_file = "real.md" # note\r\n';
  const paths = fixture(config);
  writeFileSync(join(roots.at(-1)!, "real.md"), "Real body.");
  expect(readPromptLayers(paths).modelInstructionsFile).toBe("real.md");
});


// Debate round 2 regressions (PRO-1, CON-2, CON-1).
test("a toggle under a quoted table header with decoy prose refuses instead of writing invalid TOML", () => {
  const config = '["skills"]\npreserve = """\n[skills]\n"include_instructions" = false\n"""\n[unrelated]\nkeep = true\n';
  const paths = fixture(config);
  for (const enabled of [false, true]) {
    const result = setToggle("skills", enabled, readPromptLayers(paths).revision, paths);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBe("unsupported_form");
    expect(readFileSync(paths.configPath, "utf8")).toBe(config);
  }
});

for (const [form, config] of [
  ["quoted", '["skills"]\ninclude_instructions = false # keep\n'],
  ["spaced", "[ skills ]\ninclude_instructions = false\n"],
  ["dotted", "skills.include_instructions = false\n"],
  ["inline", "skills = { include_instructions = false }\n"],
] as const) {
  test("restore-default refuses a " + form + " table it cannot address and leaves the override untouched", () => {
    const paths = fixture(config);
    const result = setToggle("skills", null, readPromptLayers(paths).revision, paths);
    expect(result.ok ? "ok" : result.error).toBe("unsupported_form");
    expect(readFileSync(paths.configPath, "utf8")).toBe(config);
  });
}

for (const entry of ["recovery", "ordinary-write"] as const) {
  test(entry + ": an in-place edit during a Windows sharing retry is never overwritten", () => {
    const paths = fixture('model = "attempt"\n');
    const draft = { id: "draft1", title: "Unsaved ideas", body: "precious disabled draft", enabled: false };
    const oldLayers = [draft, { id: "active", title: "Custom", body: "old custom", enabled: true }];
    const newLayers = [draft, { id: "active", title: "Custom", body: "new custom", enabled: true }];
    const preConfig = 'model = "original"\n', postConfig = 'model = "attempt"\n';
    const preStore = JSON.stringify({ version: 1, layers: oldLayers }), postStore = JSON.stringify({ version: 1, layers: newLayers });
    writeFileSync(paths.storePath, preStore);
    const journal = journalPathFor(paths.storePath);
    writeFileSync(journal, encodeJournal({ configPath: paths.configPath, storePath: paths.storePath, preConfig: hashBytes(preConfig), postConfig: hashBytes(postConfig), preStore: hashBytes(preStore), postStore: hashBytes(postStore), preConfigBytes: preConfig, postConfigBytes: postConfig, preStoreBytes: preStore, postStoreBytes: postStore }));
    const newer = 'model = "newer user data"\n';
    const original = atomic.renameAtomicFile;
    let attempts = 0, intercepted = false;
    const hook = spyOn(atomic, "renameAtomicFile").mockImplementation((source, destination, io, publisher, hooks) => {
      if (destination !== realpathSync(paths.configPath) || intercepted) return original(source, destination, io, publisher, hooks);
      intercepted = true;
      return original(source, destination, {
        platform: "win32",
        rename: (a: string, b: string) => { attempts += 1; if (attempts === 1) throw Object.assign(new Error("simulated sharing violation"), { code: "EBUSY" }); renameSync(a, b); },
        sleep: () => writeFileSync(paths.configPath, newer),
      } as never, publisher, hooks);
    });
    let result;
    try {
      result = entry === "recovery" ? recoverPromptJournal(paths) : setToggle("apps", false, readPromptLayers(paths).revision, paths);
    } finally { hook.mockRestore(); }
    expect(intercepted).toBe(true);
    expect(result.ok ? "ok" : result.error).toBe("recovery_required");
    expect(readFileSync(paths.configPath, "utf8")).toBe(newer);
    expect(existsSync(journal)).toBe(true);
  });
}



for (const phase of ["fresh commit", "rollback"] as const) {
  test(phase + ": config retry refuses newer in-place peer bytes and keeps the journal", () => {
    const paths = fixture('model = "original"\n');
    const preStore = JSON.stringify({ version: 1, layers: [] });
    writeFileSync(paths.storePath, preStore);
    const journal = journalPathFor(paths.storePath);
    expect(existsSync(journal)).toBe(false);
    const revision = readPromptLayers(paths).revision;
    const newer = 'model = "peer edit during retry"\n';
    const rename = atomic.renameAtomicFile;
    let configPublishes = 0, attempts = 0, peerEdits = 0, storeFailed = false;
    let preparedJournal = "";
    const hook = spyOn(atomic, "renameAtomicFile").mockImplementation((source, destination, io, publisher, hooks) => {
      if (destination === realpathSync(paths.storePath) && phase === "rollback") {
        // Config has landed; fail the second target to enter transaction rollback.
        storeFailed = true;
        throw Object.assign(new Error("fixture store write failed"), { code: "EIO" });
      }
      if (destination !== realpathSync(paths.configPath)) return rename(source, destination, io, publisher, hooks);
      configPublishes += 1;
      if (configPublishes !== (phase === "fresh commit" ? 1 : 2)) return rename(source, destination, io, publisher, hooks);
      return rename(source, destination, {
        platform: "win32",
        rename: (a, b) => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error("fixture sharing violation"), { code: "EBUSY" });
          renameSync(a, b);
        },
        sleep: () => {
          preparedJournal = readFileSync(journal, "utf8");
          const inode = statSync(paths.configPath).ino;
          writeFileSync(paths.configPath, newer);
          expect(statSync(paths.configPath).ino).toBe(inode);
          peerEdits += 1;
        },
      }, publisher, hooks);
    });
    let result;
    try {
      result = writeCustomLayers([{ id: "active", title: "Custom", body: "new projection", enabled: true }], revision, paths);
    } finally { hook.mockRestore(); }
    expect(peerEdits).toBe(1);
    expect(storeFailed).toBe(phase === "rollback");
    expect(configPublishes).toBe(phase === "fresh commit" ? 1 : 2);
    expect(readFileSync(paths.configPath, "utf8")).toBe(newer);
    expect(existsSync(journal)).toBe(true);
    expect(readFileSync(journal, "utf8")).toBe(preparedJournal);
    expect(result).toMatchObject({ ok: false, error: "recovery_required" });
    expect(readFileSync(paths.storePath, "utf8")).toBe(preStore);
    expect(attempts).toBe(1); // Revalidation refuses before the second rename.
  });
}

// Debate round 2 reviewer findings: Bun-unparseable input and TOML date/time values.
const I64 = "model_context_window = 9223372036854775807\n";
test("Bun-unparseable input refuses an unverifiable append or restore instead of trusting the line editor", () => {
  const decoy = I64 + '["skills"]\npreserve = """\n[skills]\n"include_instructions" = false\n"""\n';
  expect(() => Bun.TOML.parse(decoy)).toThrow();
  expect(() => setTableBool(decoy, "skills", "include_instructions", true)).toThrow(UnsupportedTomlForm);
  for (const config of [I64 + '["skills"]\ninclude_instructions = false\n', I64 + "skills.include_instructions = false\n", I64 + "skills = { include_instructions = false }\n"]) {
    expect(() => setTableBool(config, "skills", "include_instructions", null)).toThrow(UnsupportedTomlForm);
    const paths = fixture(config);
    const result = setToggle("skills", null, readPromptLayers(paths).revision, paths);
    expect(result.ok ? "ok" : result.error).toBe("unsupported_form");
    expect(readFileSync(paths.configPath, "utf8")).toBe(config);
  }
  // An in-place replacement of a key the editor located is still allowed.
  expect(setTableBool(I64 + "[skills]\ninclude_instructions = true\n", "skills", "include_instructions", false)).toBe(I64 + "[skills]\ninclude_instructions = false\n");
});

for (const [kind, literal] of [["offset date-time", "1979-05-27T07:32:00Z"], ["local date-time", "1979-05-27T07:32:00"], ["local date", "1979-05-27"], ["local time", "07:32:00"]] as const) {
  test("an unrelated " + kind + " value does not block a verified edit", () => {
    const config = "stamp = " + literal + "\n[skills]\ninclude_instructions = true\n";
    expect(Bun.TOML.parse(setTableBool(config, "skills", "include_instructions", false)) as Record<string, any>).toHaveProperty("skills.include_instructions", false);
    expect((Bun.TOML.parse(setRootBool(config, "hide_agent_reasoning", true)) as Record<string, any>).hide_agent_reasoning).toBe(true);
    expect((Bun.TOML.parse(setRootString(config, "model_instructions_file", "/managed/copy.md")) as Record<string, any>).model_instructions_file).toBe("/managed/copy.md");
  });
}
