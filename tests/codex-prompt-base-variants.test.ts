/**
 * Base-prompt variants: selection, immutability of the default, and write ordering.
 *
 * Explicit temp paths only - these functions write a real Codex config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_BASE_VARIANTS,
  readBaseVariants,
  readPromptLayers,
  selectBaseVariant,
  writeBaseVariant,
} from "../src/codex/prompt-layers";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
