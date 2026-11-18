import { acquireSpendLedgerOwner } from "../../src/lib/spend-ledger-owner";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { compactionRequest, completedPayload, jsonResponse, sseResponse, twoAccountPoolConfig } from "./compaction-routing-fixtures";

const lease = acquireSpendLedgerOwner();
const config = twoAccountPoolConfig();
config.codexAccounts = ["a", "b"].map(id => ({ id, email: `${id}@test`, isMain: false, chatgptAccountId: `acct-${id}` }));
config.activeCodexAccountId = "a";
config.codexAccountNamespaces = { side: "b" };
const bodies: Array<Record<string, unknown>> = [];
const turnStates: Array<string | null> = [];
const mock = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  turnStates.push(request.headers.get("x-codex-turn-state"));
  bodies.push(await request.json() as Record<string, unknown>);
  return request.url.endsWith("/compact") ? jsonResponse({ output: [] }) : sseResponse([{ type: "response.completed", response: completedPayload("ok") }]);
}) as typeof fetch;
globalThis.fetch = mock;
for (const provider of Object.values(config.providers)) Object.assign(provider, { fetch: mock, upstreamWebsocket: false });
const body = { model: process.argv[3] === "same" ? "gpt-5.5" : "side/gpt-5.5", stream: false, client_metadata: { "x-codex-turn-state": "old-state" }, input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file-test" }] }] };
const request = compactionRequest(body, undefined, { "session-id": "restart-session", "thread-id": "restart-thread", "x-codex-turn-state": "old-state" });
const response = process.argv[2] === "compact"
  ? await handleResponsesCompact(request, config, { model: "", provider: "" })
  : await handleResponses(request, config, { model: "", provider: "" });
const responseBody = await response.text();
lease.release();
console.log(JSON.stringify({ status: response.status, bodies, responseBody, turnStates }));
