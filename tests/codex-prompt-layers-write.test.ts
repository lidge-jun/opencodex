/**
 * Write-path contract for src/codex/prompt-layers.ts.
 *
 * Explicit temp paths only — these functions write a user's live Codex config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPromptLayers,
  setToggle,
  writeCustomLayers,
  type CustomLayer,
} from "../src/codex/prompt-layers";
import {
  encodeJournal,
  hashBytes,
  type JournalRecord,
} from "../src/codex/prompt-journal";

const MARKER = "# Auto-injected by opencodex";
const roots: string[] = [];

function fixture(config?: string, store?: string) {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-write-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const storePath = join(root, "opencodex-prompt.json");
  if (config !== undefined) writeFileSync(configPath, config, "utf8");
  if (store !== undefined) writeFileSync(storePath, store, "utf8");
  return { root, configPath, storePath };
}

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function layer(over: Partial<CustomLayer> = {}): CustomLayer {
  return { id: "aaaaaa", title: "House rules", body: "Be brief.", enabled: true, ...over };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("toggles", () => {
  test("creates the file on first write", () => {
    const paths = fixture();
    const before = readPromptLayers(paths);
    const result = setToggle("apps", false, before.revision, paths);
    expect(result.ok).toBe(true);
    expect(read(paths.configPath)).toContain("include_apps_instructions = false");
  });

  test("inserts above the first table, never inside it", () => {
    // A root key placed after a table header belongs to that table.
    const paths = fixture("[profiles.x]\nmodel = \"y\"\n");
    const before = readPromptLayers(paths);
    setToggle("apps", false, before.revision, paths);
    const lines = read(paths.configPath)!.split("\n");
    expect(lines.indexOf("include_apps_instructions = false")).toBeLessThan(
      lines.findIndex(l => l.startsWith("[profiles.x]")),
    );
  });

  test("replaces in place and keeps comments", () => {
    const paths = fixture("# keep me\ninclude_apps_instructions = true # why\nmodel = \"x\"\n");
    const before = readPromptLayers(paths);
    setToggle("apps", false, before.revision, paths);
    const text = read(paths.configPath)!;
    expect(text).toContain("# keep me");
    expect(text).toContain("include_apps_instructions = false # why");
    expect(text).toContain('model = "x"');
  });

  test("is idempotent and writes nothing when unchanged", () => {
    const paths = fixture("include_apps_instructions = false\n");
    const before = readPromptLayers(paths);
    const result = setToggle("apps", false, before.revision, paths);
    expect(result).toMatchObject({ ok: true, changed: false });
  });

  test("skills goes into its table and creates it when absent", () => {
    const paths = fixture("model = \"x\"\n");
    const before = readPromptLayers(paths);
    setToggle("skills", false, before.revision, paths);
    const text = read(paths.configPath)!;
    expect(text).toContain("[skills]");
    expect(text).toContain("include_instructions = false");
    expect(readPromptLayers(paths).toggles.find(t => t.id === "skills")!.userFileValue).toBe(false);
  });

  test("skills edits inside an existing table", () => {
    const paths = fixture("[skills]\ninclude_instructions = true\nother = 1\n");
    const before = readPromptLayers(paths);
    setToggle("skills", false, before.revision, paths);
    const text = read(paths.configPath)!;
    expect(text).toContain("include_instructions = false");
    expect(text).toContain("other = 1");
  });

  test("CRLF is preserved", () => {
    const paths = fixture("model = \"x\"\r\ninclude_apps_instructions = true\r\n");
    const before = readPromptLayers(paths);
    setToggle("apps", false, before.revision, paths);
    expect(read(paths.configPath)).toContain("\r\n");
  });

  test("an unknown id is rejected before any file access", () => {
    const paths = fixture();
    expect(setToggle("base-instructions", false, "any", paths)).toEqual({ ok: false, error: "unknown_layer" });
    expect(existsSync(paths.configPath)).toBe(false);
  });

  test("a stale revision writes nothing", () => {
    const paths = fixture("model = \"x\"\n");
    const result = setToggle("apps", false, "sha256:stale", paths);
    expect(result).toEqual({ ok: false, error: "stale_revision" });
    expect(read(paths.configPath)).toBe("model = \"x\"\n");
  });
});

describe("custom layers", () => {
  test("writes the store and projects the enabled subset", () => {
    const paths = fixture("model = \"x\"\n");
    const before = readPromptLayers(paths);
    const result = writeCustomLayers([layer()], before.revision, paths);
    expect(result.ok).toBe(true);

    const config = read(paths.configPath)!;
    expect(config).toContain(MARKER);
    expect(config).toContain('developer_instructions = "Be brief."');

    const after = readPromptLayers(paths);
    expect(after.custom).toHaveLength(1);
    expect(after.drift).toBeNull();
  });

  test("a disabled layer stays in the store but leaves the prompt", () => {
    const paths = fixture("model = \"x\"\n");
    let snap = readPromptLayers(paths);
    writeCustomLayers([layer(), layer({ id: "bbbbbb", body: "Second.", enabled: false })], snap.revision, paths);

    snap = readPromptLayers(paths);
    expect(snap.custom).toHaveLength(2);
    expect(read(paths.configPath)).not.toContain("Second.");
  });

  test("disabling everything removes both generated lines", () => {
    const paths = fixture("model = \"x\"\n");
    let snap = readPromptLayers(paths);
    writeCustomLayers([layer()], snap.revision, paths);
    snap = readPromptLayers(paths);
    writeCustomLayers([layer({ enabled: false })], snap.revision, paths);

    const config = read(paths.configPath)!;
    expect(config).not.toContain(MARKER);
    expect(config).not.toContain("developer_instructions");
    expect(config).toContain('model = "x"');
  });

  test("a body with quotes, backslashes and newlines round-trips", () => {
    const paths = fixture("model = \"x\"\n");
    const body = 'say "hi"\\there\nsecond line';
    const snap = readPromptLayers(paths);
    expect(writeCustomLayers([layer({ body })], snap.revision, paths).ok).toBe(true);
    // Tab normalizes to four spaces; everything else survives verbatim.
    expect(readPromptLayers(paths).custom[0]!.body).toBe('say "hi"\\there\nsecond line');
    expect(read(paths.configPath)).toContain('\\"hi\\"');
  });

  test("the retired fence text is now ordinary body text", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    const body = "# >>> ocx-layer:abc123 not a delimiter";
    expect(writeCustomLayers([layer({ body })], snap.revision, paths).ok).toBe(true);
    expect(readPromptLayers(paths).custom[0]!.body).toBe(body);
  });

  test("a control character is refused before anything is written", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    const result = writeCustomLayers([layer({ body: "bad\u0007" })], snap.revision, paths);
    expect(result).toMatchObject({ ok: false, error: "invalid_characters" });
    expect(read(paths.configPath)).toBe('model = "x"\n');
  });

  test("an externally authored key is refused, not overwritten", () => {
    const paths = fixture('developer_instructions = "hand written"\n');
    const snap = readPromptLayers(paths);
    const result = writeCustomLayers([layer()], snap.revision, paths);
    expect(result).toMatchObject({ ok: false, error: "developer_instructions_not_owned" });
    expect(read(paths.configPath)).toBe('developer_instructions = "hand written"\n');
  });

  test("a reshaped owned line is refused too", () => {
    const paths = fixture(`${MARKER}\ndeveloper_instructions = '''x'''\n`);
    const snap = readPromptLayers(paths);
    expect(writeCustomLayers([layer()], snap.revision, paths))
      .toMatchObject({ ok: false, error: "developer_instructions_not_owned" });
  });
});

describe("transaction", () => {
  test("a successful write leaves no journal or lock behind", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    writeCustomLayers([layer()], snap.revision, paths);
    const strays = readdirSync(paths.root).filter(f => f.includes(".journal") || f.includes(".lock") || f.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  test("a pre-existing journal blocks the write until it is resolved", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    writeFileSync(join(paths.root, "opencodex-prompt.journal"), "garbage", "utf8");
    const result = setToggle("apps", false, snap.revision, paths);
    expect(result).toMatchObject({ ok: false, error: "recovery_required" });
    expect(read(paths.configPath)).toBe('model = "x"\n');
  });

  test("a forged journal cannot redirect recovery away from the active paths", () => {
    const paths = fixture('model = "x"\n');
    const attacker = fixture("ATTACKER_POST_CONFIG", "ATTACKER_PRE_STORE");
    const journalPath = join(paths.root, "opencodex-prompt.journal");
    const record: JournalRecord = {
      configPath: attacker.configPath,
      storePath: attacker.storePath,
      preConfig: hashBytes("ATTACKER_PRE_CONFIG"),
      postConfig: hashBytes("ATTACKER_POST_CONFIG"),
      preStore: hashBytes("ATTACKER_PRE_STORE"),
      postStore: hashBytes("ATTACKER_POST_STORE"),
      preConfigBytes: "ATTACKER_PRE_CONFIG",
      postConfigBytes: "ATTACKER_POST_CONFIG",
      preStoreBytes: "ATTACKER_PRE_STORE",
      postStoreBytes: "ATTACKER_POST_STORE",
    };
    writeFileSync(journalPath, encodeJournal(record), "utf8");

    const before = readPromptLayers(paths);
    const result = setToggle("apps", false, before.revision, paths);

    expect(result).toMatchObject({ ok: false, error: "recovery_required" });
    expect(read(paths.configPath)).toBe('model = "x"\n');
    expect(read(attacker.configPath)).toBe("ATTACKER_POST_CONFIG");
    expect(read(attacker.storePath)).toBe("ATTACKER_PRE_STORE");
    expect(existsSync(journalPath)).toBe(true);
  });

  test("a held lock refuses a second writer", () => {
    const paths = fixture("model = \"x\"\n");
    const snap = readPromptLayers(paths);
    writeFileSync(
      join(paths.root, "opencodex-prompt.lock"),
      JSON.stringify({ token: "other", pid: process.pid, acquiredAt: Date.now() }),
      "utf8",
    );
    expect(setToggle("apps", false, snap.revision, paths)).toEqual({ ok: false, error: "locked" });
  });

  test("the revision changes after every real write", () => {
    const paths = fixture("model = \"x\"\n");
    const first = readPromptLayers(paths).revision;
    setToggle("apps", false, first, paths);
    expect(readPromptLayers(paths).revision).not.toBe(first);
  });
});
