import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { create, fromBinary } from "@bufbuild/protobuf";
import { handleCursorNativeExec } from "../../../src/adapters/cursor/native-exec";
import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  GrepArgsSchema,
} from "../../../src/adapters/cursor/gen/agent_pb";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function fixture(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-cursor-grep-globs-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

async function grep(root: string, glob?: string, outputMode = "files_with_matches", allow = true) {
  const frames = await handleCursorNativeExec(create(ExecServerMessageSchema, {
    id: 17,
    execId: "grep-glob-test",
    message: { case: "grepArgs", value: create(GrepArgsSchema, { pattern: "needle", path: root, glob, outputMode }) },
  }), { unsafeAllowNativeLocalExec: allow });
  const response = fromBinary(AgentClientMessageSchema, frames[0]!);
  if (response.message.case !== "execClientMessage" || response.message.value.message.case !== "grepResult") {
    throw new Error("Expected native grep response");
  }
  return response.message.value.message.value.result;
}

async function matchedFiles(root: string, glob?: string): Promise<string[]> {
  const response = await grep(root, glob);
  if (response.case !== "success") throw new Error("Expected successful native grep");
  const result = Object.values(response.value.workspaceResults)[0]!.result;
  if (result.case !== "files") throw new Error("Expected native grep file list");
  return result.value.files.map(file => relative(root, file).split(sep).join("/")).sort();
}

describe("Cursor native grep globs", () => {
  test("matches recursive and root-relative patterns without matching absolute ancestors", async () => {
    const root = fixture({
      "main.ts": "needle",
      "src/main.ts": "needle",
      "src/deep/worker.ts": "needle",
      "other/src/wrong.ts": "needle",
      "src/notes.txt": "needle",
    });
    expect(await matchedFiles(root, "**/*.ts")).toEqual([
      "main.ts", "other/src/wrong.ts", "src/deep/worker.ts", "src/main.ts",
    ]);
    expect(await matchedFiles(root, "src/*.ts")).toEqual(["src/main.ts"]);
    expect(await matchedFiles(root, "src/**/*.ts")).toEqual(["src/deep/worker.ts", "src/main.ts"]);
    expect(await matchedFiles(root, "./src/**/*.ts")).toEqual(["src/deep/worker.ts", "src/main.ts"]);
    expect(await matchedFiles(root, "./*.ts")).toEqual(["main.ts"]);
    expect(await matchedFiles(root, `${root.replaceAll(sep, "/")}/*.ts`)).toEqual([]);
  });

  test("matches basename patterns at every depth and preserves the unfiltered search", async () => {
    const root = fixture({ "main.ts": "needle", "nested/main.ts": "needle", "nested/main.ts.bak": "needle", "note.txt": "needle" });
    expect(await matchedFiles(root, "*.ts")).toEqual(["main.ts", "nested/main.ts"]);
    expect(await matchedFiles(root, "main.ts")).toEqual(["main.ts", "nested/main.ts"]);
    expect(await matchedFiles(root, "./main.ts")).toEqual(["main.ts"]);
    expect(await matchedFiles(root)).toEqual(["main.ts", "nested/main.ts", "nested/main.ts.bak", "note.txt"]);
    expect(await matchedFiles(root, "")).toEqual(await matchedFiles(root));
  });

  test("supports character classes and brace alternatives", async () => {
    const root = fixture({ "a.ts": "needle", "b.tsx": "needle", "c.js": "needle", "nested/d.ts": "needle" });
    expect(await matchedFiles(root, "?.{ts,tsx}")).toEqual(["a.ts", "b.tsx", "nested/d.ts"]);
    expect(await matchedFiles(root, "[ab].*")).toEqual(["a.ts", "b.tsx"]);
  });

  // Bun 1.4.3 is still the repository's test runner; these runtime features arrived in 1.4.4.
  test.skipIf(!Bun.semver.satisfies(Bun.version, ">=1.4.4"))("uses Bun 1.4.4 extglobs and brace ranges", async () => {
    const root = fixture({
      "src/item-1.ts": "needle", "src/item-2.ts": "needle", "src/item-3.ts": "needle",
      "src/item-4.ts": "needle", "src/item-2.test.ts": "needle", "src/deep/item-2.ts": "needle",
    });
    expect(await matchedFiles(root, "src/item-{1..3}.ts")).toEqual(["src/item-1.ts", "src/item-2.ts", "src/item-3.ts"]);
    expect(await matchedFiles(root, "src/**/!(*.test).ts")).toEqual([
      "src/deep/item-2.ts", "src/item-1.ts", "src/item-2.ts", "src/item-3.ts", "src/item-4.ts",
    ]);
    expect(await matchedFiles(root, "@(item-1|item-4).ts")).toEqual(["src/item-1.ts", "src/item-4.ts"]);
  });

  test("retains the opt-in gate for native grep", async () => {
    const root = fixture({ "main.ts": "needle" });
    expect((await grep(root, "**/*.ts", "files_with_matches", false)).case).toBe("error");
    expect(await matchedFiles(root, "**/*.ts")).toEqual(["main.ts"]);
  });

  test("preserves explicit single-file searches without applying a directory glob", async () => {
    const root = fixture({ "main.ts": "needle" });
    const file = join(root, "main.ts");
    const response = await grep(file, "*.js");
    if (response.case !== "success") throw new Error("Expected successful native grep");
    const result = Object.values(response.value.workspaceResults)[0]!.result;
    if (result.case !== "files") throw new Error("Expected native grep file list");
    expect(result.value.files).toEqual([file]);
  });

  test("keeps traversal skips, the file byte limit, and the selected search root", async () => {
    const base = fixture({
      "search/src/main.ts": "needle",
      "search/node_modules/dep.ts": "needle",
      "search/.git/private.ts": "needle",
      "search/large.ts": `needle${"x".repeat(1_000_000)}`,
      "outside/other.ts": "needle",
    });
    const root = join(base, "search");
    expect(await matchedFiles(root, "**/*.ts")).toEqual(["src/main.ts"]);
    expect(await matchedFiles(root, "../outside/*.ts")).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("does not follow directory or file symlinks while filtering", async () => {
    const base = fixture({ "search/main.ts": "needle", "outside/other.ts": "needle" });
    const root = join(base, "search");
    symlinkSync(join(base, "outside"), join(root, "linked"));
    symlinkSync(join(base, "outside", "other.ts"), join(root, "linked.ts"));
    expect(await matchedFiles(root, "**/*.ts")).toEqual(["main.ts"]);
  });

  test.each(["content", "count"])("applies globs to %s output", async outputMode => {
    const root = fixture({ "src/main.ts": "needle\nneedle", "src/no.txt": "needle" });
    const response = await grep(root, "src/**/*.ts", outputMode);
    if (response.case !== "success") throw new Error("Expected successful native grep");
    const result = Object.values(response.value.workspaceResults)[0]!.result;
    expect(result.case).toBe(outputMode);
    if (result.case === "content") {
      expect(result.value.matches.map(match => match.file)).toEqual([join(root, "src", "main.ts")]);
      expect(result.value.totalMatchedLines).toBe(2);
    } else if (result.case === "count") {
      expect(result.value.counts.map(match => ({ file: match.file, count: match.count }))).toEqual([{ file: join(root, "src", "main.ts"), count: 2 }]);
      expect(result.value.totalFiles).toBe(1);
      expect(result.value.totalMatches).toBe(2);
    }
  });
});
