import { test } from "bun:test";
import { checkHostedChatCompletion, type CompletionCase } from "../helpers/hosted-chat-completion";

const cases: CompletionCase[] = [
  { name: "plain-plan-again", search: false, frames: ["plan", "plan"], sends: 2, final: "response.failed", errorCode: "terminal_continuation_failed" },
  { name: "plain-plan-to-tool", search: false, frames: ["plan", "tool"], sends: 2 },
  { name: "plan-to-tool", frames: ["plan", "tool"], sends: 2 },
  { name: "plan-to-answer", frames: ["plan", "Cannot proceed: the file is missing."], sends: 2 },
  { name: "plan-again", frames: ["plan", "plan"], sends: 2, final: "response.failed", errorCode: "terminal_continuation_failed" },
  { name: "guard-off", guard: false, frames: ["plan"], sends: 1 },
  { name: "requested-plan", input: "Provide a plan for fixing it.", frames: ["plan"], sends: 1 },
  { name: "waiting-for-user", frames: ["Which file should I change?"], sends: 1 },
  { name: "no-tools", noTools: true, frames: ["plan"], sends: 1 },
  { name: "refusal", frames: ["refusal"], sends: 1, final: "response.incomplete" },
  { name: "truncated", frames: ["truncated"], sends: 1, final: "response.incomplete" },
  { name: "search-then-plan", frames: ["search", "plan", "tool"], sends: 3, searches: 1 },
];

for (const row of cases) {
  for (const stream of [true, false]) {
    test(`${row.name} (stream=${stream})`, () => checkHostedChatCompletion({ guard: true, ...row }, stream));
  }
}
