import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRetentionNotice,
  applyReasoningRetention,
  collectReasoningTexts,
} from "../../src/responses/reasoning-retention";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { estimateTokens } from "../../src/lib/token-estimate";

const reasoningItem = (text: string) => ({
  type: "reasoning",
  summary: [{ type: "summary_text", text }],
});

describe("collectReasoningTexts", () => {
  test("extracts summary text from reasoning items and ignores other items", () => {
    const texts = collectReasoningTexts([
      { type: "message", role: "user", content: "hi" },
      reasoningItem("第一段的推理"),
      reasoningItem("second stretch"),
    ]);
    expect(texts).toEqual(["第一段的推理", "second stretch"]);
  });

  test("returns an empty list when nothing carries readable reasoning", () => {
    expect(collectReasoningTexts([{ type: "message", role: "user", content: "hi" }])).toEqual([]);
    expect(collectReasoningTexts(undefined)).toEqual([]);
  });
});

describe("applyReasoningRetention", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "reasoning-retention-"));
    return dir;
  };

  test("holds reasoning locally while it fits the configured share", () => {
    const archiveDir = setup();
    const input = [reasoningItem("short thinking")];
    const result = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 1_000_000,
      maxContextPercent: 20,
    });
    expect(result.input).toEqual([]);
    expect(collectReasoningTexts(result.retainedReasoning)).toEqual(["short thinking"]);
    expect(result.archived).toBeUndefined();
  });

  test("holds reasoning locally under the absolute cap when the context window is unknown", () => {
    const archiveDir = setup();
    const input = [reasoningItem("x".repeat(100_000))];
    const result = applyReasoningRetention(input, { archiveDir, maxContextPercent: 20 });
    expect(result.input).toEqual([]);
    expect(collectReasoningTexts(result.retainedReasoning)).toEqual(["x".repeat(100_000)]);
    expect(result.archived).toBeUndefined();
  });

  test("keeps no-reasoning input unchanged and strips opaque-only items without decoding them", () => {
    const input = [{ type: "message", role: "user", content: "hello" }];
    expect(applyReasoningRetention(input, { archiveDir: setup() }).input).toBe(input);
    const result = applyReasoningRetention([...input, { type: "reasoning", encrypted_content: "private-ciphertext" }], { archiveDir: dir });
    expect(result.input).toEqual(input);
    expect(result.retainedReasoning).toBeUndefined();
  });

  test("retains exact envelope text at the inclusive cap without provider signatures", () => {
    const text = "  exact\n原文  ";
    const input = [{ type: "reasoning", summary: [{ type: "summary_text", text: "display-only" }],
      encrypted_content: encodeReasoningEnvelope({ txt: text, sig: "provider-signature", krc: "opaque" }) }];
    const result = applyReasoningRetention(input, { archiveDir: setup(), maxTokens: estimateTokens(text) });
    expect(collectReasoningTexts(result.retainedReasoning)).toEqual([text]);
    expect(JSON.stringify(result.retainedReasoning)).not.toContain("provider-signature");
    expect(result.archived).toBeUndefined();
    expect(applyReasoningRetention(input, { archiveDir: dir, maxTokens: estimateTokens(text) - 1 }).archived).toBeDefined();
  });

  test("archive write failure leaves original input intact for a client retry", () => {
    const archiveDir = join(setup(), "not-a-directory");
    writeFileSync(archiveDir, "occupied");
    const input = [reasoningItem("original reasoning"), { type: "message", role: "user", content: "question" }];
    const snapshot = JSON.stringify(input);
    expect(() => applyReasoningRetention(input, { archiveDir, maxTokens: 1 })).toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test("archives reasoning over the absolute cap even when the context window is unknown", () => {
    const archiveDir = setup();
    const input = [reasoningItem("x".repeat(420_000))];
    const result = applyReasoningRetention(input, { archiveDir, maxContextPercent: 20 });
    expect(result.archived).toBeDefined();
    expect(result.archived!.cap).toBe(100_000);
    expect(appendRetentionNotice("summary", result.archived)).toContain("上下文窗口未知");
  });

  test.skipIf(process.platform === "win32")("new archives are private to the user on POSIX", () => {
    const archiveDir = join(setup(), "private-archive");
    const result = applyReasoningRetention([reasoningItem("private original reasoning")], { archiveDir, maxTokens: 1 });
    expect(statSync(archiveDir).mode & 0o777).toBe(0o700);
    expect(statSync(result.archived!.path).mode & 0o777).toBe(0o600);
  });

  test("archives oversized reasoning to a local file and leaves a path note", () => {
    const archiveDir = setup();
    const big = "考虑了很多方案 ".repeat(2000);
    const input = [
      { type: "message", role: "user", content: "问题" },
      reasoningItem(big),
      { type: "compaction_trigger" },
    ];
    const result = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 10_000,
      maxContextPercent: 20,
    });
    expect(result.archived).toBeDefined();
    expect(result.archived!.tokens).toBeGreaterThan(2000);
    const archivedText = readFileSync(result.archived!.path, "utf-8");
    expect(archivedText).toContain(big);

    const nextInput = result.input as Array<Record<string, unknown>>;
    expect(nextInput.some(item => item.type === "reasoning")).toBe(false);
    expect(nextInput.some(item => item.type === "compaction_trigger")).toBe(true);
    const note = nextInput.find(item => item.type === "message" && typeof item.content === "string"
      && (item.content as string).includes(result.archived!.path));
    expect(note).toBeDefined();
  });

  test("defaults to a 20 percent share when the config omits it", () => {
    const archiveDir = setup();
    const input = [reasoningItem("x".repeat(100_000))];
    const result = applyReasoningRetention(input, { archiveDir, contextWindow: 10_000 });
    expect(result.archived).toBeDefined();
  });

  test("archives reasoning that fits the percent share but exceeds the absolute token cap", () => {
    const archiveDir = setup();
    // A huge window keeps the percent share (20% of 10M = 2M tokens) from binding, so only
    // the absolute cap can justify archiving ~117K tokens of reasoning.
    const text = "x".repeat(420_000);
    expect(estimateTokens(text)).toBeGreaterThan(100_000);
    expect(estimateTokens(text)).toBeLessThan(2_000_000);
    const input = [reasoningItem(text)];
    const result = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 10_000_000,
      maxContextPercent: 20,
    });
    expect(result.archived).toBeDefined();
    expect(result.archived!.tokens).toBeGreaterThan(100_000);
  });

  test("holds reasoning locally when it fits both the percent share and the absolute cap", () => {
    const archiveDir = setup();
    const text = "x".repeat(320_000);
    expect(estimateTokens(text)).toBeLessThan(100_000);
    const input = [reasoningItem(text)];
    const result = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 10_000_000,
      maxContextPercent: 20,
    });
    expect(result.input).toEqual([]);
    expect(collectReasoningTexts(result.retainedReasoning)).toEqual([text]);
    expect(result.archived).toBeUndefined();
  });

  test("an explicit maxTokens overrides the default cap", () => {
    const archiveDir = setup();
    const text = "x".repeat(100_000);
    expect(estimateTokens(text)).toBeGreaterThan(20_000);
    expect(estimateTokens(text)).toBeLessThan(100_000);
    const input = [reasoningItem(text)];
    const underDefault = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 10_000_000,
      maxContextPercent: 20,
    });
    expect(underDefault.input).toEqual([]);
    expect(collectReasoningTexts(underDefault.retainedReasoning)).toEqual([text]);
    const underCustom = applyReasoningRetention(input, {
      archiveDir,
      contextWindow: 10_000_000,
      maxContextPercent: 20,
      maxTokens: 20_000,
    });
    expect(underCustom.archived).toBeDefined();
  });
});

describe("appendRetentionNotice", () => {
  test("leaves the summary alone when nothing was archived", () => {
    expect(appendRetentionNotice("summary", undefined)).toBe("summary");
  });

  test("appends a visible notice naming the archive path and the share", () => {
    const text = appendRetentionNotice("summary", {
      path: "/tmp/archive.md",
      tokens: 5000,
      percent: 20,
    });
    expect(text).toContain("summary");
    expect(text).toContain("/tmp/archive.md");
    expect(text).toContain("20%");
    expect(text).toContain("本次有效上限");
  });
});
