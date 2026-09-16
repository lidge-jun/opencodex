import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";
import {
  RESPONSES_CORE_MODULES,
  readResponsesCoreModule,
} from "../helpers/responses-core-source";
import { createResponsesSendBudget } from "../../src/server/responses/request-send-budget";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { TransientSendBudget } from "../../src/lib/upstream-retry";

// Existing, separately owned siblings at the extraction boundary. A new owner
// cannot silently disappear from source-oracle coverage by being absent from the inventory.
const EXISTING_BOUNDARIES = new Set([
  "account-change-state.ts", "agent-task-recovery.ts", "codex-auth-error.ts",
  "codex-ws-metadata.ts", "codex-ws-wire.ts", "collaboration.ts",
  "combo-session-recall.ts", "combo-stream-preflight.ts", "context-overflow.ts",
  "empty-completion-guard.ts", "encrypted-payload.ts", "fetch-helpers.ts",
  "input-admission.ts", "outbound-body-guard.ts", "passthrough-error.ts",
  "responses-field-backfill.ts", "terminal-guard.ts", "upstream-error.ts", "ws-upstream.ts",
]);

function siblingImports(source: string): string[] {
  return Array.from(source.matchAll(/\bfrom\s+["']\.\/([^"']+)["']/g), match =>
    match[1]!.endsWith(".ts") ? match[1]! : `${match[1]}.ts`);
}

function ownerGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = ["core.ts"];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (graph.has(name) || EXISTING_BOUNDARIES.has(name)) continue;
    const source = readFileSync(repoPath("src", "server", "responses", name), "utf8");
    const children = siblingImports(source).filter(child => !EXISTING_BOUNDARIES.has(child));
    graph.set(name, children);
    pending.push(...children);
  }
  return graph;
}

describe("Responses core module boundaries", () => {
  test("every extracted owner is covered and remains below 2000 physical lines", () => {
    const graph = ownerGraph();
    expect([...graph.keys()].sort()).toEqual([...RESPONSES_CORE_MODULES].sort());
    for (const name of RESPONSES_CORE_MODULES) {
      const text = readResponsesCoreModule(name);
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      expect({ name, belowLimit: lines < 2000 }).toEqual({ name, belowLimit: true });
    }
  });

  test("owner dependencies are acyclic, including type-only state contracts", () => {
    const graph = ownerGraph();
    const complete = new Set<string>();
    const active = new Set<string>();
    const visit = (name: string): void => {
      expect({ name, cycle: active.has(name) }).toEqual({ name, cycle: false });
      if (complete.has(name)) return;
      active.add(name);
      for (const child of graph.get(name) ?? []) visit(child);
      active.delete(name);
      complete.add(name);
    };
    visit("core.ts");
  });

  test("recursive combo dispatch enters the public ingress without a reverse core import", () => {
    const combo = readResponsesCoreModule("core-combo.ts");
    const prepare = readResponsesCoreModule("request-prepare.ts");
    expect(combo).toContain("requestDispatchers.handleResponses(");
    expect(prepare).toContain("requestDispatchers.handleComboResponses(");
    for (const name of RESPONSES_CORE_MODULES) {
      if (name !== "core.ts") expect(siblingImports(readResponsesCoreModule(name))).not.toContain("core.ts");
    }
    expect(readResponsesCoreModule("core.ts"))
      .toContain("const requestDispatchers: ResponsesDispatchers = { handleResponses, handleComboResponses };");
  });

  test("lease transfer retains both finally owners until response construction settles", () => {
    const ingress = readResponsesCoreModule("core.ts");
    const native = readResponsesCoreModule("passthrough-execution.ts");
    expect(ingress).toContain("return await executePassthroughResponse(");
    expect(native).toContain("return await deliverPassthroughResponse(");
    expect(native.indexOf("admissionState.pendingHostAdmissionLease = null;"))
      .toBeLessThan(native.indexOf("await preparePassthroughExchange("));
    expect(native).toMatch(/finally\s*\{\s*if \(nativeHostState\.lease\)\s*\{\s*releaseUpstreamHostAdmission\(nativeHostState\.lease\);\s*releaseCodexAuthContextProbeLease\(admissionState\.authCtx\);/);
    expect(ingress).toMatch(/finally\s*\{\s*if \(admissionState\.pendingHostAdmissionLease\)/);
  });

  test("local admission decisions cannot shadow the outer lease owner", () => {
    const prepare = readResponsesCoreModule("request-prepare.ts");
    expect(prepare).toContain("const admission = acquireUpstreamHostAdmission(");
    expect(prepare).toContain("admissionState.pendingHostAdmissionLease = admission.lease;");
    expect(prepare).not.toContain("admission.pendingHostAdmissionLease = admission.lease;");
  });

  test("live adapter, alias and continuation counters are not copied into snapshots", () => {
    const transport = readResponsesCoreModule("request-transport.ts");
    const effects = readResponsesCoreModule("response-effects.ts");
    const exchange = readResponsesCoreModule("adapter-dispatch.ts");
    const continuation = readResponsesCoreModule("adapter-continuation.ts");
    for (const name of ["activeAdapter", "runTurnAdapter", "sameTargetRequest", "transportToken", "genericFailovers"]) {
      expect(transport).toContain(`get ${name}()`);
      expect(transport).toContain(`set ${name}(value:`);
    }
    expect(effects).toContain("set responseCompletionCancelled(value:");
    expect(exchange).toContain("set rateLimitRetries(value:");
    expect(continuation).toContain("adapterExchange.rateLimitRetries");
    expect(continuation).toContain("transportState.activeAdapter");
  });
});

function budgetOwner(sendBudget: TransientSendBudget) {
  const translatorBudget = createTranslatorBudget();
  const result = createResponsesSendBudget({
    req: new Request("http://localhost/v1/responses"),
    logCtx: { model: "test", provider: "test" },
    options: { translatorBudget, sendBudget },
  });
  if (result instanceof Response) {
    translatorBudget.dispose();
    throw new Error("Unexpected workflow refusal without a workflow root");
  }
  return { owner: result, dispose: () => translatorBudget.dispose() };
}

describe("Responses request-owned send budget after extraction", () => {
  test("legacy holders retain identity and an exhausted remainder stays zero", () => {
    const holder = { used: 2 };
    const { owner, dispose } = budgetOwner(holder);
    try {
      expect(owner.remainingTransientSendBudget(3)).toBe(1);
      owner.noteTransientSends(1);
      expect(holder.used).toBe(3);
      expect(owner.remainingTransientSendBudget(3)).toBe(0);
      expect(owner.adapterSendBudget).toBeUndefined();
    } finally { dispose(); }
  });

  test("two call frames inheriting one holder consume the same allowance", () => {
    const holder = createRequestExecutionBudget();
    const a = budgetOwner(holder);
    const b = budgetOwner(holder);
    try {
      expect(a.owner.adapterSendBudget).toBe(holder);
      expect(b.owner.adapterSendBudget).toBe(holder);
      a.owner.noteTransientSends(1);
      b.owner.noteTransientSends(1);
      expect(holder.used).toBe(2);
      expect(a.owner.remainingTransientSendBudget(3)).toBe(1);
      expect(b.owner.remainingTransientSendBudget(3)).toBe(1);
    } finally { a.dispose(); b.dispose(); }
  });

  test("a transferred recovery permit is the exact closure-owned single-use permit", () => {
    const holder = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(holder);
    try {
      owner.noteTransientSends(3);
      const hop = owner.reserveCredentialHop("auth-recovery", "test|model", true);
      expect(hop.allowed).toBe(true);
      if (!hop.permit) throw new Error("Expected a recovery permit");
      owner.pendingHopPermit = hop.permit;
      const allowance = owner.recoverySendAllowance(3, "auth-recovery", "test|model");
      expect(allowance.attempts).toBe(1);
      expect(allowance.permit).toBe(hop.permit);
      expect(owner.pendingHopPermit).toBeUndefined();
      expect(hop.permit.use()).toBe(true);
      expect(hop.permit.use()).toBe(false);
      owner.noteTransientSends(1);
      expect(holder.used).toBe(4);
      expect(owner.remainingTransientSendBudget(3)).toBe(0);
    } finally { dispose(); }
  });

  test("an adapter reservation spends the handed-down hop instead of buying a second send", () => {
    const holder = createRequestExecutionBudget();
    const { owner, dispose } = budgetOwner(holder);
    try {
      const hop = owner.reserveCredentialHop("auth-recovery", "test|model", true);
      expect(hop.allowed).toBe(true);
      if (!hop.permit) throw new Error("Expected a recovery permit");
      // The reservation is the charge, before anything dispatched.
      expect(holder.used).toBe(1);
      owner.pendingHopPermit = hop.permit;
      const adapterBudget = owner.adapterDispatchBudget;
      if (!adapterBudget) throw new Error("Expected an adapter dispatch budget");

      // Kiro and Cursor reserve once per physical send. Their FIRST reservation in this leg is
      // the hop's own replay, so it spends the permit rather than charging again (#4709).
      const first = adapterBudget.reserveDispatch({ sendClass: "transient", targetKey: "url" });
      expect(first.allowed).toBe(true);
      if (!first.allowed) throw new Error("unreachable");
      expect(first.permit.use()).toBe(true);
      expect(first.permit.use()).toBe(false);
      expect(holder.used).toBe(1);
      expect(owner.pendingHopPermit).toBeUndefined();

      // Every later send in the same ladder is a new physical send and is charged.
      const second = adapterBudget.reserveDispatch({ sendClass: "transient", targetKey: "url" });
      expect(second.allowed).toBe(true);
      expect(holder.used).toBe(2);
      // The view delegates live rather than snapshotting: a frozen copy would read as a budget
      // that can never be exhausted.
      expect(adapterBudget.used).toBe(2);
      expect(adapterBudget.remainingBaseSends(3)).toBe(1);
    } finally { dispose(); }
  });
});
