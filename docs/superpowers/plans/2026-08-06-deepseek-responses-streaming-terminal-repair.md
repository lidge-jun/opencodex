# DeepSeek Responses Streaming Terminal Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore progressive `deepseek-v4-flash` Responses streaming and safely synthesize a single completed terminal only for structurally complete terminal-less output.

**Architecture:** Replace the built-in DeepSeek forced bounded-JSON hint with a registry-only terminal-repair policy. A bounded SSE wrapper runs before the existing inspection/client split, relays healthy streams unchanged, and uses a five-second post-completion grace timer to synthesize one `response.completed` event when every output item is safely complete.

**Tech Stack:** Bun-native TypeScript, Web `ReadableStream`, Responses SSE, `bun:test`, existing translator-budget and SSE framing helpers.

## Global Constraints

- Work only on `agent/fix-deepseek-responses-streaming`, based on `origin/dev`; do not modify PR #1047's branch.
- Keep the repair registry-only and limited to the official built-in `deepseek-v4-flash` Responses route.
- Do not change DeepSeek Chat Completions, Anthropic replay, global JSON timeouts, or other providers.
- A real upstream terminal is authoritative and must never be duplicated or replaced.
- Never synthesize success for partial, malformed, tainted, oversized, unknown-type, cancelled, or aborted output.
- Use TDD for every behavior change: observe the focused test fail for the expected reason before production edits.
- Preserve existing item-id repair, reasoning replay, continuation-state, WebSocket, cancellation, and failed-tail contracts.
- Do not log prompts, API keys, raw credentials, or private account identifiers.

---

## File responsibility map

- `src/providers/registry.ts` — declares and resolves the built-in per-model terminal-repair policy.
- `src/server/responses-terminal-repair.ts` — owns SSE lifecycle tracking, bounded retained state, grace scheduling, and synthetic terminal creation.
- `src/server/responses/core.ts` — activates the repair before existing transport-specific relay branches.
- `tests/responses-terminal-repair.test.ts` — unit state-machine and stream-race coverage.
- `tests/deepseek-inbound-wire.test.ts` — end-to-end official DeepSeek wire and HTTP activation.
- `tests/ws-endpoint.test.ts` — WebSocket event parity for real and repaired terminals.
- `structure/04_transports-and-sidecars.md` — architectural contract for the provider-scoped streaming repair.
- `docs/superpowers/specs/2026-08-06-deepseek-responses-streaming-terminal-repair-design.md` — approved design authority; implementation must remain consistent with it.

---

### Task 1: Replace the DeepSeek bounded-JSON hint with a terminal-repair policy

**Files:**
- Modify: `src/providers/registry.ts:150-170`
- Modify: `src/providers/registry.ts:1143-1162`
- Modify: `src/providers/registry.ts:1834-1842`
- Modify: `tests/deepseek-inbound-wire.test.ts:1-175`
- Modify: `tests/deepseek-responses-item-id-repair.test.ts`

**Interfaces:**
- Produces: `ResponsesTerminalRepairPolicy`
- Produces: `providerModelResponsesTerminalRepair(id, provider, modelId): ResponsesTerminalRepairPolicy | undefined`
- Preserves: `providerModelResponsesUpstreamStreaming(...)` for providers that still need bounded JSON.

- [ ] **Step 1: Write failing registry and outbound-wire tests**

Import the new resolver and change the existing DeepSeek transport expectations:

```ts
import {
  getProviderRegistryEntry,
  providerModelResponsesTerminalRepair,
} from "../src/providers/registry";

test("the official DeepSeek Responses route opts into terminal repair", () => {
  const provider = deepseekProvider();
  expect(providerModelResponsesTerminalRepair("deepseek", provider, MODEL)).toEqual({ graceMs: 5_000 });
  expect(providerModelResponsesTerminalRepair("deepseek", provider, "deepseek-chat")).toBeUndefined();
  expect(providerModelResponsesTerminalRepair("custom-deepseek", provider, MODEL)).toBeUndefined();
});

test("Codex HTTP and WebSocket turns keep DeepSeek streaming upstream", async () => {
  expect((await drive("responses")).body.stream).toBe(true);
  expect((await drive("responses", "websocket")).body.stream).toBe(true);
});
```

Delete or rewrite the tests whose asserted contract is specifically
`stream:false`/bounded JSON for built-in DeepSeek. Keep the bounded-JSON helper
coverage that is provider-neutral. In
`tests/deepseek-responses-item-id-repair.test.ts`, retain the pure
`repairResponsesJsonItemIds()` unit test but remove the built-in-DeepSeek HTTP
activation assertion; Task 4 replaces it with streaming repair composition.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/deepseek-inbound-wire.test.ts
```

Expected: compile/test failure because `providerModelResponsesTerminalRepair`
does not exist and the current outbound body still contains `stream:false`.

- [ ] **Step 3: Add the registry policy and resolver**

Add the exact registry-only type and field:

```ts
export interface ResponsesTerminalRepairPolicy {
  graceMs: number;
}
```

Add this exact field inside the existing `ProviderRegistryEntry` interface:

```ts
modelResponsesTerminalRepair?: Record<string, ResponsesTerminalRepairPolicy>;
```

In the DeepSeek entry, remove the `false` streaming override and declare:

```ts
modelResponsesTerminalRepair: {
  "deepseek-v4-flash": { graceMs: 5_000 },
},
```

Add the resolver beside `providerModelResponsesUpstreamStreaming`:

```ts
export function providerModelResponsesTerminalRepair(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
): ResponsesTerminalRepairPolicy | undefined {
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelResponsesTerminalRepair || !providerMatchesRegistryTransport(id, provider)) return undefined;
  const policy = entry.modelResponsesTerminalRepair[modelId.trim().toLowerCase()];
  if (!policy || !Number.isFinite(policy.graceMs) || policy.graceMs <= 0) return undefined;
  return { graceMs: Math.floor(policy.graceMs) };
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
bun test tests/deepseek-inbound-wire.test.ts tests/deepseek-responses-item-id-repair.test.ts tests/provider-registry-parity.test.ts
```

Expected: all selected tests pass; captured HTTP and WebSocket request bodies
carry `stream:true`.

- [ ] **Step 5: Commit**

```bash
git add src/providers/registry.ts tests/deepseek-inbound-wire.test.ts tests/deepseek-responses-item-id-repair.test.ts
git commit -m "fix(deepseek): restore Responses upstream streaming"
```

---

### Task 2: Build the healthy-stream and grace-completion core

**Files:**
- Create: `src/server/responses-terminal-repair.ts`
- Create: `tests/responses-terminal-repair.test.ts`

**Interfaces:**
- Consumes: `ResponsesTerminalRepairPolicy`
- Consumes: `TranslatorBudget`
- Produces: `ResponsesTerminalRepairScheduler`
- Produces: `relayResponsesSseWithTerminalRepair(body, upstream, policy, budget, scheduler?)`

- [ ] **Step 1: Write the manual scheduler and two RED tests**

The test scheduler must advance callbacks synchronously without wall-clock sleep:

```ts
class ManualScheduler implements ResponsesTerminalRepairScheduler {
  private current = 0;
  private nextId = 1;
  private readonly jobs = new Map<number, { at: number; callback: () => void }>();

  nowMs(): number { return this.current; }
  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.current + delayMs, callback });
    return id;
  }
  cancel(handle: unknown): void { this.jobs.delete(handle as number); }
  advance(ms: number): void {
    this.current += ms;
    const due = [...this.jobs.entries()].filter(([, job]) => job.at <= this.current);
    for (const [id, job] of due) {
      this.jobs.delete(id);
      job.callback();
    }
  }
}
```

Add one test with the live-captured lifecycle shape and a real
`response.completed`; assert output is byte-identical and contains one terminal.
Add one terminal-less fixture containing `response.created`, reasoning added/done,
function-call added/arguments.done/output_item.done; advance 4,999 ms (no
terminal), then one more millisecond and assert exactly one synthetic completed
terminal followed by one `[DONE]`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts
```

Expected: module-not-found failure for
`src/server/responses-terminal-repair.ts`.

- [ ] **Step 3: Implement the public API and minimal healthy/grace path**

Create these exact public interfaces:

```ts
export interface ResponsesTerminalRepairScheduler {
  nowMs(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export function relayResponsesSseWithTerminalRepair(
  body: ReadableStream<Uint8Array>,
  upstream: AbortController,
  policy: ResponsesTerminalRepairPolicy,
  budget: TranslatorBudget,
  scheduler: ResponsesTerminalRepairScheduler = systemScheduler,
): ReadableStream<Uint8Array>;
```

The default scheduler wraps `Date.now()`, `setTimeout`, and `clearTimeout`.
The relay must:

- frame blocks with `nextSseBlock()` and parse payloads with `sseDataPayload()`;
- relay normal blocks with their original delimiter;
- record a valid `response.created.response` snapshot;
- track added and completed items by integer `output_index`;
- arm the grace timer only after the candidate predicate succeeds;
- on timer expiry, enqueue
  `event: response.completed\ndata: <payload>\n\n`, then close and cancel the
  reader;
- rely on the downstream terminal boundary to append `[DONE]` in production;
  the unit harness may compose `relaySseWithFailedTail` to assert the final sentinel;
- cancel timers and release all retained budget in one idempotent disposer.

Charge serialized retained response metadata and completed items under
`{ kind: "retained_collectors" }`; release the previous charge before replacing
an item and release every remaining charge during disposal.

- [ ] **Step 4: Run the two tests and verify GREEN**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts
```

Expected: healthy pass-through and five-second grace completion both pass;
translator-budget current bytes return to zero after drain.

- [ ] **Step 5: Commit**

```bash
git add src/server/responses-terminal-repair.ts tests/responses-terminal-repair.test.ts
git commit -m "feat(responses): repair complete terminal-less streams"
```

---

### Task 3: Harden the terminal-repair state machine

**Files:**
- Modify: `src/server/responses-terminal-repair.ts`
- Modify: `tests/responses-terminal-repair.test.ts`

**Interfaces:**
- Preserves Task 2 public signatures.
- Adds no user-facing configuration.

- [ ] **Step 1: Add RED tests for every fail-closed boundary**

Use the Task 2 `ManualScheduler`, controlled source, SSE block builder, stream
drain, and terminal-type helpers. Add one complete test per row:

| Test | Exact fixture/action | Required assertions |
|---|---|---|
| New activity resets grace | Complete reasoning item; advance 4,999 ms; add and complete a message item; advance 4,999 then 1 ms | No early terminal; final output includes both ordered items; one completed terminal |
| Complete EOF | Created plus one completed message, then source close | Completed appears immediately before close; source has one terminal |
| Complete `[DONE]` | Created plus one completed message, then `data: [DONE]` | Completed precedes exactly one `[DONE]` |
| Open item EOF | Created plus `output_item.added`, then close | One incomplete terminal; no completed terminal |
| Invalid function arguments | Done function call whose `arguments` is `{broken`, then close | One incomplete terminal; no completed terminal |
| Unknown item | Done item with `type:"computer_call"`, then close | One incomplete terminal; no completed terminal |
| Contradictory index | Two different added items reuse index 0, followed by one done item | State stays tainted; incomplete on close |
| Real terminal precedence | Run completed, failed, and incomplete subcases before grace expiry | Upstream terminal byte-preserved; no synthetic terminal |
| Timer/terminal race | Queue the timer callback, deliver real completed, then execute queued callback | Exactly one real completed terminal |
| Fragmentation | Split a multibyte reasoning delta and `\r\n\r\n` delimiters across chunks | Same terminal sequence and completed output as one-chunk control |
| Cancel/abort | Cancel client before grace; separately abort upstream before grace | No synthetic terminal; timer queue empty; source reader cancelled |
| Budget overflow | Use `createTestTranslatorBudget({ maxTurnBytes: 128 })` and a done item larger than 128 bytes | `translation_buffer_limit`; no completed terminal; retained bytes return to zero |

Every test must assert the complete terminal type sequence, expected source
cancellation, an empty scheduler queue, and
`budget.snapshot().currentBytes === 0` after teardown.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts
```

Expected: the newly added boundary tests fail because Task 2 implements only
the healthy and basic grace paths.

- [ ] **Step 3: Implement strict item validation and singular terminal commitment**

Implement these private rules:

```ts
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompleteItem(item: Record<string, unknown>): boolean {
  if (item.status !== "completed") return false;
  if (item.type === "reasoning") {
    return typeof item.id === "string" && item.id.length > 0
      && Array.isArray(item.content)
      && item.content.every(part => isPlainRecord(part)
        && part.type === "reasoning_text" && typeof part.text === "string");
  }
  if (item.type === "message") {
    return typeof item.id === "string" && item.id.length > 0
      && item.role === "assistant" && Array.isArray(item.content)
      && item.content.every(part => isPlainRecord(part)
        && part.type === "output_text" && typeof part.text === "string");
  }
  if (item.type === "function_call") {
    if (typeof item.id !== "string" || item.id.length === 0) return false;
    if (typeof item.call_id !== "string" || item.call_id.length === 0) return false;
    if (typeof item.name !== "string" || item.name.length === 0) return false;
    if (typeof item.arguments !== "string") return false;
    try {
      const parsed = JSON.parse(item.arguments) as unknown;
      return isPlainRecord(parsed);
    } catch { return false; }
  }
  return false;
}
```

Require a valid created snapshot, at least one done item, exact added/done index
parity, no taint, and all done items passing `isCompleteItem()`.

Implement one `commitTerminal(kind)` gate. For `completed`, build the response
from created metadata with ordered output, `status:"completed"`, injected
`completed_at`, and next sequence number. For incomplete EOF/DONE, emit a
canonical `response.incomplete` with `incomplete_details.reason` set to
`"missing_terminal_event"`.

Every new non-terminal event increments a generation counter and cancels the
old timer. Timer callbacks capture the generation and re-check terminal,
abort/cancel, taint, and candidate completeness immediately before enqueueing.

- [ ] **Step 4: Run the hardening tests and verify GREEN**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts tests/sse-failed-tail.test.ts tests/relay-eager.test.ts
```

Expected: all tests pass with no duplicate terminal, timer leak, or retained
budget after teardown.

- [ ] **Step 5: Commit**

```bash
git add src/server/responses-terminal-repair.ts tests/responses-terminal-repair.test.ts
git commit -m "fix(responses): fail closed on unsafe terminal repair"
```

---

### Task 4: Integrate repair before HTTP/WebSocket transport branching

**Files:**
- Modify: `src/server/responses/core.ts:95-115`
- Modify: `src/server/responses/core.ts:2030-2230`
- Modify: `tests/deepseek-inbound-wire.test.ts:115-330`
- Modify: `tests/deepseek-responses-item-id-repair.test.ts`
- Modify: `tests/ws-endpoint.test.ts`

**Interfaces:**
- Consumes: `providerModelResponsesTerminalRepair(...)`
- Consumes: `relayResponsesSseWithTerminalRepair(...)`
- Adds: `HandleResponsesOptions.responsesTerminalRepairScheduler?` as a narrow
  clock/timer dependency injection seam used by deterministic integration tests.
- Preserves: existing payload/block rewrite composition and terminal inspection.

- [ ] **Step 1: Write failing HTTP progressive-delivery and repair-composition tests**

Replace the old bounded-JSON DeepSeek fixture with an SSE source that exposes
manual `push()` and `close()` controls. Assert:

```ts
expect(capturedRequest.body.stream).toBe(true);

source.push(reasoningDeltaBlock);
const firstRead = await reader.read();
expect(new TextDecoder().decode(firstRead.value)).toContain("response.reasoning_text.delta");

source.push(functionCallDoneBlock);
scheduler.advance(5_000);
const remainder = await drainReader(reader);
expect(remainder).toContain("response.completed");
expect(remainder).toContain("data: [DONE]");
```

The fixture must use UUID reasoning/message ids and assert that existing item-id
repair rewrites added/delta/done/synthetic-terminal payloads consistently while
leaving `function_call.id` and `call_id` unchanged.

- [ ] **Step 2: Add a failing WebSocket parity test**

Drive the same terminal-less complete function call through `/v1/responses`
WebSocket handling. Assert the client receives progressive delta frames, one
`response.output_item.done`, and one `response.completed`, and that a second
`response.create` carrying `function_call_output` remains accepted.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
bun test tests/deepseek-inbound-wire.test.ts tests/ws-endpoint.test.ts
```

Expected: requests now carry `stream:true` from Task 1 but no provider-scoped
repair is activated, so the terminal-less fixture does not close at the injected
grace boundary.

- [ ] **Step 4: Wrap the upstream SSE body before existing branches**

Import both new resolvers and build one body before the eager/tee split:

```ts
const terminalRepairPolicy = providerModelResponsesTerminalRepair(
  route.providerName,
  route.provider,
  route.modelId,
);
const passthroughSseBody = terminalRepairPolicy
  ? relayResponsesSseWithTerminalRepair(
      upstreamResponse.body,
      upstream,
      terminalRepairPolicy,
      translatorBudget,
      options.responsesTerminalRepairScheduler,
    )
  : upstreamResponse.body;
```

Add the optional scheduler to `HandleResponsesOptions`:

```ts
/** Internal deterministic clock/timer seam for provider terminal repair. */
responsesTerminalRepairScheduler?: ResponsesTerminalRepairScheduler;
```

Use `passthroughSseBody` in both:

- the eager single-reader call to `relaySseEagerBounded()`;
- the default `passthroughSseBody.tee()` path.

Do not place the wrapper only on the client branch: background inspection and
continuation persistence must see the synthetic terminal too. Leave the
existing JSON branch and bounded-JSON synthesis intact for providers whose
streaming resolver still returns `false`.

- [ ] **Step 5: Run HTTP/WebSocket and continuation tests and verify GREEN**

Run:

```bash
bun test tests/deepseek-inbound-wire.test.ts tests/ws-endpoint.test.ts tests/responses-state.test.ts tests/deepseek-responses-item-id-repair.test.ts tests/deepseek-reasoning-replay.test.ts
```

Expected: progressive output precedes terminal, both transports close once,
item ids are stable, and continuation state retains reasoning/function output.

- [ ] **Step 6: Commit**

```bash
git add src/server/responses/core.ts tests/deepseek-inbound-wire.test.ts tests/deepseek-responses-item-id-repair.test.ts tests/ws-endpoint.test.ts
git commit -m "fix(deepseek): repair terminal-less Responses streams"
```

---

### Task 5: Synchronize architecture documentation and remove stale assertions

**Files:**
- Modify: `structure/04_transports-and-sidecars.md:205-225`
- Modify: `src/providers/registry.ts:1150-1165`

**Interfaces:**
- Documents the registry-only `modelResponsesTerminalRepair` policy and rollback path.

- [ ] **Step 1: Find stale policy wording**

Run:

```bash
rg -n "DeepSeek.*bounded|bounded.*DeepSeek|modelResponsesUpstreamStreaming|stream:false" structure src tests docs-site
```

Expected: identify every statement that specifically claims the built-in
DeepSeek route is forced to bounded JSON.

- [ ] **Step 2: Update documentation and comments**

Document that official DeepSeek uses native Responses streaming and a
provider/model-scoped five-second repair only after complete output items.
State that the bounded-JSON mechanism remains available for other providers and
as a rollback capability.

Do not describe synthetic completion as a generic Responses behavior.

- [ ] **Step 3: Run repository hygiene checks**

Run:

```bash
git diff --check
bun run privacy:scan
```

Expected: both exit 0; no local path, credential, raw probe id, or private
prompt appears in tracked files.

- [ ] **Step 4: Commit**

```bash
git add structure/04_transports-and-sidecars.md src/providers/registry.ts
git commit -m "docs(deepseek): describe streaming terminal repair"
```

---

### Task 6: Complete verification and live smoke test

**Files:**
- No planned source changes; fix only defects exposed by verification, each with a RED test first.

**Interfaces:**
- Verifies every acceptance criterion in the approved design.

- [ ] **Step 1: Run the focused regression matrix**

Run:

```bash
bun test tests/responses-terminal-repair.test.ts tests/deepseek-inbound-wire.test.ts tests/ws-endpoint.test.ts tests/sse-failed-tail.test.ts tests/relay-eager.test.ts tests/responses-item-id-repair.test.ts tests/deepseek-responses-item-id-repair.test.ts tests/deepseek-reasoning-replay.test.ts tests/responses-state.test.ts
```

Expected: 0 failures.

- [ ] **Step 2: Run typecheck and full repository gates**

Run:

```bash
bun run typecheck
bun run test
bun run privacy:scan
bun run prepush
```

Expected: every command exits 0. Record exact pass/skip/fail counts from the
fresh `prepush` output.

- [ ] **Step 3: Run one minimal official-DeepSeek smoke through the new code**

Start an isolated one-off opencodex server from this worktree on an unused
loopback port, using the existing local config without printing its API key.
Send a prompt containing no private data and a no-op function tool. Verify:

- the upstream request remains `stream:true`;
- at least one reasoning/function delta reaches the client before terminal;
- exactly one real `response.completed` and one `[DONE]` arrive;
- the request log status is 200 and `firstOutputMs` is populated;
- no `upstream JSON response stalled before completing` error occurs.

Stop only the one-off process; do not restart or replace the installed service
until the user separately authorizes deployment.

- [ ] **Step 4: Review final diff and branch state**

Run:

```bash
git status -sb
git diff origin/dev...HEAD --check
git diff origin/dev...HEAD --stat
git log --oneline origin/dev..HEAD
```

Expected: only the design, plan, targeted source, tests, and architecture doc
are changed; working tree is clean.

---

### Task 7: Publish the independent pull request

**Files:**
- No local code changes expected.

**Interfaces:**
- Produces an independent PR targeting `lidge-jun/opencodex:dev`.

- [ ] **Step 1: Rebase or merge the latest `origin/dev` only if required**

Fetch current `origin/dev`, check ancestry, and update the branch without
touching PR #1047. If baseline movement creates conflicts, resolve only within
this branch and rerun Task 6 gates.

- [ ] **Step 2: Push the branch to the user's fork**

```bash
git push -u fork agent/fix-deepseek-responses-streaming
```

- [ ] **Step 3: Open a draft PR using the repository template**

Target `dev`. The PR summary must state:

- the observed 30-second bounded-JSON failure mode;
- the 2026-08-06 official-stream capture showing a valid terminal;
- the provider-scoped five-second completion repair;
- fail-closed conditions and transport parity;
- exact local verification counts.

Do not include API keys, local paths, private prompts, account identifiers, or
the user's production conversation data.

- [ ] **Step 4: Verify PR state**

Confirm target branch, head SHA, template completeness, CI/check state, and
that the PR is independent of #1047. Leave it draft until the repository's
review-readiness checklist is satisfied against the exact final SHA.
