import { describe, expect, spyOn, test } from "bun:test";
import {
  composeCursorClaudeWireId,
  normalizeCursorClaudeId,
} from "../../../src/adapters/cursor/claude-id";

describe("Cursor Claude id normalization", () => {
  test("matches the legacy regex table for both base spellings and suffix edge cases", () => {
    const patterns = [
      [/^(.*)-thinking-([a-z-]+)-fast$/, true, true],
      [/^(.*)-([a-z-]+)-thinking-fast$/, true, true],
      [/^(.*)-thinking-([a-z-]+)$/, true, false],
      [/^(.*)-([a-z-]+)-thinking$/, true, false],
      [/^(.*)-([a-z-]+)-fast$/, false, true],
      [/^(.*)-thinking-fast$/, true, true],
      [/^(.*)-thinking$/, true, false],
      [/^(.*)-fast$/, false, true],
    ] as const;
    const levels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "extra-high"];
    for (const [base, canonicalBaseId, spelling] of [
      ["claude-opus-5", "claude-opus-5", "anthropic"],
      ["claude-fable-5.1", "claude-fable-5-1", "anthropic"],
      ["claude-4.6-opus", "claude-4.6-opus", "version-first"],
    ] as const) {
      for (const suffix of [
        "", "-thinking", "-fast", "-thinking-fast", "-high", "-thinking-", "-thinking--",
        "-thinking-thinking-high", "-high-thinking-low", "\n-thinking-high", "-thinking-high\nX",
        ...levels.flatMap(level => [
          `-thinking-${level}`, `-${level}-thinking`, `-thinking-${level}-fast`,
          `-${level}-thinking-fast`, `-${level}-fast`,
        ]),
      ]) {
        const id = base + suffix;
        let expected;
        for (const [pattern, thinking, fast] of patterns) {
          const match = pattern.exec(id);
          if (!match || match[1] !== base || (match[2] && !levels.includes(match[2]))) continue;
          expected = { base: match[1], canonicalBaseId, sourceBaseId: base, spelling, thinking, fast,
            ...(match[2] ? { level: match[2] } : {}) };
          break;
        }
        if (suffix === "") expected = { canonicalBaseId, sourceBaseId: base, spelling, thinking: false, fast: false };
        expect(normalizeCursorClaudeId(` ${id.toUpperCase()} `), id).toEqual(expected);
      }
    }
    for (const id of ["", "-thinking-high", "-thinking-", "claude--thinking-high", "claude-composer-5-high-fast"]) {
      expect(normalizeCursorClaudeId(id), id).toBeUndefined();
    }
  });

  test("adversarial Claude ids bypass unbounded wildcard regexes", () => {
    const exec = RegExp.prototype.exec;
    const guard = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value: string) {
      if (value.length > 1_000 && this.source.includes("(.*)")) {
        throw new Error("unbounded wildcard regex on adversarial Claude id");
      }
      return exec.call(this, value);
    });
    try {
      for (const ending of ["X", "high", "high-fast", "high-thinking", "high-thinking-fast"]) {
        const id = "claude-opus-5" + "-thinking-".repeat(20_000) + ending;
        expect(normalizeCursorClaudeId(id)).toBeUndefined();
      }
    } finally {
      guard.mockRestore();
    }
  });

  test("normalizes every observed Fable 5.1 spelling to one capability base", () => {
    for (const id of ["claude-fable-5-1", "claude-fable-5.1", "claude-5.1-fable"]) {
      expect(normalizeCursorClaudeId(id), id).toMatchObject({
        canonicalBaseId: "claude-fable-5-1",
        thinking: false,
        fast: false,
      });
    }
  });

  test("extracts thinking, fast, and effort from both marker orders", () => {
    expect(normalizeCursorClaudeId("claude-fable-5.1-thinking-xhigh-fast")).toMatchObject({
      canonicalBaseId: "claude-fable-5-1",
      sourceBaseId: "claude-fable-5.1",
      spelling: "anthropic",
      thinking: true,
      fast: true,
      level: "xhigh",
    });
    expect(normalizeCursorClaudeId("claude-5.1-fable-max-thinking-fast")).toMatchObject({
      canonicalBaseId: "claude-fable-5-1",
      sourceBaseId: "claude-5.1-fable",
      spelling: "version-first",
      thinking: true,
      fast: true,
      level: "max",
    });
    expect(normalizeCursorClaudeId("claude-opus-5-high-fast")).toMatchObject({
      canonicalBaseId: "claude-opus-5",
      thinking: false,
      fast: true,
      level: "high",
    });
  });

  test("preserves the exact dotted source base for wire round-trips", () => {
    expect(normalizeCursorClaudeId(" CLAUDE-FABLE-5.1-THINKING-HIGH ")).toMatchObject({
      canonicalBaseId: "claude-fable-5-1",
      sourceBaseId: "claude-fable-5.1",
      spelling: "anthropic",
      thinking: true,
      fast: false,
      level: "high",
    });
  });

  test("does not absorb real 1m rows or unknown Claude products", () => {
    expect(normalizeCursorClaudeId("claude-4-sonnet-1m")).toBeUndefined();
    expect(normalizeCursorClaudeId("claude-fable-5-1-preview")).toBeUndefined();
    expect(normalizeCursorClaudeId("claude-composer-5-1")).toBeUndefined();
  });

  test("composes Anthropic-style and version-first wire orders exactly", () => {
    const anthropic = normalizeCursorClaudeId("claude-fable-5.1")!;
    const versionFirst = normalizeCursorClaudeId("claude-5.1-fable")!;
    expect(composeCursorClaudeWireId(anthropic, {
      thinking: true,
      fast: true,
      effort: "xhigh",
    })).toBe("claude-fable-5.1-thinking-xhigh-fast");
    expect(composeCursorClaudeWireId(versionFirst, {
      thinking: true,
      fast: false,
      effort: "max",
    })).toBe("claude-5.1-fable-max-thinking");
    expect(composeCursorClaudeWireId(versionFirst, {
      thinking: true,
      fast: true,
      effort: "high",
      bareThinking: true,
    })).toBe("claude-5.1-fable-thinking-fast");
    expect(composeCursorClaudeWireId(anthropic, {
      thinking: false,
      fast: true,
      effort: "medium",
    })).toBe("claude-fable-5.1-medium-fast");
  });
});
