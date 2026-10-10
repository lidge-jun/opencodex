/**
 * Base-prompt variants: selection, immutability of the default, and write ordering.
 *
 * Explicit temp paths only - these functions write a real Codex config.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  MAX_BASE_VARIANTS,
  computePromptProbeStateFingerprint,
  importBaseVariant,
  previewBaseImport,
  readBaseVariants,
  readPromptLayers,
  selectBaseVariant,
  writeBaseVariant,
} from "../../src/codex/prompt-layers";
import { journalPathFor } from "../../src/codex/prompt-layers/paths";
import * as fsModule from "node:fs";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];

function fixture(config?: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-base-variant-"));
  roots.push(root);
  const paths = {
    configPath: join(root, "config.toml"),
    storePath: join(root, "opencodex-prompt.json"),
    baseVariantDir: join(root, "opencodex-prompt-base"),
  };
  if (config !== undefined) writeFileSync(paths.configPath, config, "utf8");
  return paths;
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function rev(paths: ReturnType<typeof fixture>): string {
  return readPromptLayers(paths).revision;
}

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("base variant selection", () => {
  test("a fresh install reports the default, with no variants", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    // The default is the ABSENCE of the key, so there is nothing stored for it.
    expect(snap.baseSelection).toEqual({ kind: "default" });
    expect(snap.baseVariants).toEqual([]);
  });

  test("a hand-set key reads as external, NOT as default", () => {
    // The blocker the plan audit found. Reporting this as "default" would tell the
    // user Codex is using its own base prompt while it is in fact replaced.
    const paths = fixture("model_instructions_file = \"/etc/somebody-elses.md\"\n");
    expect(readPromptLayers(paths).baseSelection).toEqual({
      kind: "external",
      path: "/etc/somebody-elses.md",
    });
  });

  test("a hand-set key with standard TOML escapes stays external and cannot be overwritten", () => {
    const config = 'model_instructions_file = "\\u002Fetc\\u002Fsomebody-elses.md"\n';
    const paths = fixture(config);
    expect(readPromptLayers(paths).baseSelection).toEqual({
      kind: "external",
      path: "/etc/somebody-elses.md",
    });

    const result = selectBaseVariant({ kind: "default" }, rev(paths), paths);
    expect(result).toMatchObject({ ok: false, error: "developer_instructions_not_owned" });
    expect(read(paths.configPath)).toBe(config);
  });

  test("unsafe integer fallback follows a Unicode-escaped base file in selection and fingerprint", () => {
    const paths = fixture('model_context_window = 9223372036854775807\nmodel_instructions_file = "\\u0062ase.md"\n');
    const basePath = join(dirname(paths.configPath), "base.md");
    writeFileSync(basePath, "first base", "utf8");
    const previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(paths.configPath);
    try {
      const snap = readPromptLayers(paths);
      expect(snap.modelInstructionsFile).toBe("base.md");
      expect(snap.baseSelection).toEqual({ kind: "external", path: "base.md" });
      const before = computePromptProbeStateFingerprint(paths);
      writeFileSync(basePath, "second base", "utf8");
      expect(computePromptProbeStateFingerprint(paths)).not.toBe(before);
    } finally {
      if (previousHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousHome;
    }
  });

  test("selecting a variant writes an absolute path, and the default removes the key", () => {
    const paths = fixture("model = \"x\"\n");
    const created = writeBaseVariant({ id: null, title: "Terse", body: "Be brief." }, rev(paths), paths);
    expect(created.ok).toBe(true);
    const id = readBaseVariants(paths)[0]!.id;

    expect(selectBaseVariant({ kind: "variant", id }, rev(paths), paths).ok).toBe(true);
    const withVariant = read(paths.configPath)!;
    const selectedPath = resolve(join(paths.baseVariantDir, id + ".md"));
    // The file is TOML, so Windows backslashes appear in an encoded basic-string
    // literal rather than as the raw filesystem path.
    expect(withVariant).toContain(`model_instructions_file = ${JSON.stringify(selectedPath)}`);
    // Assert the decoded behavior separately from its on-disk representation.
    expect(readPromptLayers(paths).baseSelection).toEqual({ kind: "variant", id });

    expect(selectBaseVariant({ kind: "default" }, rev(paths), paths).ok).toBe(true);
    // Removed, not emptied: model_instructions_file = "" is a path Codex would try
    // to read, which is not the same as an absent setting.
    expect(read(paths.configPath)!).not.toContain("model_instructions_file");
    expect(readPromptLayers(paths).baseSelection).toEqual({ kind: "default" });
    // The user's own key survived the round trip.
    expect(read(paths.configPath)!).toContain("model = \"x\"");
  });

  test("the default has no stored body to edit or delete", () => {
    const paths = fixture("model = \"x\"\n");
    // Structural, not guarded: `default` is not a variant id, so both verbs reject it
    // by the same rule that rejects any unknown id.
    expect(writeBaseVariant({ id: "default", title: "x", body: "y" }, rev(paths), paths)).toMatchObject({
      ok: false, error: "unknown_layer",
    });
    expect(writeBaseVariant({ id: "default", delete: true }, rev(paths), paths)).toMatchObject({
      ok: false, error: "unknown_layer",
    });
    expect(read(paths.configPath)).toBe("model = \"x\"\n");
  });

  test("a default.md on disk is ignored rather than shown as a fourth variant", () => {
    const paths = fixture("model = \"x\"\n");
    mkdirSync(paths.baseVariantDir, { recursive: true });
    writeFileSync(join(paths.baseVariantDir, "default.md"), "# Hand written\nbody", "utf8");
    // Its selection could never be expressed, so listing it would offer the user a
    // row they cannot pick.
    expect(readBaseVariants(paths)).toEqual([]);
  });

  test("the external state refuses a silent retarget", () => {
    const paths = fixture("model_instructions_file = \"/etc/somebody-elses.md\"\n");
    const before = read(paths.configPath);
    const created = writeBaseVariant({ id: null, title: "Mine", body: "Be brief." }, rev(paths), paths);
    expect(created.ok).toBe(true);
    const id = readBaseVariants(paths)[0]!.id;

    const result = selectBaseVariant({ kind: "variant", id }, rev(paths), paths);
    expect(result).toMatchObject({ ok: false, error: "developer_instructions_not_owned" });
    expect(read(paths.configPath)).toBe(before);
  });

  test("selecting an unknown variant is refused and writes nothing", () => {
    const paths = fixture("model = \"x\"\n");
    const before = read(paths.configPath);
    expect(selectBaseVariant({ kind: "variant", id: "abc123" }, rev(paths), paths)).toMatchObject({
      ok: false, error: "unknown_layer",
    });
    expect(read(paths.configPath)).toBe(before);
  });

  test("deleting the live variant clears the key in the same transaction", () => {
    const paths = fixture("model = \"x\"\n");
    writeBaseVariant({ id: null, title: "Terse", body: "Be brief." }, rev(paths), paths);
    const id = readBaseVariants(paths)[0]!.id;
    selectBaseVariant({ kind: "variant", id }, rev(paths), paths);
    expect(read(paths.configPath)!).toContain("model_instructions_file");

    expect(writeBaseVariant({ id, delete: true }, rev(paths), paths).ok).toBe(true);
    // Config must never outlive the file it names.
    expect(read(paths.configPath)!).not.toContain("model_instructions_file");
    expect(existsSync(join(paths.baseVariantDir, id + ".md"))).toBe(false);
    expect(readPromptLayers(paths).baseSelection).toEqual({ kind: "default" });
  });

  test("deleting an unselected variant leaves the live selection alone", () => {
    const paths = fixture("model = \"x\"\n");
    writeBaseVariant({ id: null, title: "One", body: "a" }, rev(paths), paths);
    writeBaseVariant({ id: null, title: "Two", body: "b" }, rev(paths), paths);
    const [first, second] = readBaseVariants(paths);
    selectBaseVariant({ kind: "variant", id: first!.id }, rev(paths), paths);

    expect(writeBaseVariant({ id: second!.id, delete: true }, rev(paths), paths).ok).toBe(true);
    expect(readPromptLayers(paths).baseSelection).toEqual({ kind: "variant", id: first!.id });
  });

  test("a title is stored with the body, and round-trips", () => {
    const paths = fixture("model = \"x\"\n");
    writeBaseVariant({ id: null, title: "House rules", body: "Answer in Korean." }, rev(paths), paths);
    const [variant] = readBaseVariants(paths);
    expect(variant!.title).toBe("House rules");
    expect(variant!.body.trim()).toBe("Answer in Korean.");
    expect(variant!.bytes).toBeGreaterThan(0);
  });

  test("a newline in the title cannot forge a second heading", () => {
    const paths = fixture("model = \"x\"\n");
    writeBaseVariant({ id: null, title: "Evil\n# Injected", body: "body" }, rev(paths), paths);
    const [variant] = readBaseVariants(paths);
    expect(variant!.title).toBe("Evil # Injected");
    expect(variant!.body.trim()).toBe("body");
  });

  test("the variant cap applies to new variants, not to edits", () => {
    const paths = fixture("model = \"x\"\n");
    for (let i = 0; i < MAX_BASE_VARIANTS; i += 1) {
      expect(writeBaseVariant({ id: null, title: "v" + i, body: "b" }, rev(paths), paths).ok).toBe(true);
    }
    expect(writeBaseVariant({ id: null, title: "one too many", body: "b" }, rev(paths), paths).ok).toBe(false);
    // Editing an existing one is still allowed at the cap.
    const id = readBaseVariants(paths)[0]!.id;
    expect(writeBaseVariant({ id, title: "edited", body: "b2" }, rev(paths), paths).ok).toBe(true);
  });

  test("a caller-supplied id cannot create a variant", () => {
    const paths = fixture("model = \"x\"\n");
    expect(writeBaseVariant({ id: "aaaaaa", title: "Injected", body: "b" }, rev(paths), paths)).toMatchObject({
      ok: false,
      error: "unknown_layer",
    });
    expect(readBaseVariants(paths)).toEqual([]);
  });

  test("a stale revision is refused", () => {
    const paths = fixture("model = \"x\"\n");
    const stale = rev(paths);
    writeBaseVariant({ id: null, title: "One", body: "a" }, stale, paths);
    const id = readBaseVariants(paths)[0]!.id;
    // Writing a variant BODY does not move the revision, and that is deliberate: the
    // revision covers config.toml and the layer store, and a variant file is neither.
    // So the same revision is still valid here.
    expect(selectBaseVariant({ kind: "variant", id }, stale, paths).ok).toBe(true);

    // Selecting DOES move it, because it writes config.toml. Reusing the now-stale
    // revision must be refused - that is the concurrent-editor guard.
    expect(selectBaseVariant({ kind: "default" }, stale, paths)).toMatchObject({
      ok: false, error: "stale_revision",
    });
    expect(readPromptLayers(paths).baseSelection).toEqual({ kind: "variant", id });
  });

  test("a write_superseded race preserves the imported file AND the journal", () => {
    // The failure path the review caught: importBaseVariant used to delete the
    // variant file on every unsuccessful result — including write_superseded,
    // which can return AFTER the post-write config was applied, leaving a live
    // `model_instructions_file` pointing at a file that no longer exists.
    const root = mkdtempSync(join(tmpdir(), "ocx-base-race-"));
    roots.push(root);
    const externalPath = join(root, "raced.md");
    writeFileSync(externalPath, "Raced body.", "utf8");
    const paths = fixture(`model_instructions_file = ${JSON.stringify(externalPath)}\n`);
    // Exercise canonical publication even on hosts without Windows short paths.
    paths.configPath = `${dirname(paths.configPath)}/./config.toml`;

    const preview = previewBaseImport(paths);
    expect(preview.serialized).toBe("# raced\nRaced body.");

    // Inject the race deterministically: another writer appends to config.toml
    // in the gap between the config rename landing and the transaction's final
    // verify — the exact window the write_superseded path exists for. Spying at
    // node:fs reaches the writes regardless of how the caller bound the import.
    // The writer resolves aliases, including Windows TEMP's short path spelling.
    const configTarget = fsModule.realpathSync.native(paths.configPath);
    const realRename = fsModule.renameSync;
    const renameSpy = spyOn(fsModule, "renameSync").mockImplementation((from: unknown, to: unknown) => {
      realRename(from as Parameters<typeof fsModule.renameSync>[0], to as Parameters<typeof fsModule.renameSync>[1]);
      if (fsModule.realpathSync.native(String(to)) === configTarget) {
        writeFileSync(paths.configPath, `${read(paths.configPath)}# raced\n`, "utf8");
      }
    });
    let result;
    try {
      result = importBaseVariant(
        { previewSha256: preview.previewSha256! },
        readPromptLayers(paths).revision,
        paths,
      );
    } finally {
      renameSpy.mockRestore();
    }
    // The injected append is the proof the race was exercised at all.
    expect(read(paths.configPath)!).toContain("# raced");
    expect(result).toMatchObject({ ok: false, error: "write_superseded" });

    // The just-written variant file SURVIVES: the config on disk may already
    // point at it, and deletion would strand the live selection.
    const names = existsSync(paths.baseVariantDir) ? readdirSync(paths.baseVariantDir) : [];
    expect(names).toHaveLength(1);
    expect(readFileSync(join(paths.baseVariantDir, names[0]!), "utf8")).toBe(preview.serialized);
    // The journal is left for commit()'s recovery path, not swept away.
    expect(existsSync(journalPathFor(paths.storePath))).toBe(true);
    // And the config on disk still names the file — deleting it would have
    // produced exactly the dangling pointer this guard exists to prevent.
    expect(read(paths.configPath)!).toContain(names[0]!);
  });

  test("a write_superseded on an UNREFERENCED result still cleans up", () => {
    // The other half of the contract: a refusal that provably left nothing
    // behind removes the file. Stale revision never reaches the config write,
    // so the variant file is deleted as before.
    const root = mkdtempSync(join(tmpdir(), "ocx-base-race-"));
    roots.push(root);
    const externalPath = join(root, "stale.md");
    writeFileSync(externalPath, "Stale body.", "utf8");
    const paths = fixture(`model_instructions_file = ${JSON.stringify(externalPath)}\n`);
    const preview = previewBaseImport(paths);
    const result = importBaseVariant(
      { previewSha256: preview.previewSha256! },
      "sha256:stale",
      paths,
    );
    expect(result).toMatchObject({ ok: false, error: "stale_revision" });
    expect(existsSync(paths.baseVariantDir) ? readdirSync(paths.baseVariantDir) : []).toHaveLength(0);
  });

  test("a BOM-prefixed config survives a variant selection", () => {
    // The same class the projection writer had: the key insert must not step over
    // a byte that is only legal at position 0.
    const paths = fixture("\ufeffmodel = \"x\"\n");
    writeBaseVariant({ id: null, title: "One", body: "a" }, rev(paths), paths);
    const id = readBaseVariants(paths)[0]!.id;
    expect(selectBaseVariant({ kind: "variant", id }, rev(paths), paths).ok).toBe(true);
    const after = read(paths.configPath)!;
    expect(after.indexOf("\ufeff")).toBe(0);
    expect(after.split("\ufeff").length - 1).toBe(1);
    expect(() => Bun.TOML.parse(after)).not.toThrow();
  });
});

test("an uncertain import preserves a config-relative live reference", () => {
  const paths = fixture();
  paths.configPath = `${dirname(paths.configPath)}/./config.toml`;
  const external = join(dirname(paths.configPath), "external.md");
  writeFileSync(external, "External body.");
  writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const preview = previewBaseImport(paths);
  const revision = rev(paths);
  const configTarget = fsModule.realpathSync.native(paths.configPath);
  const realRename = fsModule.renameSync;
  const renameSpy = spyOn(fsModule, "renameSync").mockImplementation((from, to) => {
    realRename(from, to);
    if (fsModule.realpathSync.native(String(to)) === configTarget) {
      const selected = String(Bun.TOML.parse(read(paths.configPath)!).model_instructions_file);
      const local = relative(dirname(paths.configPath), selected).replace(/\\/g, "/");
      writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(local)}\n# concurrent edit\n`);
    }
  });
  let result;
  try {
    result = importBaseVariant({ previewSha256: preview.previewSha256! }, revision, paths);
  } finally { renameSpy.mockRestore(); }
  expect(read(paths.configPath)!).toContain("# concurrent edit");
  expect(result).toMatchObject({ ok: false, error: "write_superseded" });
  const selected = String(Bun.TOML.parse(read(paths.configPath)!).model_instructions_file);
  expect(existsSync(resolve(dirname(paths.configPath), selected))).toBe(true);
  expect(existsSync(journalPathFor(paths.storePath))).toBe(true);
});

test("base import refuses a source before an unbounded read", () => {
  const paths = fixture();
  const external = join(dirname(paths.configPath), "large.md");
  writeFileSync(external, "x".repeat(512 * 1024));
  writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const realRead = fsModule.readFileSync;
  let unbounded = false;
  const readSpy = spyOn(fsModule, "readFileSync").mockImplementation((path, ...args) => {
    if (String(path) === external) unbounded = true;
    return Reflect.apply(realRead, fsModule, [path, ...args]);
  });
  try {
    const preview = previewBaseImport(paths);
    expect(unbounded).toBe(false);
    expect(preview.reason).toBe("body_too_large");
    expect(preview.serialized).toBeNull();
  } finally { readSpy.mockRestore(); }
});

test("recovery_required preserves a config-relative reference to the new file", () => {
  const paths = fixture();
  const external = join(dirname(paths.configPath), "external.md");
  writeFileSync(external, "External body.");
  writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const preview = previewBaseImport(paths);
  const revision = rev(paths);
  writeFileSync(journalPathFor(paths.storePath), "invalid journal");
  const realRename = fsModule.renameSync;
  const renameSpy = spyOn(fsModule, "renameSync").mockImplementation((from, to) => {
    realRename(from, to);
    if (String(to).endsWith(".md")) {
      const local = relative(dirname(paths.configPath), String(to)).replace(/\\/g, "/");
      writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(local)}\n`);
    }
  });
  try {
    expect(importBaseVariant({ previewSha256: preview.previewSha256! }, revision, paths))
      .toMatchObject({ ok: false, error: "recovery_required" });
  } finally { renameSpy.mockRestore(); }
  const selected = String(Bun.TOML.parse(read(paths.configPath)!).model_instructions_file);
  expect(existsSync(resolve(dirname(paths.configPath), selected))).toBe(true);
  expect(read(journalPathFor(paths.storePath))).toBe("invalid journal");
});

test("the import read stops at its raw ceiling plus one byte", () => {
  const paths = fixture();
  const external = join(dirname(paths.configPath), "large.md");
  writeFileSync(external, "x".repeat(512 * 1024));
  writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const realRead = fsModule.readSync;
  let total = 0;
  const readSpy = spyOn(fsModule, "readSync").mockImplementation((...args) => {
    const count = Reflect.apply(realRead, fsModule, args);
    total += count;
    return count;
  });
  try {
    expect(previewBaseImport(paths).reason).toBe("body_too_large");
    expect(total).toBe(2 * 65536 + 1);
  } finally { readSpy.mockRestore(); }
});

test.skipIf(process.platform === "win32")("an import FIFO without a writer is refused without blocking", async () => {
  const paths = fixture();
  const external = join(dirname(paths.configPath), "fifo.md");
  expect(Bun.spawnSync({ cmd: ["mkfifo", external] }).exitCode).toBe(0);
  writeFileSync(paths.configPath, `model_instructions_file = ${JSON.stringify(external)}\n`);
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", `import { previewBaseImport } from ${JSON.stringify(repoPath("src/codex/prompt-layers.ts"))};
      console.log(JSON.stringify(previewBaseImport(${JSON.stringify(paths)})));`],
    stdout: "pipe", stderr: "pipe", timeout: 1500,
  });
  expect(await child.exited).toBe(0);
  const preview = JSON.parse(await new Response(child.stdout).text());
  expect(preview.reason).toBe("file_unreadable");
  expect(preview.serialized).toBeNull();
});
