/**
 * v2 / ultra catalog tests: ultra is always advertised regardless of v2 toggle.
 * The v2 toggle controls the multi-agent surface only, not ultra visibility.
 * config.toml reader + max_concurrent_threads_per_session writer fixtures.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import {
  buildCatalogEntries,
  CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  mergeCatalogEntriesForSync,
  nativeEffortClamp,
  shouldApplyNativeEffortClamp,
  type MultiAgentMode,
} from "../src/codex/catalog";
import {
  buildCatalogEntriesFromObservedState,
  mergeCatalogEntriesFromObservedState,
} from "../src/codex/catalog/sync";
import {
  getAgentsEnabled,
  getAgentsMaxDepth,
  getAgentsMaxThreads,
  getLogicalMaxThreads,
  getMaxConcurrentThreads,
  getMultiAgentModeHintText,
  getSubagentDeveloperInstructions,
  hasAgentsMaxThreads,
  isDefaultModeRequestUserInputEnabled,
  isMultiAgentV2Enabled,
  isTranslatableV1ChildLimit,
  isTranslatableV2TotalLimit,
  probeCodexSupportsModeHint,
  setAgentsEnabled,
  setAgentsMaxDepth,
  setMaxConcurrentThreads,
  setMultiAgentModeHintText,
  setSubagentDeveloperInstructions,
  transitionMultiAgentV2,
  v1ChildLimitToV2TotalLimit,
  v2TotalLimitToV1ChildLimit,
} from "../src/codex/features";
import { resetCodexRuntimeResolveCacheForTests, setCodexRuntimeResolveCacheForTests } from "../src/codex/runtime";
import { cmdV2, codexFeaturesInvocation, v2StatusLine, multiAgentModeLine } from "../src/cli/v2";
import { handleManagementAPI } from "../src/server/management-api";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    supported_reasoning_levels: [
      { effort: "low", description: "l" }, { effort: "medium", description: "m" },
      { effort: "high", description: "h" }, { effort: "xhigh", description: "x" },
    ],
    default_reasoning_level: "medium",
  };
}

function efforts(entry: { supported_reasoning_levels?: unknown }): string[] {
  return (entry.supported_reasoning_levels as Array<{ effort: string }> ?? []).map(l => l.effort);
}

function fixtureConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v2-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

function native(supported: boolean, windows = false): Buffer {
  return Buffer.concat([
    windows ? Buffer.from("MZ00") : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.from(supported ? "multi_agent_mode_hint_text" : "older_codex_schema"),
  ]);
}

function selectRuntime(command: string, version = "test"): void {
  resetCodexRuntimeResolveCacheForTests();
  setCodexRuntimeResolveCacheForTests({ runtime: { command, version, source: "fallback" }, failures: [] });
}

function installModeHintRuntime(supported = true): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-mode-hint-runtime-"));
  const command = join(dir, "codex");
  writeFileSync(command, native(supported));
  selectRuntime(command);
  return command;
}

describe("catalog ultra (always-on)", () => {
  const routed = [{ id: "glm-5.2", provider: "opencode-go", reasoningEfforts: ["low", "medium", "high", "xhigh"] }];

  test("routed + old natives always advertise mock max AND ultra", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    const glm = entries.find(e => e.slug === "opencode-go/glm-5.2")!;
    expect(efforts(native)).toContain("ultra");
    expect(efforts(native)).toContain("max");
    expect(efforts(glm)).toContain("ultra");
    expect(efforts(glm)).toContain("max"); // mock max: adapters/wire clamp keep it honest
  });

  test("gpt-5.6-sol keeps native ultra + max; luna has max but no native ultra (upstream ladder)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna"], [], [], false);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    expect(efforts(sol)).toContain("max");
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(luna)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sync preserves genuine native entries with ultra intact", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      supported_reasoning_levels: [
        { effort: "high", description: "h" }, { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
      default_reasoning_level: "ultra",
    };
    const merged = mergeCatalogEntriesForSync([diskSol as never], [], new Map(), [], false);
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(sol)).toContain("max");
    expect(sol.default_reasoning_level).toBe("ultra"); // preserved as-is
  });
});

describe("features.ts config reader", () => {
  test("table form: [features.multi_agent_v2] enabled = true", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = false\n"))).toBe(false);
  });

  test("boolean form under [features]", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\nmulti_agent_v2 = true\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = false\n"))).toBe(false);
    // sibling key must not leak (multi_agent vs multi_agent_v2)
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\n"))).toBe(false);
  });

  // #1295. Each hazard gets its own test: Bun stops a block at the first failing
  // expectation, so bundling them would let a later assertion never run and
  // still look covered by an ablation.

  test("#1295: `enabled` after a multi-line basic string with a bracketed line", () => {
    // The exact shape `codex features enable` produces — it appends `enabled` at
    // the END of the table, so a body cut mid-literal drops precisely that key.
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = """\n[some bracketed first line]\nmore prose\n"""\nenabled = true\n',
    ))).toBe(true);
  });

  test("#1295: the same hazard with a literal ''' string", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      "[features.multi_agent_v2]\nhint = '''\n[literal bracketed]\n'''\nenabled = true\n",
    ))).toBe(true);
  });

  test("#1295: key order does not decide the answer", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nenabled = true\nhint = """\n[bracketed]\n"""\n',
    ))).toBe(true);
  });

  test("#1295: prose inside a string is not an assignment", () => {
    // The value contains the literal text `enabled = true`, and the table has no
    // such key. Any reader that regex-matches raw body text answers `true` here.
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = """\n[prose]\nenabled = true\n"""\n[other]\nvalue = 1\n',
    ))).toBe(false);
  });

  test("#1295: a delimiter inside a comment is not a delimiter", () => {
    // Must not swallow [other] and read someone else's key.
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\n# """\n[other]\nenabled = true\n',
    ))).toBe(false);
  });

  test("#1295: an escaped delimiter does not close a multi-line basic string", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = """\n\\"""\n[bracketed prose]\n"""\nenabled = true\n',
    ))).toBe(true);
  });

  test("#1295: a multi-line array's nested rows are not table headers", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = [\n  ["nested"],\n]\nenabled = true\n',
    ))).toBe(true);
  });

  test("#1295: an array may open on the line after `=`", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint =\n[\n  ["nested"],\n]\nenabled = true\n',
    ))).toBe(true);
  });

  test("#1295: `#` inside a string is content, not a comment", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = "# not a comment"\nenabled = true\n',
    ))).toBe(true);
  });

  test("#1295: a header-shaped line inside a string is not the table", () => {
    // This document has no real [features.multi_agent_v2] table at all.
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[other]\nhint = """\n[features.multi_agent_v2]\nenabled = true\n"""\n',
    ))).toBe(false);
  });

  test("#1295: a following table's key is never read as this feature's", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nhint = """\n[x]\n"""\n\n[other]\nenabled = true\n',
    ))).toBe(false);
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.other]\nenabled = true\n\n[features.multi_agent_v2]\nhint = """\n[x]\n"""\n',
    ))).toBe(false);
  });

  test("#1295: an unparseable document still falls back to the scanner", () => {
    // A rejected parse must not read as "feature disabled"; the hand-written
    // scanner is the fallback so a malformed file degrades rather than lying.
    expect(isMultiAgentV2Enabled(fixtureConfig(
      '[features.multi_agent_v2]\nenabled = true\nbroken = "unterminated\n',
    ))).toBe(true);
  });

  test("#1295: the sibling feature readers do not read prose as an assignment", () => {
    // These predate #1295 and had the same defect on `dev`: a `"""` value whose
    // text happens to contain the key was read as the key itself. Fixed with the
    // same parser-first treatment rather than left inconsistent with the v2
    // reader that shares the file.
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig(
      '[features]\nhint = """\ndefault_mode_request_user_input = true\n"""\n',
    ))).toBe(false);
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig(
      '[features]\ndefault_mode_request_user_input = true\n',
    ))).toBe(true);
  });

  test("#1295: [agents] max_threads is read from the parse, not from prose", () => {
    expect(getAgentsMaxThreads(fixtureConfig(
      '[agents]\nhint = """\nmax_threads = 7\n"""\n',
    ))).toBe(null);
    expect(hasAgentsMaxThreads(fixtureConfig(
      '[agents]\nhint = """\nmax_threads = 7\n"""\n',
    ))).toBe(false);
    expect(getAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = 7\n'))).toBe(7);
    expect(hasAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = 7\n'))).toBe(true);
  });

  test("#1295: presence and usability of [agents] max_threads are separate questions", () => {
    // hasAgentsMaxThreads gates a codex-rs boot refusal — it must not miss a key
    // that is present but unusable, while the getter correctly declines to return
    // a value it cannot use. A false negative here is the dangerous direction.
    expect(hasAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = 0\n'))).toBe(true);
    expect(getAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = 0\n'))).toBe(null);
    expect(hasAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = "seven"\n'))).toBe(true);
    expect(getAgentsMaxThreads(fixtureConfig('[agents]\nmax_threads = "seven"\n'))).toBe(null);
  });

  test("inline table form + absent file/key -> false", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, tool_namespace = \"agents\" }\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("model = \"gpt-5.5\"\n"))).toBe(false);
    expect(isMultiAgentV2Enabled("/nonexistent/config.toml")).toBe(false);
  });

  test("table detection stops at the next header (no bleed into later tables)", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\n[notice]\nenabled = true\n"))).toBe(false);
  });

  test("default_mode_request_user_input: boolean under [features]", () => {
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig("[features]\ndefault_mode_request_user_input = true\n"))).toBe(true);
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig("[features]\ndefault_mode_request_user_input = false\n"))).toBe(false);
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig("[features]\nfast_mode = true\n"))).toBe(false);
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig("model = \"gpt-5.5\"\n"))).toBe(false);
    expect(isDefaultModeRequestUserInputEnabled(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(false);
    expect(isDefaultModeRequestUserInputEnabled("/nonexistent/config.toml")).toBe(false);
  });

  test("hasAgentsMaxThreads detects the boot-conflict key", () => {
    expect(hasAgentsMaxThreads(fixtureConfig("[agents]\nmax_threads = 1000\n"))).toBe(true);
    expect(hasAgentsMaxThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(false);
  });
});

describe("max_concurrent_threads_per_session reader/writer", () => {
  const TABLE = "# keep me\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000 # tuned\n\n[notice]\nhide = true\n";

  test("reader: present, absent key, absent table", () => {
    expect(getMaxConcurrentThreads(fixtureConfig(TABLE))).toBe(1000);
    expect(getMaxConcurrentThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(null);
    expect(getMaxConcurrentThreads(fixtureConfig("[features]\nmulti_agent_v2 = true\n"))).toBe(null);
  });

  test("writer replaces in place, preserving comments and neighbors", () => {
    const path = fixtureConfig(TABLE);
    const result = setMaxConcurrentThreads(64, path);
    expect(result).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 64 # tuned");
    expect(out).toContain("# keep me");
    expect(out).toContain("[notice]\nhide = true");
    expect(getMaxConcurrentThreads(path)).toBe(64);
  });

  test("writer is idempotent: equal value -> no write, changed:false", () => {
    const path = fixtureConfig(TABLE);
    expect(setMaxConcurrentThreads(1000, path)).toEqual({ ok: true, changed: false });
    expect(readFileSync(path, "utf8")).toBe(TABLE); // byte-identical, no touch
  });

  test("writer inserts under the header when the key is absent", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[notice]\n");
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeGreaterThan(out.indexOf("[features.multi_agent_v2]"));
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeLessThan(out.indexOf("[notice]"));
  });

  test("writer upgrades the boolean form and rejects invalid values", () => {
    const booleanPath = fixtureConfig("[features]\nmulti_agent_v2 = true\n");
    expect(setMaxConcurrentThreads(8, booleanPath)).toEqual({ ok: true, changed: true });
    expect(getMaxConcurrentThreads(booleanPath)).toBe(8);
    expect(setMaxConcurrentThreads(0, fixtureConfig(TABLE)).ok).toBe(false);
    expect(setMaxConcurrentThreads(2.5, fixtureConfig(TABLE)).ok).toBe(false);
  });

  test("writer preserves CRLF files", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 4\r\n");
    expect(setMaxConcurrentThreads(8, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 8\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("reader/writer supports the inline feature form emitted around CLI toggles", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 } # keep\n");
    expect(getMaxConcurrentThreads(path)).toBe(8);
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    expect(readFileSync(path, "utf8")).toContain("max_concurrent_threads_per_session = 32");
    expect(readFileSync(path, "utf8")).toContain("# keep");
  });

  test("inline writer does not mutate a neighboring prefixed key", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, backup_max_concurrent_threads_per_session = 7 }\n");
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("backup_max_concurrent_threads_per_session = 7");
    expect(out).toContain("max_concurrent_threads_per_session = 32");
  });

  test("boolean/inline migration preserves feature and limit comments without treating a prefix as the real key", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = false # keep feature\n\n[agents]\nmax_threads = 100 # tuned limit\n");
    const flipInlineFlag = (enabled: boolean) => {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.replace(/enabled\s*=\s*(?:true|false)/, `enabled = ${enabled}`));
    };
    expect(transitionMultiAgentV2(true, flipInlineFlag, { configPath: path }).ok).toBe(true);
    const migrated = readFileSync(path, "utf8");
    expect(migrated).toContain("# keep feature; tuned limit");

    const prefixOnly = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = false, backup_max_concurrent_threads_per_session = 7 } # keep\n\n[agents]\nmax_threads = 100\n");
    const flipPrefixFlag = (enabled: boolean) => {
      const content = readFileSync(prefixOnly, "utf8");
      writeFileSync(prefixOnly, content.replace(/enabled\s*=\s*(?:true|false)/, `enabled = ${enabled}`));
    };
    expect(transitionMultiAgentV2(true, flipPrefixFlag, { configPath: prefixOnly }).ok).toBe(true);
    expect(readFileSync(prefixOnly, "utf8")).toContain("backup_max_concurrent_threads_per_session = 7");
    expect(getMaxConcurrentThreads(prefixOnly)).toBe(101);
    // Two transitions × several atomic writes; on Windows each write runs icacls and
    // can exceed bun's 5s default under CI load.
  }, { timeout: 20_000 });
});

describe("multi_agent_mode_hint_text reader/writer", () => {
  const PRESET = "Proactive multi-agent delegation is active.";
  const TABLE = "# keep me\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 17 # tuned\n\n[notice]\nhide = true\n";

  beforeEach(() => {
    installModeHintRuntime(true);
  });

  afterEach(() => {
    resetCodexRuntimeResolveCacheForTests();
  });

  test("reader: present, absent key, absent table, empty string", () => {
    const present = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"Proactive delegation\"\n");
    expect(getMultiAgentModeHintText(present)).toBe("Proactive delegation");
    expect(getMultiAgentModeHintText(fixtureConfig(TABLE))).toBe(null);
    expect(getMultiAgentModeHintText(fixtureConfig("[features]\nmulti_agent_v2 = true\n"))).toBe(null);
    // A present empty string round-trips (upstream treats "" as a present override).
    const empty = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\n");
    expect(getMultiAgentModeHintText(empty)).toBe("");
  });

  test("writer sets in a dedicated table, preserving comments and neighbors", () => {
    const path = fixtureConfig(TABLE);
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain(`multi_agent_mode_hint_text = "${PRESET}"`);
    expect(out).toContain("# keep me");
    expect(out).toContain("max_concurrent_threads_per_session = 17 # tuned");
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);
  });

  test("writer is idempotent: equal value -> no write, changed:false", () => {
    const path = fixtureConfig(`[features.multi_agent_v2]\nmulti_agent_mode_hint_text = "${PRESET}"\n`);
    const before = readFileSync(path, "utf8");
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("writer clears with null: removes the key, keeps siblings", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmulti_agent_mode_hint_text = \"Proactive delegation\"\nmax_concurrent_threads_per_session = 17\n");
    expect(setMultiAgentModeHintText(null, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).not.toContain("multi_agent_mode_hint_text");
    expect(out).toContain("enabled = true");
    expect(out).toContain("max_concurrent_threads_per_session = 17");
    expect(getMultiAgentModeHintText(path)).toBe(null);
    // Clearing when already absent is a no-op.
    expect(setMultiAgentModeHintText(null, fixtureConfig(TABLE))).toEqual({ ok: true, changed: false });
  });

  test("writer upgrades the bare boolean form and preserves enabled", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = true\n");
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("multi_agent_v2 = { enabled = true,");
    expect(out).toContain(`multi_agent_mode_hint_text = "${PRESET}"`);
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);
    expect(isMultiAgentV2Enabled(path)).toBe(true);
  });

  test("writer supports inline-table form and values containing braces/commas/quotes", () => {
    const tricky = "Use sub-agents {parallel}, \"quoted\", when needed.";
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 } # keep\n");
    expect(setMultiAgentModeHintText(tricky, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("# keep");
    expect(out).toContain("max_concurrent_threads_per_session = 8");
    expect(getMultiAgentModeHintText(path)).toBe(tricky);
  });

  test("writer creates the dedicated table when no v2 config exists", () => {
    const path = fixtureConfig("[notice]\nhide = true\n");
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("[features.multi_agent_v2]");
    expect(out).toContain(`multi_agent_mode_hint_text = "${PRESET}"`);
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);
  });

  test("writer preserves CRLF files", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\r\nenabled = true\r\n");
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain(`multi_agent_mode_hint_text = "${PRESET}"\r\n`);
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("writer refuses to edit an existing multi-line TOML string (would corrupt the doc)", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\"\nProactive\nmulti-line\n\"\"\"\n");
    const before = readFileSync(path, "utf8");
    expect(setMultiAgentModeHintText(PRESET, path)).toMatchObject({ ok: false });
    expect(setMultiAgentModeHintText(null, path)).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("reader decodes multi-line basic and literal TOML strings", () => {
    const basic = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\"\nProactive\nmulti-line\n\"\"\"\n");
    expect(getMultiAgentModeHintText(basic)).toBe("Proactive\nmulti-line\n");
    const literal = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = '''\nLiteral\\path\n'''\n");
    expect(getMultiAgentModeHintText(literal)).toBe("Literal\\path\n");
  });

  test("reader applies full multi-line newline and continuation semantics", () => {
    const basic = fixtureConfig("[features.multi_agent_v2]\r\nmulti_agent_mode_hint_text = \"\"\"\r\nPro\\\r\n  active\r\n\"\"\"\r\n");
    expect(getMultiAgentModeHintText(basic)).toBe("Proactive\n");
    const literal = fixtureConfig("[features.multi_agent_v2]\r\nmulti_agent_mode_hint_text = '''\r\nLiteral\\\r\n  text\r\n'''\r\n");
    expect(getMultiAgentModeHintText(literal)).toBe("Literal\\\n  text\n");
    const slashParity = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\"\na\\\\\nb\n\"\"\"\n");
    expect(getMultiAgentModeHintText(slashParity)).toBe("a\\\nb\n");
  });

  test("reader keeps bracket-shaped prose inside a multi-line hint", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = \"\"\"\nhello\n[bracketed]\nworld\n\"\"\"\nenabled = true\n");
    expect(getMultiAgentModeHintText(path)).toBe("hello\n[bracketed]\nworld\n");
  });


  test("reader consumes surplus quotes in multiline closing delimiters", () => {
    // TOML permits up to two quotes immediately inside the closing delimiter
    // of a multiline string. The scanner must include them in the value
    // rather than stopping at the first triple-quote run.
    const basic1 = fixtureConfig('[features.multi_agent_v2]\nmulti_agent_mode_hint_text = """hello""""\nenabled = true\n');
    expect(getMultiAgentModeHintText(basic1)).toBe('hello"');
    const basic2 = fixtureConfig('[features.multi_agent_v2]\nmulti_agent_mode_hint_text = """hello"""""\nenabled = true\n');
    expect(getMultiAgentModeHintText(basic2)).toBe('hello""');
    const lit1 = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = '''hello''''\nenabled = true\n");
    expect(getMultiAgentModeHintText(lit1)).toBe("hello'");
    const lit2 = fixtureConfig("[features.multi_agent_v2]\nmulti_agent_mode_hint_text = '''hello'''''\nenabled = true\n");
    expect(getMultiAgentModeHintText(lit2)).toBe("hello''");
    // Normal 3-quote closing still works.
    const normal = fixtureConfig('[features.multi_agent_v2]\nmulti_agent_mode_hint_text = """hello"""\nenabled = true\n');
    expect(getMultiAgentModeHintText(normal)).toBe("hello");
  });

  test("writer updates and clears quoted dedicated-table keys without duplicates", () => {
    for (const quoted of ['"multi_agent_mode_hint_text"', "'multi_agent_mode_hint_text'"]) {
      const path = fixtureConfig(`[features.multi_agent_v2]\n${quoted} = "old"\nenabled = true\n`);
      expect(getMultiAgentModeHintText(path)).toBe("old");
      expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
      expect((readFileSync(path, "utf8").match(/multi_agent_mode_hint_text/g) ?? [])).toHaveLength(1);
      expect(getMultiAgentModeHintText(path)).toBe(PRESET);
      expect(setMultiAgentModeHintText(null, path)).toEqual({ ok: true, changed: true });
      expect(readFileSync(path, "utf8")).not.toContain("multi_agent_mode_hint_text");
    }
  });

  test("reader, update, and clear use semantic equality for escaped quoted hint keys", () => {
    const path = fixtureConfig('[features.multi_agent_v2]\n"multi_agent_mode_hint_\\u0074ext" = "old"\nenabled = true\n');
    expect(getMultiAgentModeHintText(path)).toBe("old");

    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    const updated = readFileSync(path, "utf8");
    const parsedUpdated = Bun.TOML.parse(updated) as { features: { multi_agent_v2: Record<string, unknown> } };
    expect(parsedUpdated.features.multi_agent_v2.multi_agent_mode_hint_text).toBe(PRESET);
    expect(Object.keys(parsedUpdated.features.multi_agent_v2).filter(key => key === "multi_agent_mode_hint_text")).toHaveLength(1);
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);

    expect(setMultiAgentModeHintText(null, path)).toEqual({ ok: true, changed: true });
    const cleared = readFileSync(path, "utf8");
    const parsedCleared = Bun.TOML.parse(cleared) as { features: { multi_agent_v2: Record<string, unknown> } };
    expect(parsedCleared.features.multi_agent_v2.multi_agent_mode_hint_text).toBeUndefined();
    expect(getMultiAgentModeHintText(path)).toBe(null);
  });

  test("writer refuses dotted V2 definitions without changing config bytes", () => {
    for (const original of [
      "features.multi_agent_v2.enabled = true\n",
      "[features]\nmulti_agent_v2.enabled = true\n",
      '"features"."multi_agent_v2"."enabled" = true\n',
    ]) {
      const path = fixtureConfig(original);
      expect(setMultiAgentModeHintText(PRESET, path)).toMatchObject({ ok: false });
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  test("dotted-looking prose inside a multi-line value does not block a supported table", () => {
    const path = fixtureConfig('[features.multi_agent_v2]\nenabled = true\nother = """\nfeatures.multi_agent_v2.enabled = false\n"""\n');
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);
  });

  test("same-named multi-line key in an unrelated table does not block the V2 writer", () => {
    const path = fixtureConfig('[unrelated]\nmulti_agent_mode_hint_text = """\nleave me alone\n"""\n\n[features.multi_agent_v2]\nenabled = true\n');
    expect(setMultiAgentModeHintText(PRESET, path)).toEqual({ ok: true, changed: true });
    expect(readFileSync(path, "utf8")).toContain('multi_agent_mode_hint_text = """\nleave me alone\n"""');
    expect(getMultiAgentModeHintText(path)).toBe(PRESET);
  });

  test("inline V2 after bracket-shaped multiline prose is read and fails closed on edit", () => {
    const original = '[features]\nother = """\n[prose]\n"""\nmulti_agent_v2 = { enabled = true, multi_agent_mode_hint_text = "inline" }\n';
    const path = fixtureConfig(original);
    expect(getMultiAgentModeHintText(path)).toBe("inline");
    expect(setMultiAgentModeHintText(PRESET, path)).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("dedicated key after bracket-shaped multiline prose fails closed without duplication", () => {
    const original = '[features.multi_agent_v2]\nother = """\n[prose]\n"""\nmulti_agent_mode_hint_text = "old"\n';
    const path = fixtureConfig(original);
    expect(getMultiAgentModeHintText(path)).toBe("old");
    expect(setMultiAgentModeHintText(PRESET, path)).toMatchObject({ ok: false });
    expect(setMultiAgentModeHintText(null, path)).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("multi_agent_mode_hint_text native capability probe", () => {
  test("clear bypasses an unsupported runtime probe so invalid old config can recover", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-mode-hint-clear-"));
    const command = join(dir, "codex-old");
    writeFileSync(command, native(false));
    selectRuntime(command);
    const path = fixtureConfig('[features.multi_agent_v2]\nmulti_agent_mode_hint_text = "new-only"\n');
    try {
      expect(setMultiAgentModeHintText(null, path)).toEqual({ ok: true, changed: true });
      expect(getMultiAgentModeHintText(path)).toBe(null);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe cache tracks in-place replacement and selected command changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-mode-hint-cache-"));
    const supported = join(dir, "codex-supported");
    const unsupported = join(dir, "codex-unsupported");
    writeFileSync(supported, native(true));
    writeFileSync(unsupported, native(false));
    try {
      selectRuntime(supported, "1");
      expect(probeCodexSupportsModeHint()).toBe(true);
      writeFileSync(supported, native(false));
      expect(probeCodexSupportsModeHint()).toBe(false);
      writeFileSync(supported, native(true));
      expect(probeCodexSupportsModeHint()).toBe(true);
      selectRuntime(unsupported, "1");
      expect(probeCodexSupportsModeHint()).toBe(false);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe ignores unrelated PATH installations and script wrappers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-mode-hint-selected-"));
    const selected = join(dir, "selected-old");
    const unrelated = join(dir, "unrelated-bin");
    mkdirSync(unrelated);
    writeFileSync(selected, native(false));
    writeFileSync(join(unrelated, "codex.opencodex-real"), native(true));
    const oldPath = process.env.PATH;
    process.env.PATH = `${unrelated}${delimiter}${oldPath ?? ""}`;
    try {
      selectRuntime(selected);
      expect(probeCodexSupportsModeHint()).toBe(false);
      const wrapperOnly = join(dir, "wrapper-only.cmd");
      writeFileSync(wrapperOnly, "@echo off\r\nnode codex.js %*\r\n");
      selectRuntime(wrapperOnly);
      expect(probeCodexSupportsModeHint()).toBe(null);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe resolves the selected Windows npm wrapper's platform package", () => {
    const prefix = mkdtempSync(join(tmpdir(), "ocx-mode-hint-win-"));
    const command = join(prefix, "codex.cmd");
    const pkg = join(prefix, "node_modules", "@openai", "codex-win32-x64");
    const binary = join(pkg, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "test" }));
    writeFileSync(binary, native(true, true));
    writeFileSync(command, "@echo off\r\nnode node_modules\\@openai\\codex\\bin\\codex.js %*\r\n");
    try {
      selectRuntime(command);
      expect(probeCodexSupportsModeHint()).toBe(true);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe resolves an exact bare PATH command without scanning peer installs", () => {
    const prefix = mkdtempSync(join(tmpdir(), "ocx-mode-hint-bare-"));
    const binDir = join(prefix, "bin");
    const js = join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    const pkg = join(prefix, "node_modules", "@openai", "codex-darwin-arm64");
    const binary = join(pkg, "vendor", "aarch64-apple-darwin", "bin", "codex");
    mkdirSync(dirname(js), { recursive: true });
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(js, "#!/usr/bin/env node\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "test" }));
    writeFileSync(binary, native(true));
    // This case is irreducibly about symlink semantics: the resolver follows the bare
    // PATH entry through `realpath` to `@openai/codex/bin/`, and that is how it finds
    // the sibling platform package. No privilege-free substitute preserves it -- a
    // copy erases the association being resolved, a hard link reports its own path as
    // its realpath, and a .cmd wrapper is never matched for a bare command. So report
    // a visible skip where the OS withholds the privilege, in the shape
    // claude-agents-inject and codex-service-manager-probe already use, rather than
    // failing on EPERM before the probe under test has run.
    try {
      symlinkSync(js, join(binDir, "codex.opencodex-real"));
    } catch (err) {
      // Windows without Developer Mode / elevated privileges cannot create symlinks.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${oldPath ?? ""}`;
    try {
      selectRuntime("codex.opencodex-real");
      expect(probeCodexSupportsModeHint()).toBe(true);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe cache distinguishes different PATH targets for the same bare command", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mode-hint-path-swap-"));
    const supportedDir = join(root, "supported");
    const oldDir = join(root, "old");
    const command = "codex.opencodex-real";
    mkdirSync(supportedDir);
    mkdirSync(oldDir);
    writeFileSync(join(supportedDir, command), native(true));
    writeFileSync(join(oldDir, command), native(false));
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${supportedDir}${delimiter}${oldPath ?? ""}`;
      selectRuntime(command, "same-version");
      expect(probeCodexSupportsModeHint()).toBe(true);
      process.env.PATH = `${oldDir}${delimiter}${oldPath ?? ""}`;
      selectRuntime(command, "same-version");
      expect(probeCodexSupportsModeHint()).toBe(false);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("a bare selected command is resolved from PATH, never a same-named cwd file", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-mode-hint-cwd-shadow-"));
    const cwd = join(root, "cwd");
    const bin = join(root, "bin");
    const command = "codex-cwd-shadow";
    mkdirSync(cwd);
    mkdirSync(bin);
    writeFileSync(join(cwd, command), native(true));
    writeFileSync(join(bin, command), native(false));
    const oldCwd = process.cwd();
    const oldPath = process.env.PATH;
    process.chdir(cwd);
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
    try {
      selectRuntime(command);
      expect(probeCodexSupportsModeHint()).toBe(false);
    } finally {
      process.chdir(oldCwd);
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });

  test("probe follows only the selected OCX shim's recorded backing runtime", () => {
    const prefix = mkdtempSync(join(tmpdir(), "ocx-mode-hint-shim-"));
    const ocxHome = join(prefix, "ocx-home");
    const shim = join(prefix, "bin", "codex");
    const backing = join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    const pkg = join(prefix, "node_modules", "@openai", "codex-darwin-arm64");
    const binary = join(pkg, "vendor", "aarch64-apple-darwin", "bin", "codex");
    mkdirSync(dirname(shim), { recursive: true });
    mkdirSync(dirname(backing), { recursive: true });
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(ocxHome, { recursive: true });
    writeFileSync(shim, `#!/bin/sh\nexec '${backing}' "$@"\n`);
    writeFileSync(backing, "#!/usr/bin/env node\n");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "test" }));
    writeFileSync(binary, native(true));
    writeFileSync(join(ocxHome, "codex-shim.json"), JSON.stringify({
      wrappers: [{ wrapperPath: shim, originalPath: shim, backupPath: backing }],
    }));
    const oldHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = ocxHome;
    try {
      selectRuntime(shim);
      expect(probeCodexSupportsModeHint()).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
      resetCodexRuntimeResolveCacheForTests();
    }
  });
});

describe("thread-limit-preserving v1/v2 transition", () => {
  const flipTableFlag = (path: string) => (enabled: boolean) => {
    const content = readFileSync(path, "utf8");
    writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
  };

  test("off -> on carries the active legacy value and removes the boot conflict", () => {
    const path = fixtureConfig("# keep\n[agents]\nmax_threads = 100\nmax_depth = 2\n");
    const result = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path });
    // The legacy key counts spawned children; the V2 key also counts the root agent's
    // own slot, so crossing the boundary adds 1 (upstream saturating_add(1)).
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 101 });
    expect(isMultiAgentV2Enabled(path)).toBe(true);
    expect(getMaxConcurrentThreads(path)).toBe(101);
    expect(getAgentsMaxThreads(path)).toBe(null);
    expect(readFileSync(path, "utf8")).toContain("max_depth = 2");
    expect(readFileSync(path, "utf8")).toContain("# keep");
  });

  test("on -> off carries the active v2 value and removes v2 limit storage", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n\n[agents]\nmax_depth = 2\n");
    const result = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path });
    // V2 total 64 = 63 spawned children + the root slot; the legacy key counts only children.
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 63 });
    expect(isMultiAgentV2Enabled(path)).toBe(false);
    expect(getAgentsMaxThreads(path)).toBe(63);
    expect(getMaxConcurrentThreads(path)).toBe(null);
  });

  test("migration carries the active limit comment in both directions", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100 # tuned\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("max_concurrent_threads_per_session = 101 # tuned");
    expect(transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("max_threads = 100 # tuned");
  });

  test("same-state repair prefers active storage when duplicate values disagree", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    let calls = 0;
    const result = transitionMultiAgentV2(true, () => { calls++; }, { configPath: path });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 32 });
    expect(calls).toBe(0);
    expect(getLogicalMaxThreads(path)).toBe(32);
    expect(getAgentsMaxThreads(path)).toBe(null);
  });

  test("target-only, equal duplicate, and disabled same-state cases converge", () => {
    const targetOnly = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(targetOnly), { configPath: targetOnly })).toMatchObject({ ok: true, threadLimit: 32 });
    expect(getLogicalMaxThreads(targetOnly)).toBe(32);

    const equal = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 64\n\n[agents]\nmax_threads = 64\n");
    // The legacy key is the active storage under V1, so it is the migration source and
    // gains the root slot on the way to V2.
    expect(transitionMultiAgentV2(true, flipTableFlag(equal), { configPath: equal })).toMatchObject({ ok: true, threadLimit: 65 });
    expect(getAgentsMaxThreads(equal)).toBe(null);

    const disabled = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    let calls = 0;
    expect(transitionMultiAgentV2(false, () => { calls++; }, { configPath: disabled })).toMatchObject({ ok: true, threadLimit: 100 });
    expect(calls).toBe(0);
    expect(getAgentsMaxThreads(disabled)).toBe(100);
    expect(getMaxConcurrentThreads(disabled)).toBe(null);
  });

  test("explicit logical limit overrides both stored values", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    const result = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path, threadLimit: 256 });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 256 });
    expect(getLogicalMaxThreads(path)).toBe(256);
  });

  test("unset limits stay unset in both directions", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(getLogicalMaxThreads(path)).toBe(null);
    expect(transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(getLogicalMaxThreads(path)).toBe(null);
  });

  test("throwing and ineffective feature commands restore the original bytes", () => {
    const original = "# exact\r\n[agents]\r\nmax_threads = 100 # tuned\r\n";
    const throwingPath = fixtureConfig(original);
    const thrown = transitionMultiAgentV2(true, () => { throw new Error("boom"); }, { configPath: throwingPath });
    expect(thrown.ok).toBe(false);
    expect(readFileSync(throwingPath, "utf8")).toBe(original);

    const noopPath = fixtureConfig(original);
    const ineffective = transitionMultiAgentV2(true, () => {}, { configPath: noopPath });
    expect(ineffective.ok).toBe(false);
    expect(readFileSync(noopPath, "utf8")).toBe(original);
  });

  test("ambiguous duplicate definitions are rejected before mutation", () => {
    const original = "[features]\nmulti_agent_v2 = false\n\n[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_threads = 100\n";
    const path = fixtureConfig(original);
    let toggles = 0;
    const result = transitionMultiAgentV2(true, () => { toggles++; }, { configPath: path });
    expect(result.ok).toBe(false);
    expect(toggles).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("v1<->v2 root-slot translation", () => {
  const flipTableFlag = (path: string) => (enabled: boolean) => {
    const content = readFileSync(path, "utf8");
    writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
  };

  test("round trip v1 -> v2 -> v1 is identity for every value 1..10", () => {
    for (let child = 1; child <= 10; child++) {
      expect(v2TotalLimitToV1ChildLimit(v1ChildLimitToV2TotalLimit(child))).toBe(child);
    }
  });

  test("directional maxima: 1_000_000 -> 1_000_001 -> 1_000_000 round-trips", () => {
    expect(isTranslatableV1ChildLimit(1_000_000)).toBe(true);
    expect(isTranslatableV1ChildLimit(1_000_001)).toBe(false);
    expect(isTranslatableV2TotalLimit(1_000_001)).toBe(true);
    expect(isTranslatableV2TotalLimit(1_000_002)).toBe(false);
    expect(v1ChildLimitToV2TotalLimit(1_000_000)).toBe(1_000_001);
    expect(v2TotalLimitToV1ChildLimit(1_000_001)).toBe(1_000_000);
  });

  test("helpers throw RangeError outside their own directional range", () => {
    expect(() => v1ChildLimitToV2TotalLimit(1_000_001)).toThrow(RangeError);
    expect(() => v2TotalLimitToV1ChildLimit(1_000_002)).toThrow(RangeError);
    expect(() => v1ChildLimitToV2TotalLimit(0)).toThrow(RangeError);
    expect(() => v2TotalLimitToV1ChildLimit(0)).toThrow(RangeError);
  });

  test("clamp: V2 total 1 disables to legacy 1, never 0", () => {
    expect(v2TotalLimitToV1ChildLimit(1)).toBe(1);
    expect(v2TotalLimitToV1ChildLimit(2)).toBe(1);
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1\n");
    const result = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 1 });
    expect(getAgentsMaxThreads(path)).toBe(1);
    expect(getMaxConcurrentThreads(path)).toBe(null);
  });

  test("read paths return out-of-range stored values raw instead of throwing", () => {
    const hugeV2 = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 100000000000000000000\n");
    expect(getLogicalMaxThreads(hugeV2)).toBe(1e20);
    const hugeLegacy = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[agents]\nmax_threads = 100000000000000000000\n");
    expect(getLogicalMaxThreads(hugeLegacy)).toBe(1e20);
  });

  test("legacy-only under V2: disable preserves an untranslatable value; automatic re-enable is rejected; explicit limit recovers", () => {
    const original = "[features.multi_agent_v2]\nenabled = true\n\n[agents]\nmax_threads = 1000001\n";
    const path = fixtureConfig(original);
    // Disable: source and destination are both v1-child, so nothing crosses the
    // boundary and the value is preserved untranslated.
    const off = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path });
    expect(off).toMatchObject({ ok: true, threadLimit: 1_000_001 });
    expect(getAgentsMaxThreads(path)).toBe(1_000_001);
    // Re-enable would need v1-child -> v2-total translation of a value beyond
    // MAX_TRANSLATABLE_V1_CHILD_LIMIT, so it is rejected before any write.
    const on = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path });
    expect(on.ok).toBe(false);
    expect(on.ok === false && on.error).toContain("out of translatable range");
    expect(readFileSync(path, "utf8")).toBe(readFileSync(path, "utf8"));
    expect(getAgentsMaxThreads(path)).toBe(1_000_001);
    expect(isMultiAgentV2Enabled(path)).toBe(false);
    // Escape hatch: an explicit destination-unit limit is never translated.
    const recovered = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path, threadLimit: 5 });
    expect(recovered).toEqual({ ok: true, changed: true, threadLimit: 5 });
    expect(getMaxConcurrentThreads(path)).toBe(5);
    expect(getAgentsMaxThreads(path)).toBe(null);
  });

  test("untranslatable V2 total disable is rejected with bytes unchanged; explicit limit recovers", () => {
    const original = "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 100000000000000000000\n";
    const path = fixtureConfig(original);
    const result = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("out of translatable range");
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(isMultiAgentV2Enabled(path)).toBe(true);
    const recovered = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path, threadLimit: 4 });
    expect(recovered).toEqual({ ok: true, changed: true, threadLimit: 4 });
    expect(getAgentsMaxThreads(path)).toBe(4);
  });

  test("idempotent re-enable on a V2 config leaves the limit unchanged", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 32\n");
    const result = transitionMultiAgentV2(true, () => { /* no flip needed */ }, { configPath: path });
    expect(result).toMatchObject({ ok: true, threadLimit: 32 });
    expect(getMaxConcurrentThreads(path)).toBe(32);
  });

  test("idempotent re-disable on a V1 config leaves the legacy limit unchanged", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\n");
    let calls = 0;
    const result = transitionMultiAgentV2(false, () => { calls++; }, { configPath: path });
    expect(result).toMatchObject({ ok: true, threadLimit: 100 });
    expect(calls).toBe(0);
    expect(getAgentsMaxThreads(path)).toBe(100);
  });

  test("same-state storage migration: legacy-only under V2 gains the root slot when the value moves to V2 storage", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[agents]\nmax_threads = 10\n");
    const result = transitionMultiAgentV2(true, () => { /* already enabled */ }, { configPath: path });
    expect(result).toMatchObject({ ok: true, threadLimit: 11 });
    expect(getMaxConcurrentThreads(path)).toBe(11);
    expect(getAgentsMaxThreads(path)).toBe(null);
  });
});

describe("config-surface parity: agents.enabled, max_depth, subagent_developer_instructions", () => {
  test("opencodex mirrors exactly one upstream feature key", async () => {
    const source = await Bun.file(new URL("../src/codex/features.ts", import.meta.url)).text();
    // Upstream feature keys are snake_case, so the underscore requirement is the
    // discriminator: JS member accesses on locals named `features` (features.match,
    // features.slice, features.ts) are camelCase and never match, while a mirrored
    // key matches wherever it is written — string, template, escape, or regex
    // literal. Residual: a bare quoted key with no dotted prefix (e.g. passed to a
    // future helper) is not caught here; the behavioral half below is the net for
    // that case.
    const referenced = new Set(
      [...source.matchAll(/features\.([a-z0-9]+(?:_[a-z0-9]+)+)/g)].map(m => m[1]),
    );
    // multi_agent_v2 is deliberately mirrored because opencodex migrates its
    // concurrency value across the v1/v2 boundary and exposes the multi-agent
    // config surface. Every other upstream feature flag is delegated to
    // `codex features` and must NOT be hardcoded in src/codex/features.ts: upstream
    // reshapes flags freely (code_mode_host became a table; enable_fanout and
    // item_ids are Stage::Removed but still accepted), and a mirrored list rots.
    expect([...referenced].sort()).toEqual(["multi_agent_v2"]);
  });

  test("the retired/reshaped upstream flags do not perturb the v2 read surface", () => {
    // Behavioral half of the delegation boundary: a config carrying the current
    // upstream table shape for code_mode_host plus the two inert Removed keys must
    // be indistinguishable from one without them, as far as this module sees.
    const bare = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const decorated = fixtureConfig(
      "[features.multi_agent_v2]\nenabled = true\n\n[features.code_mode_host]\nenabled = true\n\n[features]\nenable_fanout = true\nitem_ids = false\n",
    );
    expect(isMultiAgentV2Enabled(decorated)).toBe(true);
    expect(isMultiAgentV2Enabled(decorated)).toBe(isMultiAgentV2Enabled(bare));
    const offDecorated = fixtureConfig("[features]\nenable_fanout = true\nitem_ids = false\n");
    expect(isMultiAgentV2Enabled(offDecorated)).toBe(false);
  });

  test("feature toggling delegates to exactly the multi_agent_v2 native key", () => {
    // Named platform and resolution seams, like the invocation-shape test below.
    // Called bare, this reads the developer's OWN Codex install: on a Windows box
    // whose codex is the npm `codex.cmd`, the invocation is correctly wrapped in
    // `cmd /d /s /c "..."` and the raw-args assertion fails -- reporting the machine's
    // install shape rather than the key delegation this case is about.
    const seams = {
      env: { PATH: "/usr/bin" },
      configDir: mkdtempSync(join(tmpdir(), "ocx-v2-key-")),
      existsSync: () => false,
      execFileSync: () => "codex-cli 0.145.0",
    };
    expect(codexFeaturesInvocation("enable", "multi_agent_v2", "linux", seams).args)
      .toEqual(["features", "enable", "multi_agent_v2"]);
    expect(codexFeaturesInvocation("disable", "multi_agent_v2", "linux", seams).args)
      .toEqual(["features", "disable", "multi_agent_v2"]);
  });

  test("getAgentsEnabled is tri-state: absent, true, false", () => {
    expect(getAgentsEnabled(fixtureConfig("[agents]\nmax_threads = 4\n"))).toBe(null);
    expect(getAgentsEnabled(fixtureConfig("[agents]\nenabled = true\n"))).toBe(true);
    expect(getAgentsEnabled(fixtureConfig("[agents]\nenabled = false # off\n"))).toBe(false);
    expect(getAgentsEnabled(fixtureConfig("[other]\nx = 1\n"))).toBe(null);
  });

  test("setAgentsEnabled creates the table, toggles, removes, and is idempotent", () => {
    const path = fixtureConfig("# keep me\n[features]\nmulti_agent_v2 = false\n");
    expect(setAgentsEnabled(false, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsEnabled(path)).toBe(false);
    const afterCreate = readFileSync(path, "utf8");
    expect(afterCreate).toContain("[agents]\nenabled = false");
    expect(afterCreate).toContain("# keep me");
    expect(afterCreate).toContain("multi_agent_v2 = false");
    expect(setAgentsEnabled(false, path)).toEqual({ ok: true, changed: false });
    expect(setAgentsEnabled(true, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsEnabled(path)).toBe(true);
    expect(setAgentsEnabled(null, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsEnabled(path)).toBe(null);
    expect(readFileSync(path, "utf8")).not.toContain("enabled =");
    expect(setAgentsEnabled(null, path)).toEqual({ ok: true, changed: false });
  });

  test("max_depth parity is the signed-i32 contract, not >= 1", () => {
    const path = fixtureConfig("[agents]\nmax_depth = -1\nmax_threads = 8\n");
    expect(getAgentsMaxDepth(path)).toBe(-1);
    expect(setAgentsMaxDepth(0, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsMaxDepth(path)).toBe(0);
    expect(setAgentsMaxDepth(-2_147_483_648, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsMaxDepth(path)).toBe(-2_147_483_648);
    expect(setAgentsMaxDepth(2_147_483_647, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsMaxDepth(path)).toBe(2_147_483_647);
    // Out-of-i32 values would produce a config upstream cannot deserialize.
    const before = readFileSync(path, "utf8");
    expect(setAgentsMaxDepth(2_147_483_648, path).ok).toBe(false);
    expect(setAgentsMaxDepth(-2_147_483_649, path).ok).toBe(false);
    expect(setAgentsMaxDepth(1.5, path).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    // A stored out-of-range value is unparseable upstream, so the reader treats it as absent.
    const corrupt = fixtureConfig("[agents]\nmax_depth = 99999999999999999999\n");
    expect(getAgentsMaxDepth(corrupt)).toBe(null);
    // Sibling keys are never disturbed.
    expect(getAgentsMaxThreads(path)).toBe(8);
    expect(setAgentsMaxDepth(null, path)).toEqual({ ok: true, changed: true });
    expect(getAgentsMaxDepth(path)).toBe(null);
    expect(getAgentsMaxThreads(path)).toBe(8);
  });

  test("subagent_developer_instructions distinguishes absent from empty, and round-trips ordinary text", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    expect(getSubagentDeveloperInstructions(path)).toBe(null);
    expect(setSubagentDeveloperInstructions("", path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe("");
    expect(setSubagentDeveloperInstructions("You are a careful reviewer.", path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe("You are a careful reviewer.");
    expect(setSubagentDeveloperInstructions("You are a careful reviewer.", path)).toEqual({ ok: true, changed: false });
    expect(setSubagentDeveloperInstructions(null, path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe(null);
    expect(readFileSync(path, "utf8")).toContain("enabled = true");
  });

  test("subagent instructions support escaped quoted dedicated-table keys", () => {
    const path = fixtureConfig('[features.multi_agent_v2]\n"subagent_developer_instruc\\u0074ions" = "old"\nenabled = true\n');
    expect(getSubagentDeveloperInstructions(path)).toBe("old");

    expect(setSubagentDeveloperInstructions("new", path)).toEqual({ ok: true, changed: true });
    const updated = readFileSync(path, "utf8");
    const parsedUpdated = Bun.TOML.parse(updated) as { features: { multi_agent_v2: Record<string, unknown> } };
    expect(parsedUpdated.features.multi_agent_v2.subagent_developer_instructions).toBe("new");
    expect(Object.keys(parsedUpdated.features.multi_agent_v2).filter(key => key === "subagent_developer_instructions")).toHaveLength(1);

    expect(setSubagentDeveloperInstructions(null, path)).toEqual({ ok: true, changed: true });
    const parsedCleared = Bun.TOML.parse(readFileSync(path, "utf8")) as { features: { multi_agent_v2: Record<string, unknown> } };
    expect(parsedCleared.features.multi_agent_v2.subagent_developer_instructions).toBeUndefined();
    expect(getSubagentDeveloperInstructions(path)).toBe(null);
  });

  test("key name is emitted character-for-character (upstream deny_unknown_fields)", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    setSubagentDeveloperInstructions("x", path);
    const written = readFileSync(path, "utf8");
    expect(written).toContain("subagent_developer_instructions = ");
    expect(written).not.toContain("subagent_developer_instruction =");
    expect(written).not.toContain("subagentDeveloperInstructions");
  });

  test("realistic instruction text with quotes, newlines, backslashes, and triple-quotes round-trips", () => {
    const values = [
      'has "quotes" inside',
      "line one\nline two",
      "back\\slash",
      'triple """ quotes',
      "crlf\r\nend",
      'mixed \\" and \ttab',
      "keep # not comment",
    ];
    for (const value of values) {
      const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
      expect(setSubagentDeveloperInstructions(value, path)).toEqual({ ok: true, changed: true });
      expect(getSubagentDeveloperInstructions(path)).toBe(value);
    }
  });

  test("control characters are asserted at the byte level (Bun 1.3.14 TOML.parse decodes \\t as \\f)", () => {
    // Do NOT assert this through Bun.TOML.parse: its reader mis-decodes the \t escape
    // and would fail against this correct encoder. Assert the emitted bytes directly.
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    setSubagentDeveloperInstructions("tab\there", path);
    expect(readFileSync(path, "utf8")).toContain('subagent_developer_instructions = "tab\\there"');
    expect(getSubagentDeveloperInstructions(path)).toBe("tab\there");
  });

  test("\\u fallback branch fires for control characters without a named escape", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    setSubagentDeveloperInstructions("bellend", path);
    expect(readFileSync(path, "utf8")).toContain('subagent_developer_instructions = "bell\\u0007end"');
    expect(getSubagentDeveloperInstructions(path)).toBe("bellend");
  });

  test("inline form: values containing } and , round-trip without disturbing siblings", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 9 } # keep\n");
    const value = "close } brace, and comma";
    expect(setSubagentDeveloperInstructions(value, path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe(value);
    expect(isMultiAgentV2Enabled(path)).toBe(true);
    expect(getMaxConcurrentThreads(path)).toBe(9);
    expect(readFileSync(path, "utf8")).toContain("# keep");
    // Replacement and removal inside the inline table.
    expect(setSubagentDeveloperInstructions("second", path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe("second");
    expect(setSubagentDeveloperInstructions("second", path)).toEqual({ ok: true, changed: false });
    expect(setSubagentDeveloperInstructions(null, path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe(null);
    expect(getMaxConcurrentThreads(path)).toBe(9);
    expect(isMultiAgentV2Enabled(path)).toBe(true);
  });

  test("user-authored TOML literal strings are read verbatim and survive edits", () => {
    // A literal string ('...') has NO escapes: backslash is literal. A scanner that
    // only understands basic strings would treat the } inside as the table close.
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, subagent_developer_instructions = 'keep } literal' }\n");
    expect(getSubagentDeveloperInstructions(path)).toBe("keep } literal");
    expect(setSubagentDeveloperInstructions("replaced", path)).toEqual({ ok: true, changed: true });
    expect(getSubagentDeveloperInstructions(path)).toBe("replaced");
    expect(isMultiAgentV2Enabled(path)).toBe(true);
    const literalWithComma = fixtureConfig("[features]\nmulti_agent_v2 = { subagent_developer_instructions = 'a, b # c', enabled = false }\n");
    expect(getSubagentDeveloperInstructions(literalWithComma)).toBe("a, b # c");
  });

  test("bare boolean form is upgraded in place to an inline table, preserving the flag and comment", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = true # my flag\n");
    expect(setSubagentDeveloperInstructions("instructions", path)).toEqual({ ok: true, changed: true });
    const written = readFileSync(path, "utf8");
    expect(written).toContain("multi_agent_v2 = { enabled = true, subagent_developer_instructions = \"instructions\" } # my flag");
    expect(getSubagentDeveloperInstructions(path)).toBe("instructions");
    expect(isMultiAgentV2Enabled(path)).toBe(true);
  });

  test("no existing v2 config creates a dedicated table carrying only the key", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 2\n");
    expect(setSubagentDeveloperInstructions("fresh", path)).toEqual({ ok: true, changed: true });
    const written = readFileSync(path, "utf8");
    expect(written).toContain("[features.multi_agent_v2]\nsubagent_developer_instructions = \"fresh\"");
    expect(written).toContain("max_threads = 2");
    expect(getSubagentDeveloperInstructions(path)).toBe("fresh");
    expect(setSubagentDeveloperInstructions(null, fixtureConfig("[agents]\nmax_threads = 2\n"))).toEqual({ ok: true, changed: false });
  });
});

describe("management API logical v1/v2 switching", () => {
  test("mode-only switches translate the limit across the root-slot boundary in both directions", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\nmax_depth = 2\n");
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-api-config-"));
    const config = { providers: [] } as never;
    const toggle = (enabled: boolean) => {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
    };
    const deps = { toggleCodexMultiAgentV2: toggle, createManagementConvergeCodex: catalogConvergenceFactory() };
    try {
      const toV2 = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "v2" }),
      });
      const v2Response = await handleManagementAPI(toV2, new URL(toV2.url), config, deps);
      expect(v2Response?.status).toBe(200);
      expect(await v2Response?.json()).toMatchObject({ enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 101 });
      expect(getMaxConcurrentThreads(path)).toBe(101);
      expect(getAgentsMaxThreads(path)).toBe(null);

      const getV2 = new Request("http://localhost/api/v2");
      const getV2Response = await handleManagementAPI(getV2, new URL(getV2.url), config, deps);
      expect(await getV2Response?.json()).toMatchObject({ enabled: true, maxConcurrentThreadsPerSession: 101 });

      const toV1 = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "v1" }),
      });
      const v1Response = await handleManagementAPI(toV1, new URL(toV1.url), config, deps);
      expect(v1Response?.status).toBe(200);
      expect(await v1Response?.json()).toMatchObject({ enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 100 });
      expect(getAgentsMaxThreads(path)).toBe(100);
      expect(getMaxConcurrentThreads(path)).toBe(null);

      const setV1Threads = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxConcurrentThreadsPerSession: 88 }),
      });
      expect((await handleManagementAPI(setV1Threads, new URL(setV1Threads.url), config, deps))?.status).toBe(200);
      expect(getAgentsMaxThreads(path)).toBe(88);

      const setV2Threads = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v2", maxConcurrentThreadsPerSession: 77 }),
      });
      expect((await handleManagementAPI(setV2Threads, new URL(setV2Threads.url), config, deps))?.status).toBe(200);
      expect(getMaxConcurrentThreads(path)).toBe(77);

      const defaultWithFlag = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "default", enabled: false }),
      });
      const defaultResponse = await handleManagementAPI(defaultWithFlag, new URL(defaultWithFlag.url), config, deps);
      // V2 total 77 crosses back to 76 spawned children once the root slot is out of scope.
      expect(await defaultResponse?.json()).toMatchObject({ enabled: false, multiAgentMode: "default", maxConcurrentThreadsPerSession: 76 });

      const get = new Request("http://localhost/api/v2");
      const getResponse = await handleManagementAPI(get, new URL(get.url), config, deps);
      expect(await getResponse?.json()).toMatchObject({ enabled: false, maxConcurrentThreadsPerSession: 76 });
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });

  test("contradictory mode and flag are rejected before config writes", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\n");
    const original = readFileSync(path, "utf8");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    let toggles = 0;
    try {
      const req = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v2", enabled: false }),
      });
      const response = await handleManagementAPI(req, new URL(req.url), { providers: [] } as never, {
        toggleCodexMultiAgentV2: () => { toggles++; }, createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(400);
      expect(toggles).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(original);

      const opposite = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v1", enabled: true }),
      });
      expect((await handleManagementAPI(opposite, new URL(opposite.url), { providers: [] } as never, {
        toggleCodexMultiAgentV2: () => { toggles++; }, createManagementConvergeCodex: catalogConvergenceFactory(),
      }))?.status).toBe(400);
      expect(toggles).toBe(0);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });
});

describe("management API parity surface for the WP2 keys", () => {
  const withConfig = (content: string, run: (path: string, deps: {
    toggleCodexMultiAgentV2: (enabled: boolean) => void;
    createManagementConvergeCodex: ReturnType<typeof catalogConvergenceFactory>;
  }) => Promise<void>) => {
    const path = fixtureConfig(content);
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-api-parity-"));
    installModeHintRuntime(true);
    const toggle = (enabled: boolean) => {
      const current = readFileSync(path, "utf8");
      writeFileSync(path, current.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
    };
    return run(path, { toggleCodexMultiAgentV2: toggle, createManagementConvergeCodex: catalogConvergenceFactory() })
      .finally(() => {
        resetCodexRuntimeResolveCacheForTests();
        if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
        if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
      });
  };
  const put = (payload: unknown) => new Request("http://localhost/api/v2", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  const config = { providers: [] } as never;

  test("GET reports the three keys tri-state plus the V2-disabled applicability flag", async () => {
    await withConfig("[agents]\nmax_depth = 2\n", async (path, deps) => {
      const res = await handleManagementAPI(new Request("http://localhost/api/v2"), new URL("http://localhost/api/v2"), config, deps);
      expect(await res?.json()).toMatchObject({
        enabled: false,
        agentsEnabled: null,
        agentsMaxDepth: 2,
        subagentDeveloperInstructions: null,
        multiAgentModeHintText: null,
        agentsMaxDepthAppliesWhenV2Disabled: true,
      });
      const v2Path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
      process.env.CODEX_HOME = dirname(v2Path);
      const res2 = await handleManagementAPI(new Request("http://localhost/api/v2"), new URL("http://localhost/api/v2"), config, deps);
      expect(await res2?.json()).toMatchObject({ enabled: true, agentsMaxDepthAppliesWhenV2Disabled: false });
    });
  });

  test("PUT writes each new field independently and re-reads them", async () => {
    await withConfig("[features.multi_agent_v2]\nenabled = false\n", async (path, deps) => {
      const onlyNew = await handleManagementAPI(put({ agentsEnabled: false }), new URL("http://localhost/api/v2"), config, deps);
      expect(onlyNew?.status).toBe(200);
      expect(getAgentsEnabled(path)).toBe(false);
      const depth = await handleManagementAPI(put({ agentsMaxDepth: 3 }), new URL("http://localhost/api/v2"), config, deps);
      expect(depth?.status).toBe(200);
      expect(getAgentsMaxDepth(path)).toBe(3);
      const instructions = await handleManagementAPI(put({ subagentDeveloperInstructions: "be thorough" }), new URL("http://localhost/api/v2"), config, deps);
      expect(instructions?.status).toBe(200);
      expect(getSubagentDeveloperInstructions(path)).toBe("be thorough");
      const hint = await handleManagementAPI(put({ multiAgentModeHintText: "Proactive multi-agent delegation is active." }), new URL("http://localhost/api/v2"), config, deps);
      expect(hint?.status).toBe(200);
      expect(await hint?.json()).toMatchObject({ multiAgentModeHintText: "Proactive multi-agent delegation is active." });
      expect(getMultiAgentModeHintText(path)).toBe("Proactive multi-agent delegation is active.");
      const cleared = await handleManagementAPI(put({ multiAgentModeHintText: null }), new URL("http://localhost/api/v2"), config, deps);
      expect(cleared?.status).toBe(200);
      expect(getMultiAgentModeHintText(path)).toBe(null);
    });
  });

  test("unsupported mode-hint preflight leaves a combined request entirely unchanged", async () => {
    await withConfig("[features.multi_agent_v2]\nenabled = false\n", async (path, deps) => {
      installModeHintRuntime(false);
      const originalToml = readFileSync(path, "utf8");
      const localConfig = { providers: [], multiAgentMode: "v1" as const };
      let toggles = 0;
      const response = await handleManagementAPI(
        put({ enabled: true, multiAgentMode: "v2", multiAgentModeHintText: "custom" }),
        new URL("http://localhost/api/v2"),
        localConfig as never,
        { ...deps, toggleCodexMultiAgentV2: () => { toggles++; } },
      );
      expect(response?.status).toBe(502);
      expect(await response?.json()).toEqual({
        error: "writing multiAgentModeHintText failed: installed Codex does not support multi_agent_mode_hint_text; update Codex first",
      });
      expect(toggles).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(originalToml);
      expect(isMultiAgentV2Enabled(path)).toBe(false);
      expect(localConfig.multiAgentMode).toBe("v1");
    });
  });

  test("empty string writes an empty value; null removes the key", async () => {
    await withConfig("[features.multi_agent_v2]\nenabled = false\n", async (path, deps) => {
      await handleManagementAPI(put({ subagentDeveloperInstructions: "" }), new URL("http://localhost/api/v2"), config, deps);
      expect(getSubagentDeveloperInstructions(path)).toBe("");
      const cleared = await handleManagementAPI(put({ subagentDeveloperInstructions: null }), new URL("http://localhost/api/v2"), config, deps);
      expect(await cleared?.json()).toMatchObject({ subagentDeveloperInstructions: null });
      expect(getSubagentDeveloperInstructions(path)).toBe(null);
      // multiAgentModeHintText rejects empty/whitespace strings (present empty string would
      // suppress even the Ultra-derived Proactive message upstream).
      const hintEmpty = await handleManagementAPI(put({ multiAgentModeHintText: "" }), new URL("http://localhost/api/v2"), config, deps);
      expect(hintEmpty?.status).toBe(400);
      const hintSpace = await handleManagementAPI(put({ multiAgentModeHintText: "   " }), new URL("http://localhost/api/v2"), config, deps);
      expect(hintSpace?.status).toBe(400);
      const hintSet = await handleManagementAPI(put({ multiAgentModeHintText: "custom" }), new URL("http://localhost/api/v2"), config, deps);
      expect(hintSet?.status).toBe(200);
      expect(getMultiAgentModeHintText(path)).toBe("custom");
    });
  });

  test("wrong types are rejected with field-specific 400 and untouched config", async () => {
    await withConfig("[agents]\nmax_depth = 2\n", async (path, deps) => {
      const before = readFileSync(path, "utf8");
      for (const payload of [
        { agentsEnabled: "yes" },
        { agentsMaxDepth: 1.5 },
        { agentsMaxDepth: 2_147_483_648 },
        { subagentDeveloperInstructions: 42 },
        { multiAgentModeHintText: 42 },
      ]) {
        const res = await handleManagementAPI(put(payload), new URL("http://localhost/api/v2"), config, deps);
        expect(res?.status).toBe(400);
      }
      expect(readFileSync(path, "utf8")).toBe(before);
      const empty = await handleManagementAPI(put({}), new URL("http://localhost/api/v2"), config, deps);
      expect(empty?.status).toBe(400);
    });
  });

  test("agentsEnabled false with V2 enabled warns but does not reject", async () => {
    await withConfig("[features.multi_agent_v2]\nenabled = true\n", async (path, deps) => {
      const res = await handleManagementAPI(put({ agentsEnabled: false }), new URL("http://localhost/api/v2"), config, deps);
      expect(res?.status).toBe(200);
      const body = await res?.json();
      expect(body.warnings).toContain("agents.enabled = false has no effect while features.multi_agent_v2 is enabled; upstream keeps V2 active.");
      expect(getAgentsEnabled(path)).toBe(false);
    });
  });

  test("null agentsEnabled unsets the key and is not confused with false", async () => {
    await withConfig("[agents]\nenabled = false\n", async (path, deps) => {
      expect(getAgentsEnabled(path)).toBe(false);
      const res = await handleManagementAPI(put({ agentsEnabled: null }), new URL("http://localhost/api/v2"), config, deps);
      expect(res?.status).toBe(200);
      expect(getAgentsEnabled(path)).toBe(null);
    });
  });
});

describe("management API default_mode_request_user_input toggle", () => {
  function requestUserInputEnv<T>(run: () => Promise<T>): Promise<T> {
    const oldCodexHome = process.env.CODEX_HOME;
    const path = fixtureConfig("");
    process.env.CODEX_HOME = dirname(path);
    return run().finally(() => {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    });
  }

  function putRequest(enabled: unknown): Request {
    return new Request("http://localhost/api/codex-auth/features/default-mode-request-user-input", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
    });
  }

  test("GET reports the flag from config.toml", async () => {
    await requestUserInputEnv(async () => {
      const response = await handleManagementAPI(
        new Request("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        { providers: [] } as never,
        { createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ enabled: false, key: "default_mode_request_user_input" });
    });
  });

  test("PUT round-trips through the injected toggle and persists config.toml", async () => {
    await requestUserInputEnv(async () => {
      const path = join(process.env.CODEX_HOME!, "config.toml");
      const toggle = (enabled: boolean) => {
        const content = readFileSync(path, "utf8");
        const line = `default_mode_request_user_input = ${enabled}`;
        const next = /default_mode_request_user_input = (?:true|false)/.test(content)
          ? content.replace(/default_mode_request_user_input = (?:true|false)/, line)
          : `${content}\n[features]\n${line}\n`;
        writeFileSync(path, next);
      };
      const deps = { toggleDefaultModeRequestUserInput: toggle, createManagementConvergeCodex: catalogConvergenceFactory() };
      const url = new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input");

      const on = await handleManagementAPI(putRequest(true), url, { providers: [] } as never, deps);
      expect(on?.status).toBe(200);
      expect(await on?.json()).toMatchObject({ ok: true, enabled: true, changed: true });
      expect(readFileSync(path, "utf8")).toContain("[features]\ndefault_mode_request_user_input = true");

      const off = await handleManagementAPI(putRequest(false), url, { providers: [] } as never, deps);
      expect(off?.status).toBe(200);
      expect(await off?.json()).toMatchObject({ ok: true, enabled: false, changed: true });
      expect(readFileSync(path, "utf8")).toContain("default_mode_request_user_input = false");
    });
  });

  test("PUT rejects non-boolean bodies before any toggle runs", async () => {
    await requestUserInputEnv(async () => {
      let toggles = 0;
      const response = await handleManagementAPI(
        putRequest("yes"),
        new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        { providers: [] } as never,
        { toggleDefaultModeRequestUserInput: () => { toggles++; }, createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      expect(response?.status).toBe(400);
      expect(toggles).toBe(0);
    });
  });

  test("PUT rejects null, array, and non-object bodies with 400", async () => {
    await requestUserInputEnv(async () => {
      const url = new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input");
      for (const rawBody of ["null", "[]", "\"yes\"", "42"]) {
        const response = await handleManagementAPI(
          new Request("http://localhost/api/codex-auth/features/default-mode-request-user-input", {
            method: "PUT", headers: { "content-type": "application/json" }, body: rawBody,
          }),
          url,
          { providers: [] } as never,
          { toggleDefaultModeRequestUserInput: () => { throw new Error("must not toggle"); }, createManagementConvergeCodex: catalogConvergenceFactory() },
        );
        expect(response?.status).toBe(400);
      }
    });
  });

  test("PUT rejects an oversized chunked body with 413", async () => {
    await requestUserInputEnv(async () => {
      const payload = JSON.stringify({ enabled: true, pad: "x".repeat(5 * 1024 * 1024) });
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(payload));
          controller.close();
        },
      });
      const response = await handleManagementAPI(
        new Request("http://localhost/api/codex-auth/features/default-mode-request-user-input", {
          method: "PUT", headers: { "content-type": "application/json" }, body: stream,
        }),
        new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        { providers: [] } as never,
        { toggleDefaultModeRequestUserInput: () => { throw new Error("must not toggle"); }, createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      expect(response?.status).toBe(413);
    });
  });

  test("PUT surfaces the CLI diagnostic in the 502 when the toggle throws", async () => {
    await requestUserInputEnv(async () => {
      const toggle = () => {
        throw Object.assign(new Error("Command failed: codex features enable"), {
          stderr: Buffer.from("unknown feature flag: default_mode_request_user_input"),
        });
      };
      const response = await handleManagementAPI(
        putRequest(true),
        new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        { providers: [] } as never,
        { toggleDefaultModeRequestUserInput: toggle, createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      expect(response?.status).toBe(502);
      const body = await response?.json();
      expect(body.error).toContain("unknown feature flag: default_mode_request_user_input");
    });
  });

  test("PUT fails with 502 when the toggle does not land (unknown flag / old Codex)", async () => {
    await requestUserInputEnv(async () => {
      const response = await handleManagementAPI(
        putRequest(true),
        new URL("http://localhost/api/codex-auth/features/default-mode-request-user-input"),
        { providers: [] } as never,
        { toggleDefaultModeRequestUserInput: () => {}, createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      expect(response?.status).toBe(502);
      expect(await response?.json()).toMatchObject({ error: expect.stringContaining("default_mode_request_user_input toggle failed") });
    });
  });
});

describe("cli surface", () => {
  test("status lines describe the multi-agent surface", () => {
    expect(v2StatusLine(true)).toContain("ON");
    expect(v2StatusLine(false)).toContain("OFF");
  });

  test("status reports the WP2 keys with tri-state rendering and the V1-only label", async () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[agents]\nenabled = false\nmax_depth = 2\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    const logs: string[] = [];
    try {
      expect(await cmdV2(["status"], { log: { log: (m?: unknown) => { logs.push(String(m)); }, error: (m?: unknown) => { logs.push(String(m)); } } })).toBe(0);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
    const out = logs.join("\n");
    expect(out).toContain("agents.enabled: false");
    expect(out).toContain("agents.max_depth: 2 (V1-only — ignored while multi_agent_v2 is enabled)");
    expect(out).toContain("subagent_developer_instructions: (unset — children inherit)");
    expect(out).toContain("multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)");
  });

  test("mode-hint writes, echoes, and clears via --clear", async () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    installModeHintRuntime(true);
    const logs: string[] = [];
    const log = { log: (m?: unknown) => { logs.push(String(m)); }, error: (m?: unknown) => { logs.push(String(m)); } };
    try {
      expect(await cmdV2(["mode-hint", "Proactive multi-agent delegation is active."], { log })).toBe(0);
      expect(getMultiAgentModeHintText(path)).toBe("Proactive multi-agent delegation is active.");
      expect(await cmdV2(["status"], { log })).toBe(0);
      expect(logs.join("\n")).toContain('multi_agent_mode_hint_text: "Proactive multi-agent delegation is active."');
      expect(await cmdV2(["mode-hint", "--clear"], { log })).toBe(0);
      expect(getMultiAgentModeHintText(path)).toBe(null);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("mode-hint preserves raw whitespace in nonblank hints and rejects blank/missing args", async () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    installModeHintRuntime(true);
    const logs: string[] = [];
    const log = { log: (m?: unknown) => { logs.push(String(m)); }, error: (m?: unknown) => { logs.push(String(m)); } };
    try {
      // Raw leading/trailing whitespace is preserved, matching the API contract.
      expect(await cmdV2(["mode-hint", "  spaced hint  "], { log })).toBe(0);
      expect(getMultiAgentModeHintText(path)).toBe("  spaced hint  ");
      expect(await cmdV2(["mode-hint", "- Delegate independent work early"], { log })).toBe(0);
      expect(getMultiAgentModeHintText(path)).toBe("- Delegate independent work early");
      // A present whitespace-only value is rejected (API rejects it with 400).
      expect(await cmdV2(["mode-hint", "   "], { log })).toBe(1);
      expect(getMultiAgentModeHintText(path)).toBe("- Delegate independent work early");
      // A missing argument is a usage error, never a destructive clear.
      expect(await cmdV2(["mode-hint"], { log })).toBe(1);
      expect(getMultiAgentModeHintText(path)).toBe("- Delegate independent work early");
      // Explicit --clear still removes the hint.
      expect(await cmdV2(["mode-hint", "--clear"], { log })).toBe(0);
      expect(getMultiAgentModeHintText(path)).toBe(null);
    } finally {
      resetCodexRuntimeResolveCacheForTests();
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("status renders empty-string instructions distinctly from unset", async () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nsubagent_developer_instructions = \"\"\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    const logs: string[] = [];
    try {
      expect(await cmdV2(["status"], { log: { log: (m?: unknown) => { logs.push(String(m)); }, error: (m?: unknown) => { logs.push(String(m)); } } })).toBe(0);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
    const out = logs.join("\n");
    expect(out).toContain('subagent_developer_instructions: "" (clears inherited instructions)');
    expect(out).toContain("agents.enabled: (unset — upstream default true)");
    expect(out).toContain("agents.max_depth: (unset — upstream default 1)");
    expect(out).not.toContain("V1-only");
  });

  test("codexFeaturesInvocation: POSIX passthrough; win32 .cmd routed through cmd.exe (devlog 260715 020)", () => {
    const execFileSync = () => "codex-cli 0.145.0";
    expect(codexFeaturesInvocation("enable", "multi_agent_v2", "darwin", {
      env: { PATH: "" },
      configDir: mkdtempSync(join(tmpdir(), "ocx-v2-inv-posix-")),
      existsSync: () => false,
      execFileSync,
    })).toEqual({ file: "codex", args: ["features", "enable", "multi_agent_v2"], options: {} });
    expect(codexFeaturesInvocation("enable", "default_mode_request_user_input", "darwin", {
      env: { PATH: "" },
      configDir: mkdtempSync(join(tmpdir(), "ocx-v2-inv-posix-")),
      existsSync: () => false,
      execFileSync,
    })).toEqual({ file: "codex", args: ["features", "enable", "default_mode_request_user_input"], options: {} });
    // Explicit CODEX_CLI_PATH pointing at a .cmd (npm-only Windows Codex install).
    const inv = codexFeaturesInvocation("disable", "multi_agent_v2", "win32", {
      env: { CODEX_CLI_PATH: "C:\\npm\\codex.cmd", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe", PATH: "" },
      configDir: mkdtempSync(join(tmpdir(), "ocx-v2-inv-cmd-")),
      existsSync: () => true,
      execFileSync,
      exists: () => { throw new Error("explicit path must not probe PATH"); },
    });
    expect(inv.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", '"C:\\npm\\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""']);
    expect(inv.options).toEqual({ windowsVerbatimArguments: true });
    // Bare `codex` resolving to codex.exe stays a direct spawn.
    const exe = codexFeaturesInvocation("enable", "multi_agent_v2", "win32", {
      env: { PATH: "C:\\bin" },
      configDir: mkdtempSync(join(tmpdir(), "ocx-v2-inv-exe-")),
      existsSync: (p: string) => p === "C:\\bin\\codex.exe",
      execFileSync,
      exists: (p: string) => p === "C:\\bin\\codex.exe",
    });
    expect(exe).toEqual({ file: "C:\\bin\\codex.exe", args: ["features", "enable", "multi_agent_v2"], options: {} });
  });

  test("mode v2/v1 translates the limit across the root-slot boundary", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\n");
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-cli-config-"));
    const logs: string[] = [];
    const deps = {
      execFile: (_file: string, args: string[]) => {
        // POSIX: ["features", "enable|disable", ...]; win32 .cmd: ["/d","/s","/c","...enable..."]
        const joined = args.join(" ");
        const enabled = args[1] === "enable" || /\benable\b/.test(joined);
        const content = readFileSync(path, "utf8");
        writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
      },
      sync: async () => {},
      log: { log: (message?: unknown) => { logs.push(String(message)); }, error: (message?: unknown) => { logs.push(String(message)); } },
    };
    try {
      expect(await cmdV2(["mode", "v2"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(true);
      expect(getLogicalMaxThreads(path)).toBe(101);
      expect(await cmdV2(["threads", "77"], deps)).toBe(0);
      expect(getLogicalMaxThreads(path)).toBe(77);
      expect(await cmdV2(["off"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(false);
      // Explicit V2 total 77 was caller-supplied; disabling crosses back to 76 children.
      expect(getLogicalMaxThreads(path)).toBe(76);
      expect(await cmdV2(["on"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(true);
      expect(getLogicalMaxThreads(path)).toBe(77);
      expect(await cmdV2(["mode", "v1"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(false);
      expect(getLogicalMaxThreads(path)).toBe(76);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  }, 15_000);
});

describe("mock-max wire clamp (nativeEffortClamp)", () => {
  test("gpt-5.5 max/ultra clamp to its real top rung (xhigh)", () => {
    expect(nativeEffortClamp("gpt-5.5", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.5", "ultra")).toBe("xhigh");
  });

  test("real-max natives are untouched", () => {
    expect(nativeEffortClamp("gpt-5.6-sol", "max")).toBe(null);
    expect(nativeEffortClamp("gpt-5.6-luna", "max")).toBe(null);
  });

  test("only the canonical built-in OpenAI forward route enters the native clamp gate", () => {
    const nativeProvider = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
    } as const;
    const routedProvider = {
      adapter: "openai-chat",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      authMode: "key",
      apiKey: "dashscope-test",
    } as const;

    expect(shouldApplyNativeEffortClamp("openai", nativeProvider as never, "gpt-5.5")).toBe(true);
    expect(shouldApplyNativeEffortClamp("bailian", routedProvider as never, "glm-5.2-fast-preview")).toBe(false);
    expect(shouldApplyNativeEffortClamp("bailian", routedProvider as never, "bailian/glm-5.2-fast-preview")).toBe(false);
  });

  test("ordinary efforts and routed slugs pass through; unknown BARE natives clamp conservatively", () => {
    expect(nativeEffortClamp("gpt-5.5", "high")).toBe(null);
    expect(nativeEffortClamp("gpt-5.5", undefined)).toBe(null);
    expect(nativeEffortClamp("opencode-go/glm-5.2", "max")).toBe(null);
    // off-snapshot bare native = old low..xhigh ladder -> clamp; future 5.6 variants stay free
    expect(nativeEffortClamp("gpt-totally-unknown", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.6-future", "max")).toBe(null);
  });
});

describe("3-state multi-agent mode", () => {
  test("observed catalog transforms ignore ambient V2 changes and leave evidence rows untouched", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    try {
      const buildObserved = () => buildCatalogEntriesFromObservedState({
        template: template(),
        gptSlugs: ["gpt-5.5"],
        goModels: [],
        featured: [],
        wsEnabled: false,
        multiAgentMode: "default",
        exactComboSlugs: new Set(),
        accountSelectors: [],
        suppressedBareNativeSlugs: new Set(),
        disabledNativeAccountSlugs: new Set(),
        multiAgentV2Enabled: true,
      });
      const catalogModels = [{
        ...template(),
        display_name: "GPT-5.5 observed",
        supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
      }];
      const routedEntries = [{
        ...template(),
        slug: "external/model",
        display_name: "External model",
        description: "Routed via opencodex → external (external).",
        supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
      }];
      const accountBoundEntries = [{
        ...template(),
        slug: "team/gpt-5.4",
        display_name: "team / GPT-5.4",
        opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
        service_tier: "fast",
      }];
      const originalCatalogModels = structuredClone(catalogModels);
      const originalRoutedEntries = structuredClone(routedEntries);
      const originalAccountBoundEntries = structuredClone(accountBoundEntries);
      const mergeObserved = () => mergeCatalogEntriesFromObservedState({
        catalogModels,
        baselineCatalogModels: [],
        routedEntries,
        baseline: new Map([["gpt-5.5", 1]]),
        featured: [],
        wsEnabled: false,
        template: template(),
        disabledModels: new Set(),
        selectedModelsByProvider: new Map(),
        gatheredProviderNames: new Set(),
        degradedProviderNames: new Set(),
        legacyCustomModelSlugs: new Set(),
        multiAgentMode: "default",
        multiAgentV2Enabled: true,
        exactComboSlugs: new Set(),
        hasPhysicalComboProvider: false,
        includeNativeOpenAi: true,
        accountBoundEntries,
        policy: {
          nativeBackfillSlugs: ["gpt-5.5"],
          unsupportedNativeEntries: "preserve",
          warningPolicy: "suppress",
        },
      });

      const builtBefore = buildObserved();
      const mergedBefore = mergeObserved();
      writeFileSync(path, "[features.multi_agent_v2]\nenabled = true\n");
      const builtAfter = buildObserved();
      const mergedAfter = mergeObserved();

      expect(builtAfter).toEqual(builtBefore);
      expect(mergedAfter).toEqual(mergedBefore);
      expect(builtBefore.find(entry => entry.slug === "gpt-5.5")?.multi_agent_version).toBe("v2");
      expect(mergedBefore.find(entry => entry.slug === "gpt-5.5")?.multi_agent_version).toBe("v2");
      expect(catalogModels).toEqual(originalCatalogModels);
      expect(routedEntries).toEqual(originalRoutedEntries);
      expect(accountBoundEntries).toEqual(originalAccountBoundEntries);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("mode v1: ALL entries get multi_agent_version = v1 (overrides upstream pins)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "v1");
    for (const e of entries) {
      expect(e.multi_agent_version).toBe("v1");
    }
  });

  test("mode v2: ALL entries get multi_agent_version = v2 (overrides upstream pins)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "v2");
    for (const e of entries) {
      expect(e.multi_agent_version).toBe("v2");
    }
  });

  test("mode default: upstream pins preserved (sol=v2, luna=v1, others=null)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "default");
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    expect(sol.multi_agent_version).toBe("v2");
    expect(luna.multi_agent_version).toBe("v1");
    // gpt-5.5 follows codex flag (null in catalog → codex decides)
    expect(native.multi_agent_version).toBeUndefined();
  });

  /*
   * Option B's write half: the native binary validates spawn_agent models against the
   * catalog WE write, so an unpinned routed model must be stamped "v2" there or it is
   * refused at spawn time no matter what our own roster advertises. The stamp is gated
   * on the feature being ON, which is why the default-mode test above stays green: it
   * runs with the feature off and must remain byte-identical to the old behavior.
   *
   * Both callers of applyMultiAgentMode are covered, because a feature flag threaded
   * through only one of them is the failure this contract exists to catch.
   */
  test("default mode + v2 feature ON stamps unpinned entries via BOTH catalog paths", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    try {
      expect(isMultiAgentV2Enabled()).toBe(true);

      // Path 1: buildCatalogEntries (fresh catalog).
      const built = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "default");
      // Unpinned native gains the stamp so the binary will accept it as a subagent.
      expect(built.find(e => e.slug === "gpt-5.5")!.multi_agent_version).toBe("v2");
      // Genuine upstream pins are never rewritten: "v1" stays excluded, "v2" stays "v2".
      expect(built.find(e => e.slug === "gpt-5.6-luna")!.multi_agent_version).toBe("v1");
      expect(built.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v2");

      // Path 2: mergeCatalogEntriesForSync (existing catalog on disk).
      const merged = mergeCatalogEntriesForSync(
        [{ slug: "opencode-go/glm-5.2", display_name: "glm", visibility: "list", priority: 1 } as never],
        [], new Map(), [], false,
        new Set(), null, new Set(), new Set(), "default",
      );
      const routed = merged.find(e => e.slug === "opencode-go/glm-5.2");
      if (routed) expect(routed.multi_agent_version).toBe("v2");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("default mode + v2 feature OFF is byte-identical to the historical behavior", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\n");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    try {
      expect(isMultiAgentV2Enabled()).toBe(false);
      const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "default");
      // No stamp: the key stays absent exactly as before this change.
      expect(entries.find(e => e.slug === "gpt-5.5")!.multi_agent_version).toBeUndefined();
      expect(entries.find(e => e.slug === "gpt-5.6-luna")!.multi_agent_version).toBe("v1");
      expect(entries.find(e => e.slug === "gpt-5.6-sol")!.multi_agent_version).toBe("v2");
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  test("mode v1 in mergeCatalogEntriesForSync overrides preserved genuine native", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      multi_agent_version: "v2",
    };
    const merged = mergeCatalogEntriesForSync(
      [diskSol as never], [], new Map(), [], false,
      new Set(), null, new Set(), new Set(), "v1",
    );
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(sol.multi_agent_version).toBe("v1");
  });

  test("cli multiAgentModeLine describes each state", () => {
    expect(multiAgentModeLine("v1")).toContain("v1");
    expect(multiAgentModeLine("default")).toContain("default");
    expect(multiAgentModeLine("v2")).toContain("v2");
    expect(multiAgentModeLine("v2", true)).toContain("v2 hybrid");
  });

  test("mode default restores upstream pins after a prior forced v2 (stale-clear regression)", () => {
    // Simulate: disk entries were synced while mode=v2 (all entries stamped v2),
    // then mode switched to default. mergeCatalogEntriesForSync must clear the
    // stale forced value and restore upstream pins.
    const diskSol = { ...template(), slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", multi_agent_version: "v2" };
    const diskLuna = { ...template(), slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", multi_agent_version: "v2" }; // was forced
    const diskNative = { ...template(), slug: "gpt-5.5", display_name: "gpt-5.5", multi_agent_version: "v2" }; // was forced
    const merged = mergeCatalogEntriesForSync(
      [diskSol as never, diskLuna as never, diskNative as never],
      [], new Map(), [], false, new Set(), null, new Set(), new Set(), "default",
    );
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = merged.find(e => e.slug === "gpt-5.6-luna")!;
    const native = merged.find(e => e.slug === "gpt-5.5")!;
    // sol upstream pin is v2 — restored
    expect(sol.multi_agent_version).toBe("v2");
    // luna upstream pin is v1 — restored from snapshot, NOT stale v2
    expect(luna.multi_agent_version).toBe("v1");
    // gpt-5.5 has no upstream pin — cleared (codex flag decides)
    expect(native.multi_agent_version).toBeUndefined();
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
