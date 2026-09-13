import { createGoogleAdapter } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/adapters/google";
import { createTranslatorBudget } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/lib/translator-budget";
import { bridgeToResponsesSSE } from "/Users/vanch/Documents/Codex/2026-08-05/https-github-com-lidge-jun-opencodex/outputs/upgrade-2.51.0/merged/src/bridge";
import { strict as assert } from "node:assert";

// Local-only protocol test: no real provider call, conversation replay, or persisted task.
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/responses")) return new Response("not found", { status: 404 });
    requests++;
    const budget = createTranslatorBudget();
    const adapter = createGoogleAdapter({ name: "google-antigravity", googleMode: "cloud-code-assist", adapter: "google", baseUrl: "http://invalid.local", models: [] } as any);
    const textMode = process.argv.includes("--text-refusal");
    const refusal = "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt. If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).";
    const frame = textMode ? { candidates: [{ content: { parts: [{ text: refusal }] } }] } : { candidates: [{ finishReason: "SAFETY" }], usageMetadata: { promptTokenCount: 10 } };
    const body = new Response(`data: ${JSON.stringify({ response: frame })}\n\n`);
    const events = (async function* () {
      try { yield* adapter.parseStream(body, budget); }
      finally { budget.dispose(); }
    })();
    return new Response(bridgeToResponsesSSE(events, "gpt-5.5"), { headers: { "content-type": "text/event-stream" } });
  },
});
const child = Bun.spawn([
  "/Applications/ChatGPT.app/Contents/Resources/codex", "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--json", "-C", "/tmp", "-s", "read-only",
  "-c", 'model_provider="ocx_filter_test"', "-m", "gpt-5.5",
  "-c", 'model_providers.ocx_filter_test.name="Local filter protocol test"',
  "-c", `model_providers.ocx_filter_test.base_url="http://127.0.0.1:${server.port}/v1"`,
  "-c", 'model_providers.ocx_filter_test.wire_api="responses"',
  "-c", "model_providers.ocx_filter_test.requires_openai_auth=false",
  "-c", "model_providers.ocx_filter_test.stream_max_retries=5",
  "Local protocol check. No tool actions are needed.",
], { stdout: "pipe", stderr: "pipe" });
const timeout = setTimeout(() => child.kill(), 30000);
try {
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const output = stdout + stderr;
  const expectedReason = process.argv.includes("--text-refusal") ? "standalone content-policy refusal" : "finishReason=SAFETY";
  console.log(JSON.stringify({ requests, exitCode, explicitReason: output.includes(expectedReason), reconnecting: /Reconnecting|Retrying/i.test(output) }));
  assert.equal(requests, 1, "Codex must not retry a provider content block");
  assert.notEqual(exitCode, 0, "a provider block must remain a failed turn");
  assert.ok(output.includes(expectedReason), "Codex must surface the provider reason");
} finally {
  clearTimeout(timeout);
  server.stop(true);
}
