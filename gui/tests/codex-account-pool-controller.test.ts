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
    "accounts", "activeId", "loadState", "switchingId", "pauseUpdatingId", "priorityUpdatingId",
    "pausingExhausted", "activeNeedsReauth", "activePinnedId",
    "load", "switchAccount", "setAccountPaused", "setAccountPriority", "pauseExhaustedAccounts",
    "saveAlias", "removeAccount", "syncAfterAccountAdded",
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

test("both cards expose the selection-order control, and pin writes cannot overlap", async () => {
  const pool = await read("../src/components/CodexAccountPool.tsx");
  const mainCard = await read("../src/components/codex-account-pool-main-card.tsx");
  const addedCards = await read("../src/components/codex-account-pool-cards.tsx");
  const hook = await read("../src/hooks/useCodexAccountPool.ts");

  expect(pool).toContain("controller.setAccountPriority(account.id, priority)");
  for (const card of [mainCard, addedCards]) {
    expect(card).toContain("<AccountPriorityControl");
    expect(card).toContain("<AccountPriorityBadge");
  }
  // The main card's synthesized entry has to carry the order, or saving from that card
  // would post the default over whatever the account currently has.
  expect(mainCard).toContain("priority: main?.priority ?? 0");

  // A hand-picked account says so on its OWN card, not on whichever card routing landed
  // on: under round-robin the pin caps the tier while the cursor moves inside it, so an
  // active-card badge disappeared while the pin was still suppressing the higher tiers.
  // The paused guard stays — pausing releases the pin, so a pin naming an excluded account
  // is a stale read that must not be rendered.
  // Asserted as the gate, not as exact markup: the rendered outcome is covered behaviourally
  // in codex-account-pool-pinned-badge.test.tsx, so pinning the JSX here only adds a second
  // place to edit when the span's classes change.
  expect(mainCard).toMatch(/pinnedId === "__main__" && !main\?\.paused/);
  expect(addedCards).toMatch(/a\.id === pinnedId && !a\.paused/);
  for (const card of [mainCard, addedCards]) expect(card).toContain('t("codexAuth.pinned")');
  expect(pool).toContain("pinnedId={activePinnedId}");

  expect(hook).toContain("/api/codex-auth/accounts/priority");
  // Sharing pauseMutationRef would make a pause toggle and an order change on two
  // different accounts reject each other for no reason. The manual switch is the one
  // deliberate exception: it writes the same pin an order write clears, so overlapping
  // them lets the client settle on the inverse of the server's final pin. Cross-gated
  // in both directions, since either can be the newer statement.
  const priorityStart = hook.indexOf("const setAccountPriority");
  const priorityEnd = hook.indexOf("const pauseExhaustedAccounts");
  expect(priorityStart).toBeGreaterThanOrEqual(0);
  expect(priorityEnd).toBeGreaterThan(priorityStart);
  const priorityMutation = hook.slice(priorityStart, priorityEnd);
  expect(priorityMutation).toMatch(/if \(priorityMutationRef\.current \|\| switchingRef\.current\) return/);
  expect(priorityMutation).not.toContain("pauseMutationRef");

  const switchStart = hook.indexOf("const switchAccount");
  const switchEnd = hook.indexOf("const saveAlias");
  expect(switchStart).toBeGreaterThanOrEqual(0);
  expect(switchEnd).toBeGreaterThan(switchStart);
  const switchMutation = hook.slice(switchStart, switchEnd);
  expect(switchMutation).toMatch(/if \(switchingRef\.current \|\| priorityMutationRef\.current\) return/);

  // A refused mutation returns "busy", which both call sites drop without a toast, so
  // each control must be unavailable while the other is in flight rather than silently
  // ineffective.
  for (const card of [mainCard, addedCards]) {
    expect(card).toContain("disabled={priorityUpdatingId !== null || switchingId !== null}");
  }
  expect(pool).toContain("orderBusy={priorityUpdatingId !== null}");
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
