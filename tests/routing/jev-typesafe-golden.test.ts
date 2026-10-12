import { describe, expect, test } from "bun:test";
import { JEV_API_URL, resolveJevDecision, type JevCandidate } from "../../src/combos/jev";
import type { OcxConfig } from "../../src/types";
import { fixturePath } from "../helpers/repo-root";

// Captured from the origin/dev implementation before decision backends existed (64294638a6).
// A TypeSafe decision request must keep these exact bytes: property order, criteria shape and all.
const golden = (await Bun.file(fixturePath("jev-typesafe-request-golden.json")).json()) as { body: string };

const candidates: JevCandidate[] = [
  { key: "openai/gpt-6-astra", provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["medium", "high"], modelProfile: "Operator note: best for refactors." },
  { key: "deepseek/deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash", reasoningEfforts: [] },
  { key: "openai/gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna", reasoningEfforts: ["low"] },
];
const body = { input: [
  { role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>Fix the failing combo test and explain why." }] },
  { role: "assistant", content: [{ type: "output_text", text: "I will run the test first." }] },
  { type: "function_call", call_id: "c1", name: "exec_command", arguments: "{}" },
  { type: "function_call_output", call_id: "c1", output: "1 fail: expected 2 got 3" },
] };

describe("TypeSafe decision request golden", () => {
  test("default and explicit jev combos send the pre-backend request bytes", async () => {
    const config = {
      providers: { jev: { adapter: "jev-decision", baseUrl: JEV_API_URL, authMode: "key", apiKey: "golden-key", liveModels: false } },
      combos: {},
    } as unknown as OcxConfig;
    for (const decisionProvider of [undefined, "jev"]) {
      const sent: Array<{ url: string; body: string }> = [];
      await resolveJevDecision({
        body,
        candidates,
        fallback: { targetKey: candidates[0]!.key, effort: null },
        config,
        ...(decisionProvider ? { decisionProvider } : {}),
        post: (async (_name: string, _provider: unknown, url: string, init: RequestInit) => {
          sent.push({ url, body: String(init.body) });
          return new Response("{}", { status: 200 });
        }) as never,
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe(JEV_API_URL);
      expect(sent[0]!.body).toBe(golden.body);
    }
  });
});
