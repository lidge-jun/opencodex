/**
 * Read-path contract for src/codex/prompt-layers.ts.
 *
 * Every case uses an explicit temp path. No test may resolve the real
 * CODEX_HOME — these functions read a user's live Codex configuration.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeProjection,
  inspectOwnership,
  parseStore,
  readPromptLayers,
} from "../src/codex/prompt-layers";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const MARKER = "# Auto-injected by opencodex";
const roots: string[] = [];

function fixture(config: string | null, store?: string | null): { configPath: string; storePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-prompt-read-"));
  roots.push(root);
  const configPath = join(root, "config.toml");
  const storePath = join(root, "opencodex-prompt.json");
  if (config !== null) writeFileSync(configPath, config, "utf8");
  if (store !== undefined && store !== null) writeFileSync(storePath, store, "utf8");
  return { configPath, storePath };
}

function storeJson(layers: unknown[]): string {
  return JSON.stringify({ layers });
}

afterEach(() => {
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

describe("toggles", () => {
  test("a missing config is a first run, not an error", () => {
    const snap = readPromptLayers(fixture(null));
    expect(snap.configExists).toBe(false);
    expect(snap.readable).toBe(true);
    for (const t of snap.toggles) {
      expect(t.userFileValue).toBeNull();
      expect(t.defaultedUserValue).toBe(true);
    }
  });

  test("an absent key reads as unknown, never as false", () => {
    // The upstream surface is months old and still moving: absence must not be
    // reported as an explicit off.
    const snap = readPromptLayers(fixture("model = \"gpt-5\"\n"));
    const apps = snap.toggles.find(t => t.id === "apps")!;
    expect(apps.userFileValue).toBeNull();
    expect(apps.defaultedUserValue).toBe(true);
  });

  test("an explicit false is read from the root scope", () => {
    const snap = readPromptLayers(fixture("include_apps_instructions = false\n"));
    const apps = snap.toggles.find(t => t.id === "apps")!;
    expect(apps.userFileValue).toBe(false);
    expect(apps.defaultedUserValue).toBe(false);
  });

  test("skills is read from its table, not the root", () => {
    const snap = readPromptLayers(fixture("[skills]\ninclude_instructions = false\n"));
    const skills = snap.toggles.find(t => t.id === "skills")!;
    expect(skills.userFileValue).toBe(false);
    expect(skills.key).toBe("skills.include_instructions");
  });

  test("a root-looking key inside another table is NOT the root key", () => {
    // Data protection: a key under [profiles.x] belongs to that table.
    const snap = readPromptLayers(fixture("[profiles.x]\ninclude_apps_instructions = false\n"));
    expect(snap.toggles.find(t => t.id === "apps")!.userFileValue).toBeNull();
  });

  test("a commented key is ignored", () => {
    const snap = readPromptLayers(fixture("# include_apps_instructions = false\n"));
    expect(snap.toggles.find(t => t.id === "apps")!.userFileValue).toBeNull();
  });

  test("a trailing comment on a real key still parses", () => {
    const snap = readPromptLayers(fixture("include_apps_instructions = false # why\n"));
    expect(snap.toggles.find(t => t.id === "apps")!.userFileValue).toBe(false);
  });
});

describe("ownership", () => {
  test("absent when the key is missing", () => {
    expect(inspectOwnership("model = \"x\"\n").state).toBe("absent");
    expect(inspectOwnership(null).state).toBe("absent");
  });

  test("marker plus canonical shape is owned", () => {
    const own = inspectOwnership(`${MARKER}\ndeveloper_instructions = "hello"\n`);
    expect(own.state).toBe("owned");
  });

  test("marker plus a reshaped line is owned-malformed, never rewritten blindly", () => {
    const own = inspectOwnership(`${MARKER}\ndeveloper_instructions = '''hello'''\n`);
    expect(own.state).toBe("owned-malformed");
  });

  test("no marker means externally authored", () => {
    const own = inspectOwnership('developer_instructions = "hand written"\n');
    expect(own.state).toBe("external");
  });

  test("a marker two lines up does not confer ownership", () => {
    // Adjacency is immediate, matching injected-marker.ts.
    const own = inspectOwnership(`${MARKER}\n\ndeveloper_instructions = "x"\n`);
    expect(own.state).toBe("external");
  });

  test("a key inside a table is not the root key", () => {
    expect(inspectOwnership('[other]\ndeveloper_instructions = "x"\n').state).toBe("absent");
  });
});

describe("store", () => {
  test("absent and malformed are distinguishable from empty", () => {
    expect(parseStore(null)).toBeNull();
    expect(parseStore("{ not json")).toBeNull();
    expect(parseStore(storeJson([]))).toEqual([]);
  });

  test("a bad id or duplicate id rejects the whole store", () => {
    expect(parseStore(storeJson([{ id: "BAD", title: "t", body: "b", enabled: true }]))).toBeNull();
    expect(parseStore(storeJson([
      { id: "aaaaaa", title: "t", body: "b", enabled: true },
      { id: "aaaaaa", title: "u", body: "c", enabled: true },
    ]))).toBeNull();
  });

  test("only enabled layers compose, in order", () => {
    const layers = [
      { id: "aaaaaa", title: "1", body: "one", enabled: true },
      { id: "bbbbbb", title: "2", body: "two", enabled: false },
      { id: "cccccc", title: "3", body: "three", enabled: true },
    ];
    expect(composeProjection(layers)).toBe("one\n\nthree");
  });
});

describe("drift", () => {
  const layer = { id: "aaaaaa", title: "t", body: "one", enabled: true };

  test("null when the store matches the projection", () => {
    const snap = readPromptLayers(fixture(
      `${MARKER}\ndeveloper_instructions = "one"\n`,
      storeJson([layer]),
    ));
    expect(snap.drift).toBeNull();
    expect(snap.developerInstructionsOwned).toBe(true);
    expect(snap.custom).toHaveLength(1);
  });

  test("projection-stale when they disagree", () => {
    const snap = readPromptLayers(fixture(
      `${MARKER}\ndeveloper_instructions = "stale"\n`,
      storeJson([layer]),
    ));
    expect(snap.drift).toBe("projection-stale");
  });

  test("store-missing when a live projection has no store behind it", () => {
    // Treating this as an empty store would erase the active prompt.
    const snap = readPromptLayers(fixture(`${MARKER}\ndeveloper_instructions = "one"\n`));
    expect(snap.drift).toBe("store-missing");
  });

  test("no drift when neither store nor projection exists", () => {
    expect(readPromptLayers(fixture("model = \"x\"\n")).drift).toBeNull();
  });

  test("owned-malformed is reported as drift", () => {
    const snap = readPromptLayers(fixture(`${MARKER}\ndeveloper_instructions = '''x'''\n`));
    expect(snap.drift).toBe("owned-malformed");
    expect(snap.developerInstructionsOwned).toBe(false);
  });

  test("a journal on disk outranks every other drift", () => {
    const { configPath, storePath } = fixture(`${MARKER}\ndeveloper_instructions = "one"\n`);
    writeFileSync(storePath.replace(/\.json$/, ".journal"), "x", "utf8");
    expect(readPromptLayers({ configPath, storePath }).drift).toBe("journal-present");
  });
});

describe("reads never write", () => {
  test("every drift state leaves both files byte-identical", async () => {
    const cases: Array<[string, string | null]> = [
      [`${MARKER}\ndeveloper_instructions = "one"\n`, null],
      [`${MARKER}\ndeveloper_instructions = "stale"\n`, storeJson([{ id: "aaaaaa", title: "t", body: "one", enabled: true }])],
      [`${MARKER}\ndeveloper_instructions = '''x'''\n`, null],
      ['developer_instructions = "external"\n', null],
    ];
    for (const [config, store] of cases) {
      const paths = fixture(config, store);
      readPromptLayers(paths);
      expect(await Bun.file(paths.configPath).text()).toBe(config);
      if (store !== null) expect(await Bun.file(paths.storePath).text()).toBe(store);
    }
  });

  test("reading a directory that does not exist creates nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-read-"));
    roots.push(root);
    const nested = join(root, "missing");
    const snap = readPromptLayers({
      configPath: join(nested, "config.toml"),
      storePath: join(nested, "opencodex-prompt.json"),
    });
    expect(snap.configExists).toBe(false);
    expect(await Bun.file(nested).exists()).toBe(false);
  });
});

describe("model_instructions_file", () => {
  test("surfaces as a read-only warning when present", () => {
    // 002 §3: this key REPLACES the base prompt. We report it, never write it.
    const snap = readPromptLayers(fixture('model_instructions_file = "~/.codex/x.md"\n'));
    expect(snap.modelInstructionsFile).toBe("~/.codex/x.md");
  });

  test("is null when absent", () => {
    expect(readPromptLayers(fixture("model = \"x\"\n")).modelInstructionsFile).toBeNull();
  });
});

describe("unreadable config", () => {
  test("a directory where the config should be is not readable", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-prompt-read-"));
    roots.push(root);
    const configPath = join(root, "config.toml");
    mkdirSync(configPath);
    const snap = readPromptLayers({ configPath, storePath: join(root, "s.json") });
    expect(snap.readable).toBe(false);
  });
});
