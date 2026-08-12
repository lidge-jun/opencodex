/**
 * Adoption and salvage for src/codex/prompt-layers.ts.
 *
 * Refusing to touch an externally authored key is correct but was a dead end on
 * its own — the earlier answer was "delete your instructions by hand". These are
 * the sanctioned exits, and the property that matters is that a preview shows
 * exactly what a confirm will store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adoptDeveloperInstructions,
  previewAdopt,
  previewSalvage,
  readPromptLayers,
  salvageProjection,
} from "../src/codex/prompt-layers";

const MARKER = "# Auto-injected by opencodex";
const roots: string[] = [];

function fixture(config: string, store?: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-adopt-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const storePath = join(root, "opencodex-prompt.json");
  writeFileSync(configPath, config, "utf8");
  if (store !== undefined) writeFileSync(storePath, store, "utf8");
  return { root, configPath, storePath };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("adopt preview", () => {
  test("nothing to adopt when the key is absent or already ours", () => {
    expect(previewAdopt(fixture('model = "x"\n')).reason).toBe("nothing_to_adopt");
    expect(previewAdopt(fixture(`${MARKER}\ndeveloper_instructions = "ours"\n`)).reason).toBe("nothing_to_adopt");
  });

  test("decodes an external single-line basic string", () => {
    const preview = previewAdopt(fixture('developer_instructions = "line one\\nline two"\n'));
    expect(preview.reason).toBe("ok");
    // The VALUE, not the syntax: an earlier design stored the raw source line.
    expect(preview.decodedBody).toBe("line one\nline two");
    expect(preview.rawLine).toContain("developer_instructions");
    expect(preview.line).toBe(1);
  });

  test("unescapes quotes and backslashes", () => {
    const preview = previewAdopt(fixture('developer_instructions = "say \\"hi\\" and \\\\ too"\n'));
    expect(preview.decodedBody).toBe('say "hi" and \\ too');
  });

  test("refuses a multi-line or literal string, naming the line", () => {
    const preview = previewAdopt(fixture("developer_instructions = '''x'''\n"));
    expect(preview.reason).toBe("unsupported_form");
    expect(preview.line).toBe(1);
    expect(preview.decodedBody).toBeNull();
  });

  test("refuses escapes we will not decode", () => {
    // \t and \f are transposed by Bun's parser; guessing is what we refuse to do.
    expect(previewAdopt(fixture('developer_instructions = "a\\tb"\n')).reason).toBe("unsupported_form");
    expect(previewAdopt(fixture('developer_instructions = "a\\u00e9b"\n')).reason).toBe("unsupported_form");
  });

  test("previews are read-only", () => {
    const paths = fixture('developer_instructions = "keep"\n');
    previewAdopt(paths);
    expect(readFileSync(paths.configPath, "utf8")).toBe('developer_instructions = "keep"\n');
    expect(existsSync(paths.storePath)).toBe(false);
  });
});

describe("adopt commit", () => {
  test("imports the decoded body and takes ownership", () => {
    const paths = fixture('developer_instructions = "be brief"\nmodel = "x"\n');
    const before = readPromptLayers(paths);
    expect(adoptDeveloperInstructions(before.revision, paths).ok).toBe(true);

    const after = readPromptLayers(paths);
    expect(after.developerInstructionsOwned).toBe(true);
    expect(after.custom).toHaveLength(1);
    expect(after.custom[0]!.body).toBe("be brief");
    expect(after.custom[0]!.title).toBe("Imported from config.toml");
    expect(after.drift).toBeNull();

    const text = readFileSync(paths.configPath, "utf8");
    expect(text).toContain(MARKER);
    expect(text).toContain('model = "x"');
    // Exactly one assignment survives: the old unowned line is gone.
    expect(text.match(/developer_instructions/g)).toHaveLength(1);
  });

  test("the committed body is byte-identical to the preview", () => {
    const paths = fixture('developer_instructions = "one\\ntwo"\n');
    const preview = previewAdopt(paths);
    adoptDeveloperInstructions(readPromptLayers(paths).revision, paths);
    expect(readPromptLayers(paths).custom[0]!.body).toBe(preview.decodedBody);
  });

  test("an unsupported form is refused and changes nothing", () => {
    const paths = fixture("developer_instructions = '''x'''\n");
    const before = readPromptLayers(paths);
    expect(adoptDeveloperInstructions(before.revision, paths).ok).toBe(false);
    expect(readFileSync(paths.configPath, "utf8")).toBe("developer_instructions = '''x'''\n");
  });

  test("adopting a reshaped OWNED line clears the malformed drift", () => {
    const paths = fixture(`${MARKER}\ndeveloper_instructions = "recoverable"\nmodel = "x"\n`);
    // Simulate the marker being lost while the value stays canonical.
    writeFileSync(paths.configPath, 'developer_instructions = "recoverable"\nmodel = "x"\n', "utf8");
    const before = readPromptLayers(paths);
    expect(before.drift).toBeNull();
    expect(adoptDeveloperInstructions(before.revision, paths).ok).toBe(true);
    expect(readPromptLayers(paths).developerInstructionsOwned).toBe(true);
  });
});

describe("salvage", () => {
  const live = `${MARKER}\ndeveloper_instructions = "salvage me"\n`;

  test("preview returns a directory, not a reserved filename", () => {
    const paths = fixture(live);
    const preview = previewSalvage(paths);
    expect(preview.reason).toBe("ok");
    expect(preview.body).toBe("salvage me");
    /*
     * The claim is "a directory, not the store file" — asserting a trailing
     * "/" asserted POSIX separators instead, and `dirname` (which is what
     * makes this correct on Windows) does not leave one.
     */
    expect(preview.backupDir).toBe(dirname(paths.storePath));
    expect(preview.backupDir).not.toBe(paths.storePath);
    // A read-only preview must create nothing at all.
    expect(readdirSync(paths.root).filter(f => f.includes("salvage"))).toEqual([]);
  });

  test("names what cannot be recovered", () => {
    const preview = previewSalvage(fixture(live));
    expect(preview.unrecoverable).toContain("layer titles");
    expect(preview.unrecoverable).toContain("disabled layers and their bodies");
  });

  test("nothing to salvage without a live projection", () => {
    expect(previewSalvage(fixture('model = "x"\n')).reason).toBe("nothing_to_salvage");
  });

  test("writes a durable 0600 backup before rebuilding the store", () => {
    const paths = fixture(live);
    const before = readPromptLayers(paths);
    expect(before.drift).toBe("store-missing");

    expect(salvageProjection(before.revision, paths).ok).toBe(true);

    const backups = readdirSync(paths.root).filter(f => f.includes(".salvage-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(paths.root, backups[0]!), "utf8")).toBe("salvage me");
    if (process.platform !== "win32") {
      expect(statSync(join(paths.root, backups[0]!)).mode & 0o777).toBe(0o600);
    }

    const after = readPromptLayers(paths);
    expect(after.drift).toBeNull();
    expect(after.custom).toHaveLength(1);
    expect(after.custom[0]!.body).toBe("salvage me");
    expect(after.custom[0]!.title).toBe("Salvaged from config.toml");
  });

  test("the projection is unchanged by salvage", () => {
    const paths = fixture(live);
    salvageProjection(readPromptLayers(paths).revision, paths);
    expect(readFileSync(paths.configPath, "utf8")).toContain('developer_instructions = "salvage me"');
  });
});
