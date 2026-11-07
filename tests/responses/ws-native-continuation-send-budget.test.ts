import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createScanner, LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { repoPath } from "../helpers/repo-root";
import { bindWorkflowBudgetConfig } from "../../src/lib/workflow-budget-config";
import { resetWorkflowBudgetsForTest, workflowBudgetSnapshot, listWorkflowBudgetEvents, WORKFLOW_LOCAL_REFUSAL_HEADER } from "../../src/lib/workflow-budget";
import { configureSharedSpendLedger, spendPolicyFromConfig } from "../../src/lib/spend-reservation-ledger";
import { claimNativeContinuationSend } from "../../src/server/responses/native-continuation-send";
import { NativeContinuationRefusalError } from "../../src/server/responses/native-continuation-refusal";
import { getRequestLogEntries } from "../../src/server/request-log";
import { NativeInjectionChannel } from "../../src/server/responses/native-injection";
import { codexWsUpstreamFetch } from "../../src/server/responses/ws-upstream";
import { sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";
import { workflowRefusalResponse } from "../../src/server/workflow-refusal";
import type { ServerWebSocket } from "bun";
import {
  installInjectionFixture, prepareInjectionSpendHome, beginInjection, injectionConfig,
  advertiseInjection, completeInjection, savedResult, continuationFrame, injectionClient,
  acknowledgeInjection, waitForInjection, fallbackCalls, InjectionSocket, type Frame,
} from "../helpers/native-injection-fixture";

installInjectionFixture();
beforeEach(() => resetWorkflowBudgetsForTest());
afterEach(() => { bindWorkflowBudgetConfig(null); resetWorkflowBudgetsForTest(); });

async function begin(root: string, limit?: number, enforced = false, mode: "injection" | "steering" = "injection") {
  prepareInjectionSpendHome();
  bindWorkflowBudgetConfig(limit === undefined ? null : { workflowBudget: { maxPhysicalSends: limit } });
  configureSharedSpendLedger(spendPolicyFromConfig(enforced ? { root: { maxTokens: 1_000_000 } } : undefined));
  const fields = mode === "steering" ? { multi_agent: undefined } : {};
  return beginInjection(fields, { ...injectionConfig(), codexNativeSteering: mode === "steering" }, "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
}

for (const mode of ["injection", "steering"] as const) for (const enforced of [false, true]) for (const limit of [1, 2]) {
  test(`${mode} continuation stops at the root ceiling ${limit} (spend=${enforced})`, async () => {
    const root = `native-budget-${mode}-${limit}-${enforced}`;
    const x = await begin(root, limit, enforced, mode);
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 1 });
    let id = x.id;
    for (let sendNumber = 1; sendNumber <= limit; sendNumber++) {
      const call = `call-${sendNumber}`;
      const item = advertiseInjection(x.socket, call);
      if (mode === "steering") {
        x.send({ type: "response.steer", previous_response_id: id, input: "continue with the saved result" });
        x.socket.emit({ type: "response.steer.accepted", steer: { id: `steer-${sendNumber}`, previous_response_id: id } });
        expect(workflowBudgetSnapshot(root)?.sends).toBe(sendNumber);
      }
      completeInjection(x.socket, { output: [item] }, id);
      if (mode === "steering") x.socket.emit({ type: "response.steer.pending",
        steer: { id: `steer-${sendNumber}`, previous_response_id: id }, reason: "waiting_for_required_input",
        required_input: [{ type: "function_call_output", call_id: call }] });
      await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
      expect(x.ws.data.nativeControl).toBeDefined();
      const before = x.socket.frames.length;
      x.send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult(call)],
        ...(mode === "steering" ? { multi_agent: undefined } : {}) }));
      // Channel admission and the pacing microtask do not claim a physical start.
      expect(x.socket.frames).toHaveLength(before);
      expect(workflowBudgetSnapshot(root)?.sends).toBe(sendNumber);
      if (sendNumber < limit) {
        await waitForInjection(() => x.socket.frames.length === before + 1);
        expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: sendNumber + 1, active: 1 });
        const previous = id; id = `successor-${sendNumber}`;
        x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
      }
    }
    await waitForInjection(() => x.sent.some(frame => frame.type === "error")
      || x.socket.frames.filter(frame => frame.type === "response.create").length > limit);
    expect(x.socket.frames.filter(frame => frame.type === "response.create")).toHaveLength(limit);
    await waitForInjection(() => !x.ws.data.nativeControl);
    const refusal = x.sent.find(frame => frame.type === "error")!;
    expect(refusal.status).toBe(429);
    expect(refusal.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_sends_exhausted");
    expect(refusal.error.message).toContain("no additional provider request was sent");
    expect(getRequestLogEntries().filter(entry => entry.errorCode === "workflow_sends_exhausted").at(-1)?.status).toBe(429);
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: limit, active: 0 });
    expect(listWorkflowBudgetEvents().filter(event => event.rootId === root && event.kind === "refused")).toHaveLength(1);
    expect(InjectionSocket.all).toHaveLength(1);
    expect(fallbackCalls).toBe(0);
  });
}

for (const enforced of [false, true]) test(`native chains without a send ceiling exceed four sends (spend=${enforced})`, async () => {
  const root = `native-unconfigured-chain-${enforced}`;
  const x = await begin(root, undefined, enforced);
  let id = x.id;
  for (let i = 1; i <= 5; i++) {
    const call = `call-${i}`, item = advertiseInjection(x.socket, call);
    completeInjection(x.socket, { output: [item] }, id);
    await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
    x.send(continuationFrame({ type: "response.create", previous_response_id: id, input: [savedResult(call)] }));
    await waitForInjection(() => x.socket.frames.length === i + 1 || x.sent.some(frame => frame.type === "error"));
    expect(x.socket.frames).toHaveLength(i + 1);
    expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: i + 1, active: 1 });
    const previous = id; id = `long-successor-${i}`;
    x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
  }
  completeInjection(x.socket, {}, id);
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 6, active: 0 });
  expect(x.sent.filter(frame => frame.type === "error")).toHaveLength(0);
  expect(fallbackCalls).toBe(0);
});

test("cancellation while a continuation is queued claims no additional send", async () => {
  const root = "native-cancelled-before-send";
  const x = await begin(root, 2);
  const item = advertiseInjection(x.socket);
  completeInjection(x.socket, { output: [item] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed"));
  x.send(continuationFrame({ type: "response.create", previous_response_id: x.id, input: [savedResult()] }));
  x.ws.close();
  await waitForInjection(() => !x.ws.data.nativeControl && x.ws.data.cancel === undefined);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 1, active: 0 });
  expect(x.socket.frames).toHaveLength(1);
  expect(fallbackCalls).toBe(0);
});

test("native injection control frames do not consume the next continuation slot", async () => {
  const root = "native-control-not-a-send";
  const x = await begin(root, 2);
  const first = advertiseInjection(x.socket, "injected");
  const remaining = advertiseInjection(x.socket, "continued", 1);
  x.send({ type: "response.inject", response_id: x.id, input: [savedResult("injected")] });
  await waitForInjection(() => x.socket.frames.length === 2);
  acknowledgeInjection(x.socket);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(1);
  completeInjection(x.socket, { output: [first, remaining] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed"));
  x.send(continuationFrame({ type: "response.create", previous_response_id: x.id, input: [savedResult("continued")] }));
  await waitForInjection(() => x.socket.frames.length === 3);
  expect(workflowBudgetSnapshot(root)?.sends).toBe(2);
  x.socket.emit({ type: "response.created", response: { id: "control-successor", previous_response_id: x.id, output: [] } });
  completeInjection(x.socket, {}, "control-successor");
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 2, active: 0 });
  expect(fallbackCalls).toBe(0);
});

test("native token-ceiling refusal preserves its workflow identity after earlier sends", async () => {
  const root = "native-token-refusal";
  prepareInjectionSpendHome(); bindWorkflowBudgetConfig(null);
  configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 4096 } }));
  const x = await beginInjection({ max_output_tokens: 1024 }, injectionConfig(), "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
  let id = x.id, refused = false;
  for (let i = 1; i <= 8; i++) {
    const call = `token-call-${i}`, item = advertiseInjection(x.socket, call);
    completeInjection(x.socket, { output: [item] }, id);
    await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === id));
    const count = x.socket.frames.length;
    x.send(continuationFrame({ type: "response.create", previous_response_id: id,
      max_output_tokens: 1024, input: [savedResult(call)] }));
    await waitForInjection(() => x.socket.frames.length > count || x.sent.some(frame => frame.type === "error"));
    const error = x.sent.find(frame => frame.type === "error");
    if (error) {
      refused = true;
      expect(error.status).toBe(429);
      expect(error.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_spend_exhausted");
      expect(error.error.message.replaceAll(",", "")).toContain("4096");
      expect(x.socket.frames).toHaveLength(count);
      expect(workflowBudgetSnapshot(root)?.sends).toBe(count);
      break;
    }
    const previous = id; id = `token-successor-${i}`;
    x.socket.emit({ type: "response.created", response: { id, previous_response_id: previous, output: [] } });
  }
  expect(refused).toBe(true);
  const denials = listWorkflowBudgetEvents().filter(event => event.rootId === root && event.kind === "refused");
  expect(denials).toHaveLength(1);
  expect(denials[0]).toMatchObject({ reason: "workflow-spend-exhausted", spendScope: "root", spendLimit: 4096 });
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)?.active).toBe(0);
  expect(fallbackCalls).toBe(0);
});

test("an independent continuation refusal does not replay stale spend details", async () => {
  let reports = 0, closes = 0;
  const tracker = { refusals: 1, settle() {}, lastRefusal: {
    reason: "workflow-spend-exhausted", spend: { scope: "pool", limit: 7, projected: 8, includesUnboundPoolHistory: true },
  } };
  const reporter = Object.assign((_count: number) => { reports++; }, { beforeSend: () => false, close: () => { closes++; } });
  let refusal: Response | undefined;
  try { claimNativeContinuationSend(reporter, { model: "m", provider: "fixture", spendTracker: tracker,
    spendRefusalDetail: { scope: "pool", limit: 7, projected: 8, includesUnboundPoolHistory: true } }); }
  catch (error) { if (!(error instanceof NativeContinuationRefusalError)) throw error; refusal = error.response; }
  expect(refusal?.status).toBe(429);
  expect(refusal?.headers.has(WORKFLOW_LOCAL_REFUSAL_HEADER)).toBe(false);
  expect((await refusal!.json()).error.message).toContain("request send budget exhausted before dispatch");
  expect(reports).toBe(0); expect(closes).toBe(1);
});

test("an unpaced injection continuation preserves a known local refusal", async () => {
  const opening = { model: "fixture", multi_agent: { enabled: true }, input: "initial" };
  const channel = new NativeInjectionChannel(opening);
  const refusal = workflowRefusalResponse("workflow-sends-exhausted");
  const response = await codexWsUpstreamFetch("https://chatgpt.com/backend-api/codex/responses",
    { method: "POST", body: JSON.stringify({ ...opening, stream: true }) }, globalThis.fetch, "1.4.4",
    undefined, undefined, channel, undefined, undefined, undefined,
    () => { throw new NativeContinuationRefusalError(refusal); });
  const sent: Frame[] = [];
  const ws = { readyState: 1, data: {}, send(text: string) { sent.push(JSON.parse(text)); return 1; } } as unknown as ServerWebSocket<WsData>;
  const pump = sendResponseToWebSocket(ws, response, () => true, { untilEof: true });
  await waitForInjection(() => sent.some(frame => frame.type === "response.created"));
  const socket = InjectionSocket.all.at(-1)!;
  const item = advertiseInjection(socket);
  completeInjection(socket, { output: [item] });
  await waitForInjection(() => sent.some(frame => frame.type === "response.completed"));
  let thrown: unknown;
  try { channel.continue({ ...opening, type: "response.create", previous_response_id: socket.root, input: [savedResult()] }); }
  catch (error) { thrown = error; socket.close(); }
  await pump;
  expect(thrown).toBeUndefined();
  const error = sent.find(frame => frame.type === "error")!;
  expect(error.status).toBe(429);
  expect(error.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_sends_exhausted");
  expect(socket.frames).toHaveLength(1); expect(fallbackCalls).toBe(0);
});

// The continuation hook is only as strong as the legs that forward it. Every native-capable
// executor in the passthrough path must pass onContinuationDispatch: a recovery leg that
// rebuilds the native socket without it would let a successor bypass send-count and spend
// admission. The HTTP-only ambiguous-replacement executor carries no nativeControl slot at
// all, so it is excluded structurally rather than by name. The oracle is a token scanner,
// not text matching, so formatting, quoted keys and newly added legs are covered.
test("every native-capable passthrough executor routes continuations through admission", () => {
  const legs = passthroughExecutorOptions(readFileSync(repoPath("src/server/responses/passthrough-dispatch.ts"), "utf8"))
    .filter(options => options.has("nativeControl"));
  expect(legs.length).toBeGreaterThan(0);
  for (const options of legs) expect(options.has("onContinuationDispatch")).toBe(true);

  // Oracle sanity on miniature sources: quoted, spaced and shorthand keys all register, but
  // a hook name that only appears in a property VALUE does not count as the option itself.
  for (const source of [
    "providerFetch(a, b, { nativeControl: c, onContinuationDispatch })",
    'providerFetch(a, b, {\n  nativeControl: c,\n  "onContinuationDispatch": fn,\n})',
    "providerFetch(a, b, { onContinuationDispatch: () => {}, nativeControl: c })",
    'const label = `value:${{ nested: `n:${1}` }.nested}`; /** `comment` */ providerFetch(a, b, { nativeControl: c, onContinuationDispatch })',
  ]) {
    const options = passthroughExecutorOptions(source).find(set => set.has("nativeControl"))!;
    expect(options.has("onContinuationDispatch")).toBe(true);
  }
  for (const source of [
    "providerFetch(a, b, { nativeControl: cond ? onContinuationDispatch : other })",
    "providerFetch(a, b, { nativeControl: wrap(onContinuationDispatch) })",
    'providerFetch(a, b, { nativeControl: c, label: "onContinuationDispatch" })',
  ]) {
    const options = passthroughExecutorOptions(source).find(set => set.has("nativeControl"))!;
    expect(options.has("onContinuationDispatch")).toBe(false);
  }
});

/**
 * Direct property names of every object-literal argument passed to a providerFetch call,
 * token-scanned so only real key positions count: a name is a property only at the start
 * of an entry (after the opening brace or a same-level comma), never inside a value.
 */
function passthroughExecutorOptions(source: string): Set<string>[] {
  const scanner = createScanner(true, LanguageVariant.Standard, source);
  const tokens: { kind: SyntaxKind; text: string }[] = [];
  let braces = 0;
  const templates: number[] = [];
  for (;;) {
    let kind = scanner.scan();
    // The scanner needs parser context to resume a template after its substitution.
    // Without this rescan, a later backtick can swallow otherwise executable calls.
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.TemplateHead) templates.push(braces);
    else if (kind === SyntaxKind.OpenBraceToken) braces++;
    else if (kind === SyntaxKind.CloseBraceToken) braces--;
    tokens.push({ kind, text: scanner.getTokenText() });
    if (kind === SyntaxKind.EndOfFile) break;
  }
  const followers = new Set([SyntaxKind.ColonToken, SyntaxKind.CommaToken, SyntaxKind.CloseBraceToken, SyntaxKind.OpenParenToken]);
  const optionSets: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.kind !== SyntaxKind.Identifier || tokens[i]!.text !== "providerFetch") continue;
    if (tokens[i - 1]?.kind === SyntaxKind.DotToken || tokens[i + 1]?.kind !== SyntaxKind.OpenParenToken) continue;
    let depth = 1, argStart = true, j = i + 2;
    while (depth > 0 && j < tokens.length) {
      const kind = tokens[j]!.kind;
      if (depth === 1 && argStart && kind === SyntaxKind.OpenBraceToken) {
        const names = new Set<string>();
        let braces = 1, calls = 0, propStart = true;
        j++;
        while (braces > 0 && j < tokens.length) {
          const inner = tokens[j]!;
          if (inner.kind === SyntaxKind.OpenBraceToken) { braces++; propStart = false; j++; continue; }
          if (inner.kind === SyntaxKind.CloseBraceToken) { braces--; propStart = false; j++; continue; }
          if (inner.kind === SyntaxKind.OpenParenToken || inner.kind === SyntaxKind.OpenBracketToken) { calls++; propStart = false; j++; continue; }
          if (inner.kind === SyntaxKind.CloseParenToken || inner.kind === SyntaxKind.CloseBracketToken) { calls--; propStart = false; j++; continue; }
          if (braces === 1 && calls === 0) {
            if (inner.kind === SyntaxKind.CommaToken) { propStart = true; j++; continue; }
            if (propStart && (inner.kind === SyntaxKind.Identifier || inner.kind === SyntaxKind.StringLiteral)
              && followers.has(tokens[j + 1]!.kind)) {
              names.add(inner.text.replace(/^["']|["']$/g, ""));
            }
            propStart = false;
          }
          j++;
        }
        optionSets.push(names);
        argStart = false;
        continue;
      }
      if (kind === SyntaxKind.OpenParenToken || kind === SyntaxKind.OpenBracketToken || kind === SyntaxKind.OpenBraceToken) depth++;
      else if (kind === SyntaxKind.CloseParenToken || kind === SyntaxKind.CloseBracketToken || kind === SyntaxKind.CloseBraceToken) depth--;
      else if (depth === 1 && kind === SyntaxKind.CommaToken) argStart = true;
      else if (depth === 1) argStart = false;
      j++;
    }
    i = j;
  }
  return optionSets;
}

// A saved-result continuation is a new inference priced on the frame actually leaving:
// the reconstructed input and the successor's own output ceiling. The opening request's
// estimate must not stand in -- a small opening followed by a large stored tool result
// is exactly the case the stale reservation used to admit past the root ceiling.
test("a continuation is priced on the reconstructed frame, not the opening estimate", async () => {
  const root = "native-successor-estimate";
  prepareInjectionSpendHome(); bindWorkflowBudgetConfig(null);
  configureSharedSpendLedger(spendPolicyFromConfig({ root: { maxTokens: 2000 } }));
  const x = await beginInjection({}, injectionConfig(), "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
  // A small saved result still fits: exact pricing is not an across-the-board refusal.
  const small = advertiseInjection(x.socket, "small");
  completeInjection(x.socket, { output: [small] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed"));
  const before1 = x.socket.frames.length;
  x.send(continuationFrame({ type: "response.create", previous_response_id: x.id, input: [savedResult("small")] }));
  await waitForInjection(() => x.socket.frames.length === before1 + 1
    || x.sent.some(frame => frame.type === "error"));
  expect(x.socket.frames).toHaveLength(before1 + 1);
  const successor = "estimate-successor";
  x.socket.emit({ type: "response.created", response: { id: successor, previous_response_id: x.id, output: [] } });
  const big = advertiseInjection(x.socket, "big");
  completeInjection(x.socket, { output: [big] }, successor);
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === successor));
  // A ~20 KB stored tool result prices the successor near 5k tokens: past the 2000 root
  // ceiling, where the opening request's ~100-token reservation would have admitted it.
  const before2 = x.socket.frames.length;
  x.send(continuationFrame({ type: "response.create", previous_response_id: successor,
    input: [savedResult("big", "x".repeat(20000))] }));
  await waitForInjection(() => x.sent.some(frame => frame.type === "error")
    || x.socket.frames.length > before2);
  expect(x.socket.frames).toHaveLength(before2);
  const refusal = x.sent.find(frame => frame.type === "error")!;
  expect(refusal.status).toBe(429);
  expect(refusal.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_spend_exhausted");
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 2, active: 0 });
  expect(fallbackCalls).toBe(0);
});

// A pre-output upstream refusal settles as a real 4xx; when the outbound body still
// carries opaque state, the single-shot rebuild leg opens a second WebSocket exchange and
// the steering channel rebinds to it. That recovered socket runs the same continuation
// admission as the first: under a spent root ceiling the successor is refused before it
// can leave, never sent as an uncounted third inference.
test("a recovered native socket still routes continuations through admission", async () => {
  const root = "native-recovered-continuation";
  prepareInjectionSpendHome();
  bindWorkflowBudgetConfig({ workflowBudget: { maxPhysicalSends: 2 } });
  configureSharedSpendLedger(spendPolicyFromConfig(undefined));
  InjectionSocket.suppressAutoCreated = true;
  const x = injectionClient(
    { multi_agent: undefined, input: [{ type: "reasoning", encrypted_content: "opaque-blob" }] },
    { ...injectionConfig(), codexNativeSteering: true }, "test",
    { "x-codex-parent-thread-id": root, "thread-id": root });
  const first = await (async () => {
    await waitForInjection(() => InjectionSocket.all.length === 1 && InjectionSocket.all[0]!.frames.length === 1);
    return InjectionSocket.all[0]!;
  })();
  // The error must arrive before any lifecycle frame: a held or committed preamble keeps
  // in-body delivery instead of the replayable 4xx projection this recovery needs.
  first.emit({ type: "error", status_code: 400,
    error: { type: "invalid_request_error", code: "invalid_encrypted_content", message: "undecryptable" } });
  InjectionSocket.suppressAutoCreated = false;
  await waitForInjection(() => InjectionSocket.all.length === 2);
  const recovered = InjectionSocket.all[1]!;
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.created"));
  // Send 1 was refused upstream; the opaque-blob rebuild is send 2 of the root's 2.
  expect(workflowBudgetSnapshot(root)?.sends).toBe(2);
  expect(x.ws.data.nativeControl).toBeDefined();
  advertiseInjection(recovered, "recovered-call");
  x.send({ type: "response.steer", previous_response_id: recovered.root, input: "continue with the saved result" });
  await waitForInjection(() => recovered.frames.length === 2);
  recovered.emit({ type: "response.steer.accepted", steer: { id: "steer-1", previous_response_id: recovered.root } });
  completeInjection(recovered, {}, recovered.root);
  recovered.emit({ type: "response.steer.pending", steer: { id: "steer-1", previous_response_id: recovered.root },
    reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: "recovered-call" }] });
  await waitForInjection(() => x.sent.some(frame => frame.type === "response.completed" && frame.response.id === recovered.root));
  const before = recovered.frames.length;
  x.send(continuationFrame({ type: "response.create", previous_response_id: recovered.root,
    input: [savedResult("recovered-call")], multi_agent: undefined }));
  await waitForInjection(() => x.sent.some(frame => frame.type === "error")
    || recovered.frames.length > before);
  expect(recovered.frames).toHaveLength(before);
  const refusal = x.sent.find(frame => frame.type === "error")!;
  expect(refusal.status).toBe(429);
  expect(refusal.headers?.[WORKFLOW_LOCAL_REFUSAL_HEADER]).toBe("workflow_sends_exhausted");
  await waitForInjection(() => !x.ws.data.nativeControl);
  expect(workflowBudgetSnapshot(root)).toMatchObject({ sends: 2, active: 0 });
  expect(fallbackCalls).toBe(0);
});
