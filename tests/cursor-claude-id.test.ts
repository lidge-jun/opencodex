import { describe, expect, test } from "bun:test";
import {
  composeCursorClaudeWireId,
  normalizeCursorClaudeId,
} from "../src/adapters/cursor/claude-id";

describe("Cursor Claude id normalization", () => {
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
