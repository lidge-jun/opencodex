import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectGrokConfig } from "../src/grok/inject";

/**
 * #511 — Grok Build reported 200k for every model.
 *
 * `~/.grok/config.toml` accumulated a SECOND entry per model above the managed block,
 * written by a version that predates the fence. Those entries carry no `context_window`,
 * so Grok fell back to its own 200k default — and because they sit outside the fence,
 * `userModelAliases` reserved them as user-owned, so every sync wrote a correct `-2`
 * duplicate beside the stale original instead of replacing it. `[models] default` named
 * the stale one.
 *
 * Failure-mode ids below map to devlog/_plan/260727_grok_orphan_adoption/001.
 */

const BEGIN_MARKER = "# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>";
const MODELS = [{ id: "gpt-5.6-sol", contextWindow: 372_000 }];

describe("Grok orphan adoption (#511)", () => {
  let root: string;
  let grokHome: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-orphan-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
    configPath = join(grokHome, "config.toml");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** The real shape from a machine that hit #511. */
  function writeOrphanedConfig(extra = ""): void {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      'name = "OCX gpt-5.6-sol"',
      "",
      extra,
    ].join("\n"));
  }

  function modelTables(content: string): string[] {
    return [...content.matchAll(/^\[model\.([^\]]+)\]$/gm)].map(match => match[1]!);
  }

  test("adopts the stale entry so exactly one table per model survives", () => {
    writeOrphanedConfig();
    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    const tables = modelTables(content);
    expect(tables).toHaveLength(1);
    // The survivor is inside the fence and carries the authoritative window.
    expect(content.indexOf(`[model.${tables[0]}]`)).toBeGreaterThan(content.indexOf(BEGIN_MARKER));
    expect(content).toContain("context_window = 372000");
  });

  // F2: on a real machine `default` names the orphan, so this is the common path.
  test("repoints default at the surviving alias", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });

    const content = readFileSync(configPath, "utf8");
    const survivor = modelTables(content)[0]!;
    expect(content).toContain(`default = "${survivor}"`);
  });

  // F1: the worst outcome is deleting a model a human wrote. Loopback alone is legitimate.
  test("never adopts a hand-written model, even on a loopback base_url", () => {
    writeOrphanedConfig([
      "[model.my-own]",
      'model = "my-local"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "my-own-secret"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[model.my-own]");
    expect(content).toContain('api_key = "my-own-secret"');
  });

  // F1: our api_key pointed at a REMOTE host is not ours to delete.
  test("does not adopt our api_key when the base_url is remote", () => {
    writeFileSync(configPath, [
      "[model.ocx-remote]",
      'model = "gpt-5.6-sol"',
      'base_url = "https://example.com/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    expect(readFileSync(configPath, "utf8")).toContain("[model.ocx-remote]");
  });

  // F3: `[[model.x]]` collides with a generated `[model.x]` and makes Grok reject the
  // WHOLE config layer, so that spelling must stay reserved rather than adopted.
  test("leaves an array-of-table model reserved", () => {
    writeFileSync(configPath, [
      "[[model.ocx-arr]]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[[model.ocx-arr]]");
    expect(content).not.toContain("\n[model.ocx-arr]\n");
  });

  // F4: a partial removal would re-parent leftover keys onto the neighbouring table.
  test("removal keeps the following table intact", () => {
    writeOrphanedConfig([
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("[ui]");
    expect(content).toContain('theme = "dark"');
    // No key from the removed table leaked into [ui].
    expect(content).not.toContain('api_backend = "responses"\ntheme');
  });

  // F5: an orphan with no replacement stays, and its reference is not rewritten to
  // something arbitrary — a working config beats a dangling default.
  test("keeps an orphan whose model is no longer in the catalog", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-retired"',
      "",
      "[model.ocx-retired]",
      'model = "retired/model"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain('default = "ocx-retired"');
  });

  // F7: the sweep must converge, or `changed` is meaningless to callers.
  test("is idempotent: the second sync reports no change", () => {
    writeOrphanedConfig();
    injectGrokConfig(10100, MODELS, { grokHome });
    const afterFirst = readFileSync(configPath, "utf8");

    const second = injectGrokConfig(10100, MODELS, { grokHome });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(readFileSync(configPath, "utf8")).toBe(afterFirst);
  });

  // F6: the sweep runs inside the normalized window, so the user's EOL survives.
  test("preserves CRLF line endings", () => {
    writeOrphanedConfig();
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/\n/g, "\r\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");
    expect(content).toContain("\r\n");
    expect(content.replace(/\r\n/g, "")).not.toContain("\n");
  });


  // The state a REAL machine reached (#511 field evidence): Grok re-serialized the file
  // into its own format and dropped our marker COMMENTS entirely. findManagedRegion then
  // returns null, so the whole file is in scope and the ownership predicate is the only
  // thing standing between the sweep and the user's own models.
  test("still adopts safely when Grok has dropped the markers entirely", () => {
    writeFileSync(configPath, [
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "",
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",            // stale: no context_window
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      "[model.ocx-gpt-5-6-sol-2]",          // the correct duplicate, also unfenced now
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "context_window = 372000",
      "",
      "[model.ocx-gpt-5-6-sol-2.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.hand-written]",               // must survive
      'model = "mine"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // Both opencodex duplicates collapse into the single regenerated entry.
    expect(modelTables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    expect(content).toContain("context_window = 372000");
    // The user's model and settings are untouched.
    expect(content).toContain("[model.hand-written]");
    expect(content).toContain('api_key = "not-ours"');
    expect(content).toContain('fork_secondary_model = "grok-build"');
    // default still resolves.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(content).toContain(`[model.${survivor}]`);
  });

  // F8: an ambiguous fence must refuse BEFORE the sweep, or "outside the region" could
  // mean the entire file.
  test("refuses to sweep when the end marker is missing", () => {
    const content = [
      "[model.ocx-gpt-5-6-sol]",
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'api_key = "opencodex-loopback"',
      "",
      BEGIN_MARKER,
      "",
    ].join("\n");
    writeFileSync(configPath, content);

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: false, changed: false, skippedReason: "orphaned-marker" });
    expect(readFileSync(configPath, "utf8")).toBe(content);
  });

  /**
   * The 2026-07-27 field failure. Grok re-serialized the file (marker comments gone,
   * `extra_headers` promoted to sub-tables) and, separately, the proxy had once run on a
   * different port. The result is a generation of OUR OWN entries pinned to a port
   * nothing listens on, with `[models] default` naming one of them: the TUI shows the
   * right context window (the stale entry carries it) while every turn retries against a
   * refused connection and nothing ever reaches the proxy.
   *
   * A stale entry is only distinguishable from the live one by VALUE — its loopback port
   * is not the port being injected — so port equality has to be part of the sweep.
   */
  test("adopts our own entries left on a port the proxy no longer listens on", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "[model.ocx-gpt-5-6-sol]",            // stale generation: dead port
      'model = "gpt-5.6-sol"',
      'base_url = "http://127.0.0.1:4179/v1"',
      'api_backend = "responses"',
      'api_key = "opencodex-loopback"',
      "context_window = 372000",
      "",
      "[model.ocx-gpt-5-6-sol.extra_headers]",
      'x-opencodex-grok = "1"',
      "",
      "[model.hand-written]",               // must survive untouched
      'model = "mine"',
      'base_url = "http://127.0.0.1:4179/v1"',
      'api_key = "not-ours"',
      "",
    ].join("\n"));

    const result = injectGrokConfig(10100, MODELS, { grokHome });
    expect(result).toMatchObject({ ok: true, changed: true });

    const content = readFileSync(configPath, "utf8");
    // No opencodex-owned entry may still point at the dead port.
    expect(content).not.toContain("127.0.0.1:4179/v1\"\napi_backend");
    expect(modelTables(content).filter(alias => alias.startsWith("ocx-"))).toHaveLength(1);
    // Its orphaned sub-table went with it, or the alias stays reserved forever.
    expect(content).not.toContain("[model.ocx-gpt-5-6-sol.extra_headers]");
    // `default` must name a table that actually exists and reaches the live port.
    const survivor = /^default = "([^"]+)"/m.exec(content)?.[1];
    expect(survivor).toBeDefined();
    expect(content).toContain(`[model.${survivor}]`);
    expect(content).toContain('base_url = "http://127.0.0.1:10100/v1"');
    // The user's own entry keeps its port, whatever it is.
    expect(content).toContain("[model.hand-written]");
    expect(content).toContain('api_key = "not-ours"');
  });
});

/**
 * Follow-up to the #511 fix: the sweep computed an orphan's span as "up to the next TABLE
 * HEADER", but the fence opens with a COMMENT. When nothing separated the orphan from the
 * fence, the span swallowed the BEGIN marker and the sweep deleted the fence opener — so the
 * block was re-appended at EOF, the old END marker was stranded, and every later sync
 * rewrote the file forever with `default` alternating between the two aliases.
 *
 * Every fixture in the suite above puts a blank line and another table between the orphan and
 * the fence, which is why 55 green tests missed it. Adjacency is the whole point here.
 */
describe("Grok orphan adoption — fence boundary (#511 follow-up)", () => {
  const END_MARKER = "# <<< opencodex managed block <<<";
  let root: string;
  let grokHome: string;
  let configPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-grok-fence-"));
    grokHome = join(root, ".grok");
    mkdirSync(grokHome);
    configPath = join(grokHome, "config.toml");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const orphan = (alias: string): string[] => [
    `[model.${alias}]`,
    'model = "gpt-5.6-sol"',
    'base_url = "http://127.0.0.1:10100/v1"',
    'api_key = "opencodex-loopback"',
  ];

  const fence = (alias: string): string[] => [
    BEGIN_MARKER,
    `[model.${alias}]`,
    'model = "gpt-5.6-sol"',
    "context_window = 372000",
    'base_url = "http://127.0.0.1:10100/v1"',
    'api_key = "opencodex-loopback"',
    END_MARKER,
  ];

  const count = (content: string, needle: string): number =>
    content.split(needle).length - 1;
  const tables = (content: string): string[] =>
    [...content.matchAll(/^\[model\.([^\]]+)\]$/gm)].map(match => match[1]!);

  test("an orphan directly above the fence does not swallow the BEGIN marker", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const results = [1, 2, 3].map(() => injectGrokConfig(10100, MODELS, { grokHome }));
    const content = readFileSync(configPath, "utf8");

    // The fence survives: exactly one of each marker, never a stranded second END.
    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    // The duplicate is gone, not routed around.
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    // Convergence: only the first run may change the file.
    expect(results.map(result => result.changed)).toEqual([true, false, false]);
    // `default` settles instead of alternating between the two aliases every sync.
    expect(content).toContain('default = "ocx-gpt-5-6-sol"');
    expect(content).not.toContain('default = "ocx-gpt-5-6-sol-2"');
  });

  test("a below-fence orphan still gets its sub-tables swept", () => {
    // Grok re-serializes `extra_headers` into a sub-table. Leaving one behind keeps the alias
    // reserved by `userModelAliases`, which forces a `-2` duplicate forever — so the fence
    // clamp must NOT apply to a parent that already sits past the fence.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...fence("ocx-placeholder"),
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      "[model.ocx-gpt-5-6-sol.extra_headers]",
      'x-opencodex = "1"',
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    // Not a bare "extra_headers" check: the generated block legitimately writes an INLINE
    // `extra_headers = { ... }` key. What must be gone is the orphan's SUB-TABLE header.
    expect(content).not.toContain("[model.ocx-gpt-5-6-sol.extra_headers]");
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    // The alias is free, so the writer never needs the suffixed form.
    expect(content).not.toContain("ocx-gpt-5-6-sol-2");
  });

  test("an adjacent orphan with no blank line before the marker is still bounded", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  test("orphans on both sides of the fence collapse together", () => {
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
      ...orphan("ocx-gpt-5-6-sol-3"),
      "",
      "[ui]",
      'theme = "dark"',
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(tables(content)).toEqual(["ocx-gpt-5-6-sol"]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // Unrelated user config is untouched.
    expect(content).toContain("[ui]");
    expect(content).toContain('theme = "dark"');
  });

  test("a comment trailing an adopted orphan goes with it, and the sync converges", () => {
    // Known and accepted: a table's body runs to the next header, so a comment sitting
    // between the orphan and the fence belongs to the orphan and is removed with it. The
    // fence itself must still survive — that is the part this guards. A user note that must
    // outlive the sweep belongs above the orphan, and the pre-sweep backup keeps a copy.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      "# this note is above the orphan",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      "# this note trails the orphan",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    const first = injectGrokConfig(10100, MODELS, { grokHome });
    const second = injectGrokConfig(10100, MODELS, { grokHome });
    const content = readFileSync(configPath, "utf8");

    expect(content).toContain("# this note is above the orphan");
    expect(content).not.toContain("# this note trails the orphan");
    expect(count(content, BEGIN_MARKER)).toBe(1);
    expect(count(content, END_MARKER)).toBe(1);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // The removed note is recoverable.
    expect(readFileSync(`${configPath}.bak-opencodex`, "utf8")).toContain("# this note trails the orphan");
  });

  test("adopting an orphan backs the user's config up first", () => {
    // The backup used to appear only as a side effect of the fence being destroyed.
    writeFileSync(configPath, [
      "[models]",
      'default = "ocx-gpt-5-6-sol"',
      "",
      ...orphan("ocx-gpt-5-6-sol"),
      "",
      ...fence("ocx-gpt-5-6-sol-2"),
      "",
    ].join("\n"));

    injectGrokConfig(10100, MODELS, { grokHome });

    const backup = readFileSync(`${configPath}.bak-opencodex`, "utf8");
    expect(backup).toContain("[model.ocx-gpt-5-6-sol]");
    expect(backup).toContain("[model.ocx-gpt-5-6-sol-2]");
  });
});
