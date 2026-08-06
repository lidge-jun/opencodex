import { expect, test } from "bun:test";

/**
 * WP3 (devlog/_plan/260725_gui_view_consolidation/030_account_state_lift.md):
 * Codex account state has ONE owner. Providers instantiates the controller and hands
 * the same instance to the Overview tab and the Accounts tab, so a mutation on either
 * surface is immediately visible on the other.
 */

const read = (p: string) => Bun.file(new URL(p, import.meta.url)).text();

test("the controller is the single data owner and exposes the agreed contract", async () => {
  const hook = await read("../src/hooks/useCodexAccountPool.ts");

  // Data layer (Q6): list / active / loading / switching plus the mutating actions.
  for (const member of [
    "accounts", "activeId", "loadState", "switchingId", "pauseUpdatingId", "pausingExhausted", "activeNeedsReauth",
    "load", "switchAccount", "setAccountPaused", "pauseExhaustedAccounts", "saveAlias", "removeAccount", "syncAfterAccountAdded",
    // WP2 (260730_gui_hydration_loading_unify/010): progress is part of the contract, because a
    // forced quota refresh keeps `loadState` at "ready" and would otherwise be invisible.
    "refreshing", "initialLoading",
  ]) {
    expect(hook).toContain(member);
  }

  // Presentation state must NOT have migrated into the hook.
  for (const presentation of ["setConfirm", "setShowAdd", "resetPopup", "creditDetails", "toastError"]) {
    expect(hook).not.toContain(presentation);
  }

  // Observers arrive through one subscription path; load() takes no observer argument.
  expect(hook).toContain("subscribeLoadObserver");
  expect(hook).toContain("load(refreshQuota?: boolean): Promise<boolean>");
  expect(hook).not.toContain("load(refreshQuota?: boolean, observer");
});

test("main and added account cards expose the same persisted pause control", async () => {
  const pool = await read("../src/components/CodexAccountPool.tsx");
  const mainCard = await read("../src/components/codex-account-pool-main-card.tsx");
  const addedCards = await read("../src/components/codex-account-pool-cards.tsx");

  expect(pool).toContain("controller.setAccountPaused(account.id, paused)");
  expect(mainCard).toContain("onTogglePause(mainSwitchEntry)");
  expect(addedCards).toContain("onTogglePause(a)");
  expect(mainCard).toContain("<CodexPauseToggleLabel");
  expect(addedCards).toContain("<CodexPauseToggleLabel");
  expect(mainCard).toContain('saving={pauseUpdatingId === "__main__"}');
  expect(addedCards).toContain("saving={pauseUpdatingId === a.id}");
});

test("the pool header exposes one bulk action backed by the atomic endpoint", async () => {
  const pool = await read("../src/components/CodexAccountPool.tsx");
  const mainCard = await read("../src/components/codex-account-pool-main-card.tsx");
  const hook = await read("../src/hooks/useCodexAccountPool.ts");

  expect(pool).toContain("controller.pauseExhaustedAccounts()");
  expect(mainCard).toContain('t("codexAuth.pauseExhausted")');
  expect(hook).toContain("/api/codex-auth/accounts/pause-exhausted");
});

test("pause is a token lease, so two holders cannot cancel each other", async () => {
  const hook = await read("../src/hooks/useCodexAccountPool.ts");

  // A reason-string Set would let the first resume release the second holder's pause.
  expect(hook).toContain("pauseRefresh(): PauseToken");
  expect(hook).toContain("resumeRefresh(token: PauseToken)");
  expect(hook).toContain("pauseTokensRef");
  expect(hook).not.toContain("pauseRefresh(reason");
});

test("Providers owns exactly one controller and shares it with both surfaces", async () => {
  const providers = await read("../src/pages/Providers.tsx");
  const details = await read("../src/components/provider-workspace/ProviderDetails.tsx");
  const panel = await read("../src/components/provider-workspace/ProviderAuthPanel.tsx");

  // Exactly one instantiation on the page.
  expect(providers.match(/useCodexAccountPool\(/g)?.length).toBe(1);
  expect(providers).toContain("codexController={codexPool}");

  // Threaded through the details shell into the auth panel...
  expect(details).toContain("codexController={codexController}");
  expect(panel).toContain("controller={codexController}");

  // The full panel lives on the Accounts tab; Overview keeps the compact auth summary.
  expect(details).not.toContain("accountPanel={authSurface ?");
  const overview = await read("../src/components/provider-workspace/ProviderOverview.tsx");
  expect(overview).not.toContain("accountPanel");
});

test("a nested pool cannot start a second poll loop", async () => {
  const pool = await read("../src/components/CodexAccountPool.tsx");
  const hook = await read("../src/hooks/useCodexAccountPool.ts");

  // React forbids conditional hooks, so the fallback instance is created but inert.
  expect(pool).toContain("useCodexAccountPool(apiBase, !injectedController)");
  expect(hook).toContain("if (!enabled) return;");

  // The component no longer owns loading, polling, or the account list.
  expect(pool).not.toContain("const load = useCallback");
  expect(pool).not.toContain("setAccounts");
  expect(pool).not.toContain("loadGenerationRef");
});

test("CodexAccountEntry is defined once, by the controller", async () => {
  const hook = await read("../src/hooks/useCodexAccountPool.ts");
  const pool = await read("../src/components/CodexAccountPool.tsx");

  expect(hook).toContain("export interface CodexAccountEntry");
  // The component re-exports rather than declaring a rival shape.
  expect(pool).not.toContain("export interface CodexAccountEntry");
  expect(pool).toContain('export type { CodexAccountEntry } from "../hooks/useCodexAccountPool";');
});
