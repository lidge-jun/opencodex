import { test } from "bun:test";
import { checkHostedChatCompletion, type CompletionCase } from "../helpers/hosted-chat-completion";

const cases: CompletionCase[] = [
  { name: "plain-empty", search: false, frames: ["", ""], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "search-empty", frames: ["", ""], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "empty-recovers", frames: ["", "Fixed."], sends: 2, identicalRetry: true },
  { name: "reasoning-only", frames: ["thinking", "thinking"], sends: 2, final: "response.failed", errorCode: "empty_completion_retry_failed" },
  { name: "whitespace-only", frames: ["   ", "Fixed."], sends: 2 },
  { name: "empty-off", empty: false, frames: [""], sends: 1 },
  { name: "environment-off", envOff: true, frames: [""], sends: 1 },
  { name: "normal-answer", frames: ["The answer is 42."], sends: 1 },
  { name: "real-tool", frames: ["tool"], sends: 1 },
  { name: "refusal", frames: ["refusal"], sends: 1, final: "response.incomplete" },
  { name: "truncated", frames: ["truncated"], sends: 1, final: "response.incomplete" },
  { name: "search-then-empty", frames: ["search", "", "Fixed after search."], sends: 3, searches: 1 },
  { name: "search-then-empty-twice", frames: ["search", "", ""], sends: 3, searches: 1, final: "response.failed", errorCode: "empty_completion_retry_failed" },
];

for (const row of cases) {
  for (const stream of [true, false]) {
    test(`${row.name} (stream=${stream})`, () => checkHostedChatCompletion({ empty: true, ...row }, stream));
  }
}
