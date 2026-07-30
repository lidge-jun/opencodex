import { describe, expect, test } from "bun:test";
import { aliasForNative, aliasForRoute, CLAUDE_ALIAS_PREFIX, claudeCodeAlias, claudeCodeNativeAlias, resolveAlias } from "../src/claude/alias";
import { resolveInboundModel } from "../src/claude/inbound";

describe("claude discovery aliases", () => {
  test("round-trips every realistic provider/model shape", () => {
    const cases: [string, string][] = [
      ["gemini", "gemini-3-pro"],
      ["zai", "glm-5.2"],
      ["opencode-go", "kimi-k2.7-code"],   // provider with single dashes
      ["xai", "grok-4.5-fast"],
      ["cursor", "gpt-5.6-sol"],
      ["lidge-gemma", "gemma-4-31b-heretic"],
      ["p", "model--with--double-dash"],    // model may contain `--`
      ["a", "claude-sonnet-4-5-20250514"],
    ];
    for (const [provider, model] of cases) {
      const alias = aliasForRoute(provider, model);
      expect(alias).not.toBeNull();
      expect(alias!.startsWith("claude")).toBe(true); // picker prefix rule (003 G3)
      expect(resolveAlias(alias!)).toBe(`${provider}/${model}`);
    }
  });

  test("native slugs use the pseudo-provider and resolve to bare ids", () => {
    const alias = aliasForNative("gpt-5.5");
    expect(alias).toBe(`${CLAUDE_ALIAS_PREFIX}native--gpt-5.5`);
    expect(resolveAlias(alias!)).toBe("gpt-5.5");
  });

  test("non-representable shapes are skipped, not mangled", () => {
    expect(aliasForRoute("has--dashes", "m")).toBeNull();
    expect(aliasForRoute("has/slash", "m")).toBeNull();
    expect(aliasForRoute("native", "m")).toBeNull(); // reserved pseudo-provider
    expect(aliasForRoute("", "m")).toBeNull();
    expect(aliasForRoute("p", "")).toBeNull();
    expect(aliasForNative("a--b")).toBeNull();
    expect(aliasForNative("org/model")).toBeNull(); // native ids stay bare
  });

  test("model ids with '/' encode as '~s' and round-trip (OpenRouter-shaped)", () => {
    const alias = aliasForRoute("openrouter", "anthropic/claude-opus-4-8");
    expect(alias).toBe(`${CLAUDE_ALIAS_PREFIX}openrouter--anthropic~sclaude-opus-4-8`);
    expect(resolveAlias(alias!)).toBe("openrouter/anthropic/claude-opus-4-8");
    expect(claudeCodeAlias("openrouter", "meta-llama/llama-3.3-70b-instruct:free")).toBe(
      `${CLAUDE_ALIAS_PREFIX}openrouter--meta-llama~sllama-3.3-70b-instruct:free`,
    );
    expect(resolveAlias(claudeCodeAlias("openrouter", "meta-llama/llama-3.3-70b-instruct:free"))).toBe(
      "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    );
  });

  test("literal '~' in model ids encodes as '~t' and legacy bare '~' still resolves", () => {
    expect(aliasForRoute("demo", "old~model")).toBe(`${CLAUDE_ALIAS_PREFIX}demo--old~tmodel`);
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--old~tmodel`)).toBe("demo/old~model");
    // Pre-slash-encoding aliases kept literal tildes in the model portion.
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--old~model`)).toBe("demo/old~model");
  });

  test("~s/~t are reserved escapes: round-trip / and ~; legacy ~s decodes as slash", () => {
    // Intentional encode/decode round-trips for the reserved escape alphabet.
    expect(aliasForRoute("demo", "a/b")).toBe(`${CLAUDE_ALIAS_PREFIX}demo--a~sb`);
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--a~sb`)).toBe("demo/a/b");
    expect(aliasForRoute("demo", "a~b")).toBe(`${CLAUDE_ALIAS_PREFIX}demo--a~tb`);
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--a~tb`)).toBe("demo/a~b");
    expect(aliasForRoute("demo", "a~/b")).toBe(`${CLAUDE_ALIAS_PREFIX}demo--a~t~sb`);
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--a~t~sb`)).toBe("demo/a~/b");

    // Pre-~s-encoding aliases that stored a literal "~s" sequence are not preserved:
    // decode always treats ~s as "/". Document current behavior only.
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}demo--old~smodel`)).toBe("demo/old/model");
  });

  test("resolveAlias rejects non-aliases and malformed ids", () => {
    expect(resolveAlias("claude-sonnet-4-5")).toBeNull();
    expect(resolveAlias("gpt-5.5")).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}noseparator`)).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}p--`)).toBeNull();
    expect(resolveAlias(`${CLAUDE_ALIAS_PREFIX}--m`)).toBeNull();
  });

  test("no collisions across a registry-shaped corpus", () => {
    const corpus: [string, string][] = [];
    for (const p of ["a", "b", "a-b", "ab"]) {
      for (const m of ["x", "y-z", "y--z", "x.1", "org/model"]) corpus.push([p, m]);
    }
    const aliases = corpus.map(([p, m]) => aliasForRoute(p, m)).filter((a): a is string => a !== null);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (let i = 0; i < aliases.length; i++) {
      expect(resolveAlias(aliases[i])).toBe(`${corpus[i][0]}/${corpus[i][1]}`);
    }
  });

  test("inbound resolution prefers alias over modelMap, before date-strip", () => {
    const cc = { modelMap: { [`${CLAUDE_ALIAS_PREFIX}gemini--gemini-3-pro`]: "should-not-win" } };
    expect(resolveInboundModel(`${CLAUDE_ALIAS_PREFIX}gemini--gemini-3-pro`, cc)).toBe("gemini/gemini-3-pro");
  });
});

describe("claudeCodeAlias — readable-or-hash shared helper (devlog 050 / audit 051 #2)", () => {
  test("readable form when representable; both forms decode to the same route", () => {
    expect(claudeCodeAlias("gemini", "gemini-3-pro")).toBe("claude-ocx-gemini--gemini-3-pro");
    expect(claudeCodeNativeAlias("gpt-5.6-sol")).toBe("claude-ocx-native--gpt-5.6-sol");
    expect(resolveInboundModel(claudeCodeAlias("gemini", "gemini-3-pro"), undefined)).toBe("gemini/gemini-3-pro");
    expect(resolveInboundModel(claudeCodeNativeAlias("gpt-5.6-sol"), undefined)).toBe("gpt-5.6-sol");
    // Readable id with the [1m] context marker (picker variant row) decodes too —
    // strip happens before alias resolution, case-insensitively (audit 051 #4).
    expect(resolveInboundModel("claude-ocx-native--gpt-5.6-sol[1m]", undefined)).toBe("gpt-5.6-sol");
    expect(resolveInboundModel("claude-ocx-gemini--gemini-3-pro[1M]", undefined)).toBe("gemini/gemini-3-pro");
  });

  test("anthropic canonical ids pass through unchanged (native passthrough preserved)", () => {
    expect(claudeCodeAlias("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(claudeCodeAlias("anthropic", "claude-fable-5")).toBe("claude-fable-5");
  });

  test("slash-containing model ids stay readable (no desktop-3p hash)", () => {
    expect(claudeCodeAlias("openrouter", "anthropic/claude-opus-4-8")).toBe(
      "claude-ocx-openrouter--anthropic~sclaude-opus-4-8",
    );
    expect(claudeCodeAlias("mock", "path/model")).toBe("claude-ocx-mock--path~smodel");
    expect(resolveInboundModel("claude-ocx-openrouter--anthropic~sclaude-opus-4-8", undefined)).toBe(
      "openrouter/anthropic/claude-opus-4-8",
    );
  });

  test("unrepresentable shapes fall back to the desktop-3p hash — model never disappears", () => {
    // provider literally "native", provider with separators, native slug with "--".
    // Model ids with "~" are now representable via ~t encoding.
    for (const id of [
      claudeCodeAlias("native", "gpt-5.6-sol"),
      claudeCodeAlias("weird--provider", "m1"),
      claudeCodeAlias("a/b", "m2"),
      claudeCodeNativeAlias("slug--with-sep"),
    ]) {
      expect(id).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
    }
    expect(claudeCodeAlias("mock", "has~tilde")).toBe("claude-ocx-mock--has~ttilde");
  });
});
