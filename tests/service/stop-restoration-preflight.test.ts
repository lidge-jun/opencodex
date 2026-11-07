import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { fixturePath, repoPath } from "../helpers/repo-root";

test("CR2 synchronous H contention reports history failure and still strips Grok", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-stop-h-busy-"));
  try {
    const child = spawnSync(process.execPath, [fixturePath("stop-restore-history-runner.ts"), "sync", "history-busy"], {
      cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: join(root, "ocx"), CODEX_HOME: join(root, "codex"), GROK_HOME: join(root, "grok") },
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const value = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
    expect(value.result).toMatchObject({ success: false, artifacts: { history: { state: "failed", changed: false, rows: 0, files: 0 } } });
    expect(value.result.artifacts.history.message).toContain("holding the history database");
    expect(value.boundary).toBe("restore");
    expect(value.grokResult).toMatchObject({ ok: true, changed: true });
    expect(value.grokManaged).toBe(false);
    expect(value.native).toBe('model = "gpt-5"\n');
    expect(value.before).toBeDefined();
    expect(value.after).toEqual(value.before);
    expect(value.receiptExists).toBe(true);
  } finally { removeTreeWithRetry(root); }
}, 20_000);

test("CR3 pending ownership refuses API stop before stopping the manager and keeps serving", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-stop-preflight-"));
  const ocx = join(root, "ocx");
  const codex = join(root, "codex");
  mkdirSync(ocx); mkdirSync(codex);
  try {
    const child = spawnSync(process.execPath, [fixturePath("api-stop-exit-runner.ts"), "pending"], {
      cwd: repoPath(), env: { ...process.env, OPENCODEX_HOME: ocx, CODEX_HOME: codex },
      encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const value = JSON.parse(readFileSync(join(ocx, "api-stop-exit-result.json"), "utf8"));
    expect(value).toMatchObject({ responseStatus: 409, refusedKeptServing: true, automaticRestarted: true,
      receiptState: "valid", body: { success: false, sharedTeardown: "refused" },
      calls: { service: 0, apiNative: 0, apiGrok: 0, exitNative: 0, exitGrok: 0 } });
  } finally { removeTreeWithRetry(root); }
}, 20_000);
