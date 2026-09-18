/**
 * Codex V2 lineage and FIRST PLACEMENT (#4546, wp8).
 *
 * Two defects are pinned here. Keying: every child of one parent used to bind under the RAW
 * parent id, one shared entry unrelated to the root's own binding, so no child could hold a
 * binding of its own and a grandchild keyed on a key nobody had bound. Placement: a child with
 * no binding started cold even while its parent was being served warm somewhere.
 *
 * The asymmetry is the point and has its own test below. A family hint decides where a child
 * STARTS; it is not a root-wide pin, so a later move of the parent must leave an already-bound
 * child exactly where it is.
 *
 * The fixture mirrors tests/codex-integration/codex-pool-rotation.test.ts: quota strategy, three
 * accounts, and an explicit usage order, so every expected account is the one a cold pick would
 * NOT have produced wherever that distinction carries the proof.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  recordCodexUpstreamOutcome,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { codexPoolAffinityKey, previewCodexPoolLineage } from "../../src/codex/auth-context";
import {
  CODEX_LINEAGE_IDLE_TTL_MS,
  CODEX_LINEAGE_MAX_ENTRIES,
  CODEX_LINEAGE_MAX_SCOPES,
  clearCodexThreadLineageForTests,
  codexLineageRootForRequest,
  codexLineageScopeKey,
  codexLineageWorkflowLane,
  codexThreadLineageLookup,
  recordCodexThreadLineage,
} from "../../src/codex/lineage";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/auth-api";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig } from "../../src/types";

let TEST_DIR = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const ACCOUNT_IDS = ["a", "b", "c"] as const;
const NOW = 1_700_000_000_000;

function installScratchHome(): void {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-lineage-"));
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_DIR;
}

async function removeScratchHome(): Promise<void> {
  const ownedDirectory = TEST_DIR;
  TEST_DIR = "";
  try {
    await flushConfigDirHardeningForTests();
  } finally {
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (ownedDirectory) removeTreeWithRetry(ownedDirectory);
  }
}

function saveTestCredential(id: string): void {
  saveCodexAccountCredential(id, {
    accessToken: `access-${id}`,
    refreshToken: `refresh-${id}`,
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: `acct-${id}`,
  });
}

/** Quota strategy with an explicit usage order, so every cold pick below is predictable. */
function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: ACCOUNT_IDS.map(id => ({ id, email: `${id}@example.test`, isMain: false })),
    accountPoolStrategy: "quota",
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

/**
 * The session id is deliberately NOT the thread id. Codex's own root sends the same string for
 * both, and a fixture that copies it makes HMAC(parent, parent) accidentally equal the root's
 * key -- which is exactly the coincidence that hid the parent-only defect pinned below.
 */
const rootHeaders = () => new Headers({ "session-id": "sess", "thread-id": "root" });
const childHeaders = (threadId: string, parentId = "root") => new Headers({
  "session-id": "sess",
  "thread-id": threadId,
  "x-codex-parent-thread-id": parentId,
});

/** One transient streak: the binding stays put while this request is sent elsewhere. */
function streakTransientFailures(config: OcxConfig, accountId: string, now: number): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    recordCodexUpstreamOutcome(config, accountId, 503, { now });
  }
}

describe("codex thread lineage and first placement (#4546 wp8)", () => {
  beforeEach(() => {
    installScratchHome();
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearCodexThreadLineageForTests();
    clearPoolRotationState();
    clearAccountQuota();
    for (const id of ACCOUNT_IDS) saveTestCredential(id);
  });

  afterEach(async () => {
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearCodexThreadLineageForTests();
      clearPoolRotationState();
    } finally {
      await removeScratchHome();
    }
  });

  /**
   * The per-thread keying this unit introduced was retired by #4780, which makes the tree the
   * binding unit. What that test asserted now lives in the cohort block at the end of this file:
   * the key shape and the unchanged unbound set are pinned there, and the grandchild-orphan
   * property wp8 was written to prevent is pinned there too, as a property rather than as a
   * consequence of per-thread keys. The placement tests below are rewritten for the same reason.
   *
   * A request naming only a parent still rides that parent's lane; that case keeps its own test.
   */

  test("lineage resolves the root transitively and stays inside its auth scope", () => {
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW)!;
    const grandchild = recordCodexThreadLineage(childHeaders("grand-1", "child-1"), NOW)!;
    expect(root.rootSessionKey).toBe(root.conversationKey);
    expect(child.parentConversationKey).toBe(root.conversationKey);
    expect(child.rootSessionKey).toBe(root.rootSessionKey);
    // Transitive: the grandchild's spend belongs to the ROOT workflow, not to child-1.
    expect(grandchild.parentConversationKey).toBe(child.conversationKey);
    expect(grandchild.rootSessionKey).toBe(root.rootSessionKey);

    const scope = codexLineageScopeKey(rootHeaders());
    expect(codexThreadLineageLookup(grandchild.conversationKey, scope, NOW)).toMatchObject({
      rootSessionKey: root.rootSessionKey,
      parentThreadId: "child-1",
    });
    expect(codexLineageRootForRequest(childHeaders("grand-1", "child-1"), NOW)).toBe(root.rootSessionKey);
    // Another authenticated caller presenting identical thread ids sees nothing of this scope.
    const otherScope = codexLineageScopeKey(new Headers({ authorization: "Bearer other" }));
    expect(otherScope).not.toBe(scope);
    expect(codexThreadLineageLookup(grandchild.conversationKey, otherScope, NOW)).toBeUndefined();
    // Idle expiry bounds the table exactly like the binding map it feeds.
    expect(codexThreadLineageLookup(
      grandchild.conversationKey, scope, NOW + CODEX_LINEAGE_IDLE_TTL_MS + 1,
    )).toBeUndefined();
  });

  test("the table is bounded in both dimensions, not just per scope", () => {
    // One cohort per index. Members of ONE tree now share a conversation key, so a fixture that
    // varied only the thread id would write every record under a single key and the eviction
    // probe below would read the newest record back through the oldest key.
    const keyFor = (index: number) => recordCodexThreadLineage(
      new Headers({ "session-id": `bulk-${index}`, "thread-id": `bulk-${index}` }), NOW,
    )!.conversationKey;
    const oldest = keyFor(0);
    for (let index = 1; index <= CODEX_LINEAGE_MAX_ENTRIES; index += 1) keyFor(index);
    const newest = keyFor(CODEX_LINEAGE_MAX_ENTRIES + 1);
    const localScope = codexLineageScopeKey(new Headers());
    expect(codexThreadLineageLookup(oldest, localScope, NOW)).toBeUndefined();
    expect(codexThreadLineageLookup(newest, localScope, NOW)).toBeDefined();

    // The scope map is the one an untrusted caller could grow without the cap below.
    const held = new Headers({ authorization: "Bearer held", "session-id": "s", "thread-id": "t" });
    const heldKey = recordCodexThreadLineage(held, NOW)!.conversationKey;
    expect(codexThreadLineageLookup(heldKey, codexLineageScopeKey(held), NOW)).toBeDefined();
    for (let index = 0; index <= CODEX_LINEAGE_MAX_SCOPES; index += 1) {
      recordCodexThreadLineage(new Headers({
        authorization: `Bearer caller-${index}`,
        "session-id": "s",
        "thread-id": "t",
      }), NOW);
    }
    expect(codexThreadLineageLookup(heldKey, codexLineageScopeKey(held), NOW)).toBeUndefined();
  });

  test("a child is served where its cohort is being served, detour included", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    // The binding is HELD on a while the request itself detours to b.
    streakTransientFailures(config, "a", NOW);
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 1)).toMatchObject({
      status: "selected",
      accountId: "b",
      affinity: { move: "detour", reason: "transient" },
    });

    // The child shares the cohort's binding, so it takes the same detour rather than starting
    // anywhere of its own. Under per-thread keys this needed a placement hint to reach b; the
    // cohort key makes it the same binding, so there is nothing to place.
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 2)!;
    expect(child.conversationKey).toBe(root.conversationKey);
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 2, undefined, undefined, undefined, child,
    )).toMatchObject({
      status: "selected",
      accountId: "b",
      affinity: { move: "detour", reason: "transient" },
    });
  });

  test("a move of the cohort carries every member, including an already-active child", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW);
    streakTransientFailures(config, "a", NOW);
    resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 1);

    const parentAtPlacement = resolveCodexAccountForThreadDetailed(
      root.conversationKey, config, NOW + 2,
    ).accountId;

    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 2)!;
    const childPlacement = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 2, undefined, undefined, undefined, child,
    );
    expect(childPlacement).toMatchObject({ status: "selected" });
    expect(childPlacement.accountId).toBe(parentAtPlacement);

    // A quota refusal retires the binding. Under per-thread keys this was the PARENT's move and
    // the asymmetry test pinned that an already-bound child was not dragged by it. #4780 retires
    // that asymmetry deliberately: there is one binding, so the move is the cohort's and every
    // member is on the other side of it. That is the cost of cohort cache locality, and it is
    // the behaviour the invariant "same prompt_cache_key, same account" requires.
    updateAccountQuota("c", 5);
    recordCodexUpstreamOutcome(config, "a", 429, { now: NOW + 3 });
    const parentAfterMove = resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 3);
    expect(parentAfterMove).toMatchObject({ status: "selected" });

    const childAfterParentMoved = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 4,
    );
    expect(childAfterParentMoved).toMatchObject({ status: "selected" });
    // Where the cohort lands is the quota strategy's decision, so this is asserted relative to
    // what actually happened rather than against an account name predicted from the fixture.
    expect(childAfterParentMoved.accountId).toBe(parentAfterMove.accountId);

    // A later sibling joins the same binding rather than being placed against it.
    const lateChild = recordCodexThreadLineage(childHeaders("child-2"), NOW + 5)!;
    expect(lateChild.conversationKey).toBe(root.conversationKey);
    const latePlacement = resolveCodexAccountForThreadDetailed(
      lateChild.conversationKey, config, NOW + 5, undefined, undefined, undefined, lateChild,
    );
    expect(latePlacement).toMatchObject({ status: "selected" });
    expect(latePlacement.accountId).toBe(parentAfterMove.accountId);
  });

  test("a cohort whose account became ineligible rebinds off it, once, for everyone", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    // a is no longer eligible to serve anyone. A stale home is worse than no hint, so the
    // cohort must leave it rather than keep resolving there.
    config.pausedCodexAccountIds = ["a"];
    const sibling = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    const siblingPlacement = resolveCodexAccountForThreadDetailed(
      sibling.conversationKey, config, NOW + 1, undefined, undefined, undefined, sibling,
    );
    expect(siblingPlacement).toMatchObject({ status: "selected" });
    // The point is the NEGATIVE: a paused account must contribute nothing. Which account the
    // ordinary rule then picks belongs to the quota strategy.
    expect(siblingPlacement.affinity?.reason).not.toBe("lineage_parent");
    expect(siblingPlacement.accountId).not.toBe("a");

    // Make an unrelated cold thread prefer a DIFFERENT account, so a later member landing with
    // its cohort cannot be explained by the ordinary cold rule agreeing by accident.
    updateAccountQuota("c", 1);
    const coldPick = resolveCodexAccountForThreadDetailed("unrelated-cold-thread", config, NOW + 2);
    expect(coldPick).toMatchObject({ status: "selected" });
    const orphan = recordCodexThreadLineage(childHeaders("child-2"), NOW + 2)!;
    expect(orphan.conversationKey).toBe(sibling.conversationKey);
    const orphanPlacement = resolveCodexAccountForThreadDetailed(
      orphan.conversationKey, config, NOW + 2, undefined, undefined, undefined, orphan,
    );
    // It lands with its cohort rather than taking the cold pick, which is what the shared
    // binding buys. Asserted against the sibling's actual placement rather than an account name
    // predicted from the quota fixture.
    expect(orphanPlacement.accountId).toBe(siblingPlacement.accountId);
    expect(orphanPlacement).toMatchObject({ status: "selected" });
  });

  test("no known family account falls back to ordinary cold placement", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    // The parent was never seen and holds no binding, so lineage cannot help. The request takes
    // exactly the pick an unrelated new thread would.
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW)!;
    const resolution = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW, undefined, undefined, undefined, child,
    );
    expect(resolution).toMatchObject({ status: "selected", accountId: "a" });
    expect(resolution.affinity?.reason).not.toBe("lineage_parent");
    expect(resolution.affinity?.reason).not.toBe("lineage_sibling");
  });

  test("a parent-only turn continues the parent's conversation, session id or not", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    // This turn carries nothing but the parent id, so only the recorded relation can reproduce
    // the key the parent bound under. HMAC(parent, parent) would be a different key, and this
    // conversation would start cold on every such turn while replacing the parent's record.
    const parentOnly = new Headers({ "x-codex-parent-thread-id": "root" });
    expect(codexPoolAffinityKey(parentOnly, NOW + 1)).toBe(root.conversationKey);

    const followUp = recordCodexThreadLineage(parentOnly, NOW + 1)!;
    expect(followUp.conversationKey).toBe(root.conversationKey);
    expect(resolveCodexAccountForThreadDetailed(
      followUp.conversationKey, config, NOW + 1, undefined, undefined, undefined, followUp,
    )).toMatchObject({
      status: "selected",
      accountId: "a",
      affinity: { move: "reused", reason: "healthy" },
    });

    // And recording it left the parent's record intact rather than overwriting it.
    expect(codexThreadLineageLookup(root.conversationKey, codexLineageScopeKey(parentOnly), NOW + 1))
      .toMatchObject({ conversationKey: root.conversationKey, rootSessionKey: root.rootSessionKey });
  });

  test("a binding left under the old raw-parent key is adopted, not rebound cold", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    // What a code swap under a live conversation leaves behind: a binding made by the pre-#4546
    // rule, under the RAW parent id. c is where it sits, and c is not where a cold pick goes.
    config.pausedCodexAccountIds = ["a", "b"];
    expect(resolveCodexAccountForThreadDetailed("root", config, NOW))
      .toMatchObject({ status: "selected", accountId: "c" });
    config.pausedCodexAccountIds = [];
    config.activeCodexAccountId = "a";

    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    expect(child.legacyConversationKey).toBe("root");
    // The conversation keeps its account AND its status as a bound thread. A cold rebind here is
    // the exact defect this unit exists to prevent, so "reused" is the assertion, not "c".
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 1, undefined, undefined, undefined, child,
    )).toMatchObject({
      status: "selected",
      accountId: "c",
      affinity: { move: "reused", reason: "healthy" },
    });

    // One way, once: nothing answers on the legacy key any more, so a request arriving there
    // binds fresh instead of finding the account it just handed over.
    expect(resolveCodexAccountForThreadDetailed("root", config, NOW + 2)).toMatchObject({
      status: "selected",
      accountId: "a",
      affinity: { move: "new_bind" },
    });
  });

  test("a cohort's members are detoured together when the binding cannot serve the model", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const modelId = "native-gated-model";
    const roster = { modelEligibleAccountIds: new Set(["b", "c"]) };

    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    // The parent's home account is a, chosen with no model roster in play.
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });
    // a is not entitled to this model, so the parent is now SERVED through a model detour on b
    // while its ordinary binding stays on a.
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW, undefined, roster, modelId))
      .toMatchObject({ status: "selected", accountId: "b" });

    // Move the roster's preferred account, so what is asserted cannot be satisfied by a stale
    // constant. Under per-thread keys the child was an unbound thread that had to be PLACED on
    // the parent's current detour target. Under cohort keying it shares the binding, so the
    // property is simply that both members are served in the same place at the same moment.
    updateAccountQuota("b", 40);
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    expect(child.conversationKey).toBe(root.conversationKey);
    const rootServed = resolveCodexAccountForThreadDetailed(
      root.conversationKey, config, NOW + 1, undefined, roster, modelId,
    );
    const childServed = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 1, undefined, roster, modelId, child,
    );
    expect(rootServed).toMatchObject({ status: "selected" });
    expect(childServed).toMatchObject({ status: "selected" });
    // The binding sits on a, which this roster cannot serve, so both are detoured off it.
    expect(childServed.accountId).not.toBe("a");
    expect(childServed.accountId).toBe(rootServed.accountId);
  });

  test("a preview reads the family only for a request that may own Pool state", () => {
    const config = makeConfig();
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    const child = childHeaders("child-1");

    expect(previewCodexPoolLineage(child, config)?.parentConversationKey).toBe(root.conversationKey);
    // An exact account selector authenticates outside the Pool and creates no affinity, so a
    // preview that followed the family here would decide model fallback against an account the
    // request will never be.
    expect(previewCodexPoolLineage(child, config, { accountId: "b" })).toBeUndefined();
    const callerOwned = childHeaders("child-2");
    callerOwned.set("authorization", "Bearer caller-owned-credential");
    expect(previewCodexPoolLineage(callerOwned, config, { requestScopedMainCredential: true }))
      .toBeUndefined();

    // Read-only: the record belongs to the resolution that binds, so even an ELIGIBLE preview
    // leaves nothing behind. Probed on a cohort nothing has recorded, because a member of an
    // already-recorded tree would answer from its root's entry now that they share one key.
    const unseen = new Headers({
      "session-id": "unseen-sess",
      "thread-id": "unseen-child",
      "x-codex-parent-thread-id": "unseen-root",
    });
    expect(previewCodexPoolLineage(unseen, config)).toBeDefined();
    expect(codexThreadLineageLookup(
      codexPoolAffinityKey(unseen)!, codexLineageScopeKey(unseen), NOW,
    )).toBeUndefined();
  });

  test("worker classification stays header-first and gains the lineage-backed answer", () => {
    // Header-only rule preserved: a parent plus a distinct thread-id is worker traffic.
    expect(codexLineageWorkflowLane(childHeaders("child-1"), NOW)).toBe("worker");
    // A bare thread-id with no recorded family is interactive, matching today's admission.
    expect(codexLineageWorkflowLane(new Headers({ "thread-id": "lone" }), NOW)).toBe("interactive");
    expect(codexLineageWorkflowLane(new Headers(), NOW)).toBe("interactive");
    // The lineage-backed half: a thread recorded with a parent is worker traffic even when THIS
    // request's headers no longer declare one.
    recordCodexThreadLineage(childHeaders("child-9"), NOW);
    expect(codexLineageWorkflowLane(new Headers({ "thread-id": "child-9" }), NOW)).toBe("worker");
  });
});

/**
 * #4780. The binding unit is the COHORT the client already declares, not the thread.
 *
 * Upstream keys its prompt cache on something the whole tree shares. `prompt_cache_key()`
 * returns `responses_metadata.session_id`, or `{source}:{parent_thread_id}` for an internal
 * session; `AgentControl.session_id` "is equal to the root thread's ID" and that one control
 * handle is shared with every sub-agent spawned from the root; and the upstream suite asserts
 * root and child carrying DIFFERENT thread ids while sending the SAME `promptCacheKey`.
 * openai/codex#44862 went further on 2026-09-11, making an ephemeral fork inherit its parent's
 * session id for exactly this reason.
 *
 * While the proxy keyed per thread, two requests could carry an identical `prompt_cache_key` and
 * be served by different accounts. The split-off member's key asserts a warm prefix that is
 * deterministically cold on its account, so the prompt is replayed in full and the cache can
 * never hit. Nothing fails; only tokens burn.
 *
 * THIS IS NOT A REVERT OF wp8. wp8 fixed a different defect: a child keyed under the RAW parent
 * id, producing one shared entry unrelated to the root's own `app:HMAC(session, thread)`
 * binding, so a grandchild keying on its own parent landed on a key nobody had ever bound. A
 * cohort key has no such incoherence, because the root's own binding IS the cohort key. The
 * orphan test below exists to prove that rather than assert it.
 */
describe("cohort pool affinity (#4780)", () => {
  beforeEach(() => {
    installScratchHome();
    clearThreadAccountMap();
    clearCodexUpstreamHealth();
    clearCodexThreadLineageForTests();
    clearPoolRotationState();
    clearAccountQuota();
    for (const id of ACCOUNT_IDS) saveTestCredential(id);
  });

  afterEach(async () => {
    try {
      clearAccountQuota();
      clearCodexUpstreamHealth();
      clearThreadAccountMap();
      clearCodexThreadLineageForTests();
      clearPoolRotationState();
    } finally {
      await removeScratchHome();
    }
  });

  test("one conversation tree resolves to one affinity key", () => {
    // The three ids upstream would send an identical prompt_cache_key for.
    const rootKey = codexPoolAffinityKey(rootHeaders())!;
    const childKey = codexPoolAffinityKey(childHeaders("child-1"))!;
    const siblingKey = codexPoolAffinityKey(childHeaders("child-2"))!;
    const grandchildKey = codexPoolAffinityKey(childHeaders("grand-1", "child-1"))!;

    expect(rootKey.startsWith("app:")).toBe(true);
    expect(new Set([rootKey, childKey, siblingKey, grandchildKey]).size).toBe(1);

    // A different tree is a different cohort, so this is a cohort key and not a constant.
    expect(codexPoolAffinityKey(new Headers({
      "session-id": "other-sess", "thread-id": "root",
    }))).not.toBe(rootKey);
    // The raw session id is never the key; it is still HMAC'd under the process-local secret.
    expect(rootKey).not.toContain("sess");
  });

  test("a grandchild never lands on a key nobody bound", () => {
    // wp8's defect, restated as the property that must hold under cohort keying. The root binds
    // first; every later member of the tree must resolve to the key the root is already on.
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW)!;
    const grandchild = recordCodexThreadLineage(childHeaders("grand-1", "child-1"), NOW)!;
    expect(child.conversationKey).toBe(root.conversationKey);
    expect(grandchild.conversationKey).toBe(root.conversationKey);
    expect(grandchild.rootSessionKey).toBe(root.conversationKey);

    // The session-less chain is the case that could still split, because each depth would
    // otherwise anchor on its own parent. A recorded parent carries the cohort down.
    const bare = (threadId: string, parentId: string) => new Headers({
      "thread-id": threadId, "x-codex-parent-thread-id": parentId,
    });
    const bareChild = recordCodexThreadLineage(bare("b-child", "b-root"), NOW)!;
    const bareGrandchild = recordCodexThreadLineage(bare("b-grand", "b-child"), NOW)!;
    expect(bareGrandchild.conversationKey).toBe(bareChild.conversationKey);
    // ...and it is a cohort of its own, not folded into the session-keyed tree above.
    expect(bareChild.conversationKey).not.toBe(root.conversationKey);
  });

  test("which requests bind at all is unchanged", () => {
    // Deliberately untouched by #4780: only the VALUE of the key moves, never the set of
    // requests that produce one. A bare thread-id still has no family anchor.
    expect(codexPoolAffinityKey(new Headers({ "thread-id": "lone" }))).toBeUndefined();
    expect(codexPoolAffinityKey(new Headers())).toBeUndefined();
    expect(codexPoolAffinityKey(new Headers({ "x-codex-parent-thread-id": "p".repeat(513) })))
      .toBeUndefined();
    expect(codexPoolAffinityKey(new Headers({ "session-id": "s".repeat(513), "thread-id": "t" })))
      .toBeUndefined();
  });

  test("a cohort key stays inside its authenticated scope", () => {
    // Two callers presenting the same session must not share a binding; the scope HMAC is what
    // keeps that true, and cohort keying must not have widened it.
    const mine = rootHeaders();
    const theirs = rootHeaders();
    theirs.set("authorization", "Bearer someone-else");
    expect(codexLineageScopeKey(theirs)).not.toBe(codexLineageScopeKey(mine));

    const root = recordCodexThreadLineage(mine, NOW)!;
    expect(codexThreadLineageLookup(root.conversationKey, codexLineageScopeKey(theirs), NOW))
      .toBeUndefined();
  });

  test("a tree shares one binding, so a move of any member moves the tree", () => {
    // The behaviour change this issue asks for, stated as the tradeoff it is: the tree gains
    // cache locality and gives up per-thread placement independence. A member cannot be served
    // by an account other than the one its cohort is bound to.
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);

    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    // A child arriving later is not an unbound thread any more: its cohort is already on a.
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 1, undefined, undefined, undefined, child,
    )).toMatchObject({
      status: "selected",
      accountId: "a",
      affinity: { move: "reused" },
    });

    // And when the cohort moves, every member moves with it, which is the whole point: the
    // prompt_cache_key they all send keeps naming one account.
    streakTransientFailures(config, "a", NOW + 2);
    const moved = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 3, undefined, undefined, undefined, child,
    );
    expect(moved).toMatchObject({ status: "selected" });
    expect(moved.accountId).not.toBe("a");
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 3))
      .toMatchObject({ status: "selected", accountId: moved.accountId });
  });
});
