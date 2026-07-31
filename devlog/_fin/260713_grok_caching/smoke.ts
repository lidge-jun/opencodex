/**
 * Live xAI OAuth prompt-cache smoke (audit-mandated gate, 260713).
 * Starts the dev server on a spare port (shared real ~/.opencodex home so the
 * production instance and this smoke never fork the rotating refresh token),
 * sends the same conversation twice with a fixed prompt_cache_key, and prints
 * the usage of both turns. PASS = second turn reports cached input tokens > 0.
 */
import { startServer } from "../../../src/server/index";

const PORT = 10199;
const server = startServer(PORT);
const promptCacheKey = `smoke-grok-cache-${Date.now()}`;

const stablePreamble = [
  "You are a careful assistant. Rules:",
  ...Array.from({ length: 40 }, (_, i) => `Rule ${i + 1}: always keep invariant ${i + 1} about deterministic formatting, terse answers, and stable ordering of any lists you produce.`),
].join("\n");

async function turn(label: string, userText: string) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "xai/grok-4.5",
      stream: false,
      store: false,
      prompt_cache_key: promptCacheKey,
      instructions: stablePreamble,
      input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
      reasoning: { effort: "low" },
    }),
  });
  const body = await res.json() as Record<string, unknown>;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  console.log(`[${label}] status=${res.status} usage=${JSON.stringify(usage)}`);
  if (res.status !== 200) console.log(`[${label}] body=${JSON.stringify(body).slice(0, 600)}`);
  return { status: res.status, usage };
}

try {
  const first = await turn("turn1", "Reply with the single word: ready.");
  await new Promise(r => setTimeout(r, 2500));
  const second = await turn("turn2", "Reply with the single word: ready.");
  const firstCached = (first.usage as { input_tokens_details?: { cached_tokens?: number } } | undefined)?.input_tokens_details?.cached_tokens ?? 0;
  const secondCached = (second.usage as { input_tokens_details?: { cached_tokens?: number } } | undefined)?.input_tokens_details?.cached_tokens ?? 0;
  const passed = first.status === 200 && second.status === 200 && secondCached > firstCached;
  console.log(passed ? `SMOKE PASS: cached_tokens ${firstCached} -> ${secondCached}` : `SMOKE FAIL: status ${first.status}/${second.status}, cached_tokens ${firstCached} -> ${secondCached}`);
  if (!passed) process.exitCode = 1;
} finally {
  server.stop(true);
}
