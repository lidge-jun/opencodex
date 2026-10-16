import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { createAdvisorTaskBudget } from "../../src/advisor/budget";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
function path() { const root = mkdtempSync(join(tmpdir(), "advisor-budget-")); roots.push(root); return join(root, "budget.sqlite"); }

test("task reservations survive reopening and share a strict allowance across instances", () => {
  const file = path();
  const first = createAdvisorTaskBudget(file);
  const other = createAdvisorTaskBudget(file);
  expect(first.reserve("task-a", 2, 1)).toEqual({ ok: true, used: 1 });
  expect(other.reserve("task-a", 2, 2)).toEqual({ ok: true, used: 2 });
  expect(createAdvisorTaskBudget(file).reserve("task-a", 2, 3)).toEqual({ ok: false, reason: "exhausted" });
  expect(readFileSync(file).toString("utf8")).not.toContain("task-a");
  expect(other.reserve("task-b", 2, 3)).toEqual({ ok: true, used: 1 });
  expect(other.reserve("task-a", 2, 86_400_002)).toEqual({ ok: true, used: 1 });
});

test("a busy database blocks consultations without resetting the budget", () => {
  const file = path();
  const budget = createAdvisorTaskBudget(file);
  expect(budget.reserve("task-a", 1, 1).ok).toBe(true);
  const lock = new Database(file);
  lock.exec("BEGIN IMMEDIATE");
  try { expect(budget.reserve("task-b", 1, 2)).toEqual({ ok: false, reason: "unavailable" }); }
  finally { lock.exec("ROLLBACK"); lock.close(); }
  expect(budget.reserve("task-a", 1, 3)).toEqual({ ok: false, reason: "exhausted" });
});

test("saturation preserves live budgets instead of evicting an old task", () => {
  const file = path();
  const budget = createAdvisorTaskBudget(file);
  budget.reserve("oldest", 1, 1);
  const db = new Database(file);
  const insert = db.query("INSERT INTO tasks VALUES (?, 1, ?)");
  db.transaction(() => { for (let i = 0; i < 511; i++) insert.run(`task-${i}`, 86_400_001); })();
  db.close();
  expect(budget.reserve("new", 1, 2)).toEqual({ ok: false, reason: "unavailable" });
  expect(budget.reserve("oldest", 1, 2)).toEqual({ ok: false, reason: "exhausted" });
});

test("a symlink is refused before SQLite can mutate its target", () => {
  const file = path();
  const target = file + ".target";
  createAdvisorTaskBudget(target).reserve("task", 1, 1);
  const before = readFileSync(target);
  symlinkSync(target, file);
  expect(createAdvisorTaskBudget(file).reserve("another", 1, 2)).toEqual({ ok: false, reason: "unavailable" });
  expect(readFileSync(target)).toEqual(before);
});
