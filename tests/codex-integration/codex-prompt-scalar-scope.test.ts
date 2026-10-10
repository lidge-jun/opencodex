import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importBaseVariant, previewBaseImport, readPromptLayers, setToggle } from "../../src/codex/prompt-layers";
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
