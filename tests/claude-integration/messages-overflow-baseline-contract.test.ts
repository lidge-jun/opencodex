import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const digest = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
test("#8128 shared overflow predicate changes only in the documented 5xx and conditional cases", () => {
  const source = readFileSync(repoPath("src/claude/outbound.ts"), "utf8");
  const start = source.indexOf("const GENERIC_FAILURE_CODES");
  const end = source.indexOf("export function anthropicErrorBody", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const predicate = source.slice(start, end);
  const addition = '"upstream_server_error", ';
  const currentExceeds = '  for (const exceeds of text.matchAll(new RegExp(EXCEEDS_TEXT_RE, "gi"))) {\n    if (!NEGATION_RE.test(exceeds[0]) && !CONDITIONAL_LEAD_RE.test(text.slice(0, exceeds.index))) return true;\n  }\n  return false;';
  const baselineExceeds = '  const exceeds = EXCEEDS_TEXT_RE.exec(text);\n  return exceeds !== null && !NEGATION_RE.test(exceeds[0]);';
  expect(predicate.split(addition)).toHaveLength(2);
  expect(predicate.split(currentExceeds)).toHaveLength(2);
  expect(digest(predicate.replace(addition, "").replace(currentExceeds, baselineExceeds))).toBe("d1d3fd370bcc625c9638f63ff57498456e66b58cf1e258be028bc4d3318493fa");
});
test("#8128 behavior suite retains origin/dev source", () => {
  const source = readFileSync(repoPath("tests/claude-integration/claude-uncoded-context-overflow.test.ts"));
  expect(source.length).toBeGreaterThan(0);
  expect(digest(source)).toBe("d5d0573f377c5d7894bff343a0bd9cebec46df5bc405b112238862479a3e7328");
});
