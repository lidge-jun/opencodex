import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ConsequenceDialog from "../src/pages/integrations/ConsequenceDialog";
import IntegrationPlanDetails from "../src/pages/integrations/IntegrationPlanDetails";
import { IntegrationApiError, type IntegrationMutationPlan } from "../src/pages/integrations/integration-api";

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
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage"] as const) {
    previous.set(key, Reflect.get(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: Reflect.get(windowValue, key) });
  }
  previous.set("IS_REACT_ACT_ENVIRONMENT", Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = createRoot(container);
});

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
