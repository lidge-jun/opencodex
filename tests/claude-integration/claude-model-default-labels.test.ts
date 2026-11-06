import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaudeModelDefaults, previewClaudeModelDefaults } from "../../src/claude/model-default-settings";
import type { ClaudeTierModels } from "../../src/claude/context-windows";

const roots: string[] = [];
const slot = "ANTHROPIC_DEFAULT_OPUS_MODEL";
const name = `${slot}_NAME`;
const oldAlias = "ocx-claude-native--gpt-6.1-sol";
const newAlias = "ocx-claude-cursor--gpt-5.6-luna[1m]";

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(env: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ocx-model-default-labels-"));
  roots.push(root);
  const path = join(root, "settings.json");
  const original = { model: "user-main", env: { KEEP: "user-value", ...env }, permissions: { allow: [] } };
  writeFileSync(path, JSON.stringify(original));
  return { root, path, original, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

test("preview and apply pair all four tier aliases with their readable names", () => {
  const f = fixture();
  const models = {
    opus: ` ${oldAlias} `,
    sonnet: newAlias,
    haiku: "ocx-claude2-openrouter--vendor~smodel~tx",
    fable: "ocx-claude-native--claude-fable-5-1[1m]",
  };
  const pairs = {
    ANTHROPIC_DEFAULT_OPUS_MODEL: oldAlias,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "gpt-6.1-sol (native)",
    ANTHROPIC_DEFAULT_SONNET_MODEL: newAlias,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "gpt-5.6-luna (cursor) · 1M",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "vendor/model~x (openrouter)",
    ANTHROPIC_DEFAULT_FABLE_MODEL: models.fable,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: "claude-fable-5-1 (anthropic) · 1M",
  };
  const raw = readFileSync(f.path, "utf8");
  const preview = previewClaudeModelDefaults(models, f.root);
  expect(readFileSync(f.path, "utf8")).toBe(raw);
  expect(Object.fromEntries(preview.changes.map(c => [c.key, c.after]))).toEqual(pairs);
  const applied = applyClaudeModelDefaults(models, preview.fingerprint, f.root);
  expect(f.read()).toEqual({ ...f.original, env: { ...f.original.env, ...pairs } });
  expect(readFileSync(applied.backupPath!, "utf8")).toBe(raw);
  expect(previewClaudeModelDefaults(models, f.root).changes).toEqual([]);
  expect(applyClaudeModelDefaults(models, previewClaudeModelDefaults(models, f.root).fingerprint, f.root).changed).toBe(false);
});

test("an unchanged alias still previews and applies a missing label", () => {
  const f = fixture({ [slot]: oldAlias });
  const models = { opus: oldAlias };
  const preview = previewClaudeModelDefaults(models, f.root);
  expect(preview.changes).toEqual([{ key: name, before: null, after: "gpt-6.1-sol (native)" }]);
  applyClaudeModelDefaults(models, preview.fingerprint, f.root);
  expect(f.read().env[name]).toBe("gpt-6.1-sol (native)");
});

test("changing an alias updates a label matching the previous alias", () => {
  const f = fixture({ [slot]: oldAlias, [name]: "gpt-6.1-sol (native)" });
  const models = { opus: newAlias };
  const preview = previewClaudeModelDefaults(models, f.root);
  expect(preview.changes).toContainEqual({ key: name, before: "gpt-6.1-sol (native)", after: "gpt-5.6-luna (cursor) · 1M" });
  applyClaudeModelDefaults(models, preview.fingerprint, f.root);
  expect(f.read().env).toEqual({ KEEP: "user-value", [slot]: newAlias, [name]: "gpt-5.6-luna (cursor) · 1M" });
});

test("replacing an alias with a non-alias removes only its matching generated label", () => {
  for (const id of ["claude-opus-5-5", "cursor/model", "opus"]) {
    const f = fixture({ [slot]: oldAlias, [name]: "gpt-6.1-sol (native)" });
    const models = { opus: id };
    const preview = previewClaudeModelDefaults(models, f.root);
    expect(preview.changes).toContainEqual({ key: name, before: "gpt-6.1-sol (native)", after: "" });
    applyClaudeModelDefaults(models, preview.fingerprint, f.root);
    expect(f.read().env).toEqual({ KEEP: "user-value", [slot]: id });
  }
});

test("unset tiers retain both the existing settings model and its label", () => {
  for (const models of [undefined, {}, { opus: "" }, { opus: "  " }] satisfies (ClaudeTierModels | undefined)[]) {
    const f = fixture({ [slot]: oldAlias, [name]: "gpt-6.1-sol (native)" });
    const preview = previewClaudeModelDefaults(models, f.root);
    expect(preview.changes).toEqual([]);
    expect(f.read()).toEqual(f.original);
    applyClaudeModelDefaults(models, preview.fingerprint, f.root);
    expect(f.read()).toEqual(f.original);
    expect(previewClaudeModelDefaults(models, f.root).changes).toEqual([]);
  }
});

test("custom, empty and non-string labels remain user-owned across replacement and clearing", () => {
  for (const label of ["My chosen name", "", null, 42]) {
    for (const models of [{ opus: newAlias }, { opus: "claude-opus-5-5" }, {}]) {
      const f = fixture({ [slot]: oldAlias, [name]: label });
      const preview = previewClaudeModelDefaults(models, f.root);
      expect(preview.changes.some(c => c.key === name)).toBe(false);
      applyClaudeModelDefaults(models, preview.fingerprint, f.root);
      expect(f.read().env[name]).toEqual(label);
    }
  }
});

test("a label without its matching alias is retained even if it resembles a generated name", () => {
  for (const id of [undefined, "user-model", newAlias]) {
    const f = fixture({ ...(id ? { [slot]: id } : {}), [name]: "gpt-6.1-sol (native)" });
    const models = { opus: newAlias };
    applyClaudeModelDefaults(models, previewClaudeModelDefaults(models, f.root).fingerprint, f.root);
    expect(f.read().env[name]).toBe("gpt-6.1-sol (native)");
  }
});

test("legacy and fast aliases keep their exact IDs and derive matching names", () => {
  for (const [id, label] of [
    ["claude-ocx-native--gpt-6.1-sol", "gpt-6.1-sol (native)"],
    ["claude-ocx-native--gpt-6.1-terra", "gpt-6.1-terra (native)"],
    ["ocx-claude-fixture--foo--fast", "foo--fast (fixture)"],
  ]) {
    const f = fixture();
    const models = { opus: id };
    applyClaudeModelDefaults(models, previewClaudeModelDefaults(models, f.root).fingerprint, f.root);
    expect(f.read().env).toEqual({ KEEP: "user-value", [slot]: id, [name]: label });
  }
});

test("a custom label edit since preview prevents apply from taking ownership", () => {
  const f = fixture({ [slot]: oldAlias, [name]: "gpt-6.1-sol (native)" });
  const models = { opus: newAlias };
  const preview = previewClaudeModelDefaults(models, f.root);
  const edited = { ...f.original, env: { ...f.original.env, [name]: "Edited by user" } };
  writeFileSync(f.path, JSON.stringify(edited));
  expect(() => applyClaudeModelDefaults(models, preview.fingerprint, f.root)).toThrow("settings_changed");
  expect(f.read()).toEqual(edited);
});

test("late label edits are captured and restored without replacing user ownership", () => {
  const f = fixture({ [slot]: oldAlias, [name]: "gpt-6.1-sol (native)" });
  const models = { opus: newAlias };
  const preview = previewClaudeModelDefaults(models, f.root);
  const edited = { ...f.original, env: { ...f.original.env, [name]: "Late user label" } };
  const backups = join(f.root, "backups");
  expect(() => applyClaudeModelDefaults(models, preview.fingerprint, f.root, backups, {
    beforeCapture: () => writeFileSync(f.path, JSON.stringify(edited)),
  })).toThrow("settings_changed");
  expect(f.read()).toEqual(edited);
});

test("fresh settings pair aliases without creating unset tiers or synthetic main labels", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-model-default-labels-fresh-"));
  roots.push(root);
  const path = join(root, "settings.json");
  const models = { haiku: newAlias };
  const preview = previewClaudeModelDefaults(models, root);
  expect(existsSync(path)).toBe(false);
  const result = applyClaudeModelDefaults(models, preview.fingerprint, root);
  expect(result.backupPath).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ env: {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: newAlias,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: "gpt-5.6-luna (cursor) · 1M",
  } });
});
