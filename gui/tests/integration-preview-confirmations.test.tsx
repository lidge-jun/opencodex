import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ConsequenceDialog from "../src/pages/integrations/ConsequenceDialog";
import IntegrationPlanDetails from "../src/pages/integrations/IntegrationPlanDetails";
import RestoreDialog from "../src/pages/integrations/RestoreDialog";
import { bindingFor, IntegrationApiError, type IntegrationMutationPlan, type IntegrationPlanBinding } from "../src/pages/integrations/integration-api";

const copy = {
  titleKey: "integrations.dialog.apply.title" as const,
  changesKey: "integrations.dialog.apply.changes" as const,
  breakageKey: "integrations.dialog.apply.breakage" as const,
  undoKey: "integrations.dialog.apply.undo" as const,
  confirmKey: "integrations.dialog.apply.confirm" as const,
};

function plan(fingerprint: string, path = "providers.opencodex"): IntegrationMutationPlan {
  return {
    version: 1,
    clientId: "hermes",
    operation: "apply",
    state: "absent",
    foreignEdit: "none",
    changes: [
      { kind: "add", path },
      { kind: "snapshot", path: "$snapshot" },
      { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ],
    fingerprint,
    canApply: true,
    willChange: true,
  };
}

let windowValue: Window;
let container: HTMLElement;
let root: Root | null;
const previous = new Map<string, unknown>();

beforeEach(() => {
  windowValue = new Window({ url: "http://localhost/#integrations" });
  container = windowValue.document.createElement("div") as unknown as HTMLElement;
  windowValue.document.body.appendChild(container as unknown as Node);
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "fetch"] as const) {
    previous.set(key, Reflect.get(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(windowValue, key) });
  }
  previous.set("IS_REACT_ACT_ENVIRONMENT", Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(container);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`State did not settle: ${container.textContent}`);
    await act(async () => { await new Promise<void>(resolve => windowValue.setTimeout(resolve, 0)); });
  }
}

afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); root = null; });
  for (const [key, value] of previous) Object.defineProperty(globalThis, key, { configurable: true, value });
  previous.clear();
});

test("plan details render a semantic safe-path list without surrounding private values", async () => {
  const privateCanary = "secret-model-account-value";
  await act(async () => {
    root?.render(<LanguageProvider><IntegrationPlanDetails plan={plan("p1:11111111111111111111111111111111")} /></LanguageProvider>);
  });
  const list = container.querySelector("ul.integration-plan-changes");
  expect(list).not.toBeNull();
  expect(list?.querySelector("code")?.textContent).toBe("providers.opencodex");
  expect(container.textContent).not.toContain(privateCanary);
});

test("a profile no-op explains document scope and still confirms its fingerprint", async () => {
  const noOpPlan: IntegrationMutationPlan = {
    ...plan("p1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    clientId: "aside",
    profileId: 2,
    operation: "disable",
    state: "absent",
    changes: [],
    willChange: false,
  };
  let confirmed: IntegrationPlanBinding | null = null;
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <ConsequenceDialog
          copy={{
            titleKey: "integrations.dialog.disable.title",
            changesKey: "integrations.dialog.disable.changes",
            breakageKey: "integrations.dialog.disable.breakage",
            undoKey: "integrations.dialog.disable.undo",
            confirmKey: "integrations.dialog.disable.confirm",
          }}
          plan={noOpPlan}
          onClose={() => {}}
          onConfirm={candidate => { if (candidate) confirmed = bindingFor(candidate); }}
        />
      </LanguageProvider>,
    );
  });
  expect(container.textContent).toContain("No changes to the managed client document are needed");
  expect(container.textContent).toContain("The profile sync preference will still be saved");
  expect(container.textContent).not.toContain("A backup is saved first");
  const confirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Disable") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  expect(confirmed).toEqual({ operation: "disable", planFingerprint: noOpPlan.fingerprint });
});

test("a stale confirmation replaces the plan and requires a second explicit press", async () => {
  const original = plan("p1:11111111111111111111111111111111");
  const fresh = plan("p1:22222222222222222222222222222222", "providers.opencodex");
  const confirmed: string[] = [];
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <ConsequenceDialog
          copy={copy}
          plan={original}
          onClose={() => {}}
          onConfirm={candidate => {
            if (!candidate) return;
            confirmed.push(candidate.fingerprint);
            if (confirmed.length === 1) throw new IntegrationApiError(409, { code: "integration_preview_stale", plan: fresh });
          }}
        />
      </LanguageProvider>,
    );
  });
  expect(container.textContent).toContain("A backup is saved first");
  const confirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Apply") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  expect(confirmed).toEqual([original.fingerprint]);
  expect(container.textContent).toContain("Review the updated plan");
  expect(confirmed).toHaveLength(1);
  await act(async () => { confirm.click(); });
  expect(confirmed).toEqual([original.fingerprint, fresh.fingerprint]);
});

test("preview loading and failure keep confirmation disabled", async () => {
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <ConsequenceDialog
          copy={copy}
          planLoading
          planFailure="The change plan could not be loaded. Nothing was changed."
          onClose={() => {}}
          onConfirm={() => { throw new Error("unreachable"); }}
        />
      </LanguageProvider>,
    );
  });
  const confirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Apply") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
});

test("a pending mutation marks and announces the busy dialog", async () => {
  let finish: (() => void) | undefined;
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <ConsequenceDialog
          copy={copy}
          plan={plan("p1:44444444444444444444444444444444")}
          onClose={() => {}}
          onConfirm={() => new Promise<void>(resolve => { finish = resolve; })}
        />
      </LanguageProvider>,
    );
  });
  const confirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Apply") as HTMLButtonElement;
  await act(async () => { confirm.click(); });
  expect(container.querySelector("dialog")?.getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("Applying the confirmed change");
  await act(async () => { finish?.(); });
});

test("keyboard cancel closes an idle dialog and restores its trigger", async () => {
  const trigger = windowValue.document.createElement("button") as unknown as HTMLButtonElement;
  windowValue.document.body.insertBefore(trigger as unknown as Node, container as unknown as Node);
  trigger.focus();
  let closed = 0;
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <ConsequenceDialog copy={copy} plan={plan("p1:33333333333333333333333333333333")} onClose={() => { closed += 1; }} onConfirm={() => {}} />
      </LanguageProvider>,
    );
  });
  const dialog = container.querySelector("dialog")!;
  await act(async () => { dialog.dispatchEvent(new windowValue.Event("cancel", { cancelable: true })); });
  expect(closed).toBe(1);
  await act(async () => { root?.unmount(); root = null; });
  expect(windowValue.document.activeElement).toBe(trigger);
});

test("restore retains confirmDrift when stale drift becomes non-drift", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let mutations = 0;
  const restorePlan = (
    fingerprint: string,
    foreignEdit: "none" | "drift",
    allowed = true,
  ): IntegrationMutationPlan => ({
    ...plan(fingerprint),
    operation: "restore",
    state: "current",
    foreignEdit,
    changes: allowed ? [
      { kind: "replace", path: "providers.opencodex" },
      { kind: "snapshot", path: "$snapshot" },
      { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ] : [],
    canApply: allowed,
    willChange: allowed,
    ...(allowed ? {} : { refusalReason: "drift_requires_confirm" as const }),
  });
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, body });
    if (url.endsWith("/restore/preview")) {
      return Response.json(body.confirmDrift === true
        ? restorePlan(`p1:${"7".repeat(32)}`, "drift")
        : restorePlan(`p1:${"6".repeat(32)}`, "drift", false));
    }
    mutations += 1;
    if (mutations === 1) {
      return Response.json({
        code: "integration_preview_stale",
        plan: restorePlan(`p1:${"8".repeat(32)}`, "none"),
      }, { status: 409 });
    }
    return Response.json({ ok: true, clientId: "hermes", changed: true, state: "current", message: "restored" });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(windowValue, "fetch", { configurable: true, value: mockFetch });
  let closed = 0;
  await act(async () => {
    root?.render(
      <LanguageProvider>
        <RestoreDialog
          apiBase=""
          row={{
            opId: "op-drift-to-clean", clientId: "hermes", kind: "apply",
            at: "2026-09-20T00:00:00.000Z", configPath: "/tmp/hermes.yaml",
            snapshot: "stored", undoable: true, deletable: false,
          }}
          onClose={() => { closed += 1; }}
          onRestored={() => {}}
        />
      </LanguageProvider>,
    );
  });
  await waitFor(() => Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Back up newer edits and restore" && !button.disabled));
  const driftConfirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Back up newer edits and restore") as HTMLButtonElement;
  await act(async () => { driftConfirm.click(); });
  await waitFor(() => container.textContent?.includes("Review the updated plan") === true);
  expect(requests.filter(request => request.url.endsWith("/restore"))).toHaveLength(1);
  expect(requests.filter(request => request.url.endsWith("/restore"))[0]?.body.confirmDrift).toBe(true);

  await waitFor(() => Array.from(container.querySelectorAll("button")).some(button => button.textContent?.trim() === "Restore" && !button.disabled));
  const cleanConfirm = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Restore") as HTMLButtonElement;
  await act(async () => { cleanConfirm.click(); });
  await waitFor(() => closed === 1);
  const mutationsSent = requests.filter(request => request.url.endsWith("/restore"));
  expect(mutationsSent).toHaveLength(2);
  expect(mutationsSent[1]?.body).toMatchObject({
    confirmDrift: true,
    operation: "restore",
    planFingerprint: `p1:${"8".repeat(32)}`,
  });
});

test("restore preview can be cancelled and aborts a late read", async () => {
  let previewSignal: AbortSignal | null | undefined;
  let resolvePreview: ((response: Response) => void) | undefined;
  const mockFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    previewSignal = init?.signal;
    return new Promise<Response>(resolve => { resolvePreview = resolve; });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  Object.defineProperty(windowValue, "fetch", { configurable: true, value: mockFetch });
  let closed = 0;
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <RestoreDialog
        apiBase=""
        row={{
          opId: "op-cancel-preview", clientId: "hermes", kind: "apply",
          at: "2026-09-20T00:00:00.000Z", configPath: "/tmp/hermes.yaml",
          snapshot: "stored", undoable: true, deletable: false,
        }}
        onClose={() => { closed += 1; setOpen(false); }}
        onRestored={() => {}}
      />
    ) : null;
  }
  await act(async () => { root?.render(<LanguageProvider><Harness /></LanguageProvider>); });
  await waitFor(() => previewSignal !== undefined && resolvePreview !== undefined);
  expect(previewSignal?.aborted).toBe(false);
  const cancel = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.trim() === "Cancel") as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  await act(async () => { cancel.click(); });
  expect(closed).toBe(1);
  expect(previewSignal?.aborted).toBe(true);
  expect(container.querySelector("dialog")).toBeNull();

  await act(async () => {
    resolvePreview!(Response.json({
      ...plan(`p1:${"9".repeat(32)}`),
      operation: "restore",
      state: "current",
    }));
    await new Promise<void>(resolve => windowValue.setTimeout(resolve, 0));
  });
  expect(container.querySelector("dialog")).toBeNull();
  expect(container.textContent).not.toContain("Server change plan");
});
