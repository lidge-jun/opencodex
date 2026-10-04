import { describe, expect, test } from "bun:test";
import {
  autoDetectFilter,
  compressText,
  compressParsedMessages,
  compressRawBody,
  formatRtkLog,
} from "../../src/optimize";
import type { OcxParsedRequest } from "../../src/types/request";

describe("RTK filter auto-detection and compression", () => {
  test("detects and compacts git diff output", () => {
    const sampleDiff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1234567..89abcdef 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,5 +1,6 @@",
      " const a = 1;",
      "+const b = 2;",
      " const c = 3;",
    ].join("\n");

    const fn = autoDetectFilter(sampleDiff);
    expect(fn).not.toBeNull();
    expect((fn as any).filterName).toBe("git-diff");

    // Generate a long diff that triggers compression (> 500 bytes)
    const longDiff = [
      "diff --git a/src/long.ts b/src/long.ts",
      "--- a/src/long.ts",
      "+++ b/src/long.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 140 }, (_, i) => `+console.log("change ${i} - more text to pass 500 bytes");`),
    ].join("\n");

    const stats = { bytesBefore: 0, bytesAfter: 0, hits: [] };
    const compressed = compressText(longDiff, stats, "test");
    expect(compressed.length).toBeLessThan(longDiff.length);
    expect(stats.hits.length).toBe(1);
    expect(stats.hits[0]!.filter).toBe("git-diff");
  });

  test("detects git status output", () => {
    const sampleStatus = [
      "On branch main",
      "Changes not staged for commit:",
      "  modified:   src/index.ts",
      "  modified:   src/server.ts",
      "Untracked files:",
      "  test.txt",
    ].join("\n");

    const fn = autoDetectFilter(sampleStatus);
    expect(fn).not.toBeNull();
    expect((fn as any).filterName).toBe("git-status");
  });

  test("detects build output", () => {
    const sampleBuild = [
      "npm WARN deprecated package@1.0.0",
      "added 15 packages in 2s",
      "BUILD SUCCESS",
    ].join("\n");

    const fn = autoDetectFilter(sampleBuild);
    expect(fn).not.toBeNull();
    expect((fn as any).filterName).toBe("build-output");
  });

  test("compacts toolResult messages in OcxParsedRequest", () => {
    const longDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding minimum compress limit of 500 bytes`),
    ].join("\n");

    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_123",
            toolName: "bash",
            isError: false,
            timestamp: Date.now(),
            content: longDiff,
          },
        ],
      },
    };

    const stats = compressParsedMessages(parsed, true);
    expect(stats).not.toBeNull();
    expect(stats!.hits.length).toBe(1);
    expect(typeof parsed.context.messages[0]!.content).toBe("string");
    expect((parsed.context.messages[0]!.content as string).length).toBeLessThan(longDiff.length);

    const log = formatRtkLog(stats);
    expect(log).toContain("[RTK] saved");
  });

  test("preserves error tool results untouched", () => {
    const errorTrace = [
      "diff --git a/test.ts b/test.ts",
      ...Array.from({ length: 150 }, (_, i) => `+error line ${i} long trace content exceeding 500 bytes`),
    ].join("\n");

    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_err",
            toolName: "bash",
            isError: true, // error trace must be preserved
            timestamp: Date.now(),
            content: errorTrace,
          },
        ],
      },
    };

    const stats = compressParsedMessages(parsed, true);
    expect(stats?.hits.length).toBe(0);
    expect(parsed.context.messages[0]!.content).toBe(errorTrace);
  });

  test("compacts raw body tool messages", () => {
    const longDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding minimum compress limit of 500 bytes`),
    ].join("\n");

    const rawBody = {
      messages: [
        { role: "user", content: "run git diff" },
        { role: "tool", content: longDiff },
      ],
    };

    const stats = compressRawBody(rawBody, true);
    expect(stats).not.toBeNull();
    expect(stats!.hits.length).toBe(1);
    expect(rawBody.messages[1]!.content.length).toBeLessThan(longDiff.length);
  });

  test("compacts custom_tool_call_output in responses raw body", () => {
    const longDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding minimum compress limit of 500 bytes`),
    ].join("\n");

    const rawBody = {
      input: [
        { type: "custom_tool_call_output", call_id: "call_abc", output: longDiff },
      ],
    };

    const stats = compressRawBody(rawBody, true);
    expect(stats).not.toBeNull();
    expect(stats!.hits.length).toBe(1);
    expect((rawBody.input[0]!.output as string).length).toBeLessThan(longDiff.length);
  });

  test("correctly parses and preserves untracked files in git status", () => {
    const { gitStatus } = require("../../src/optimize/filters/gitStatus");
    const status = [
      "On branch main",
      "Untracked files:",
      "  (use \"git add <file>...\" to include in what will be committed)",
      "\tsrc/optimize/",
      "\tgui/src/pages/Optimize.tsx",
    ].join("\n");

    const compacted = gitStatus(status);
    expect(compacted).toContain("* main");
    expect(compacted).toContain("? Untracked: 2 files");
    expect(compacted).toContain("src/optimize/");
    expect(compacted).toContain("gui/src/pages/Optimize.tsx");
    expect(compacted).not.toContain("clean");
  });
});
