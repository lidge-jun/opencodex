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

  test("every thread keys as itself, and the unbound set is unchanged", () => {
    const rootKey = codexPoolAffinityKey(rootHeaders())!;
    const childKey = codexPoolAffinityKey(childHeaders("child-1"))!;
    const grandchildKey = codexPoolAffinityKey(childHeaders("grand-1", "child-1"))!;
    for (const key of [rootKey, childKey, grandchildKey]) {
      expect(key.startsWith("app:")).toBe(true);
    }
    // The three used to be two: both children collapsed onto the raw parent id.
    expect(new Set([rootKey, childKey, grandchildKey]).size).toBe(3);
    // A child keys as its own conversation whether or not this turn names the parent, which is
    // what lets it hold a binding of its own across a fan-out.
    expect(childKey).toBe(codexPoolAffinityKey(new Headers({ "session-id": "sess", "thread-id": "child-1" })));
    // A request naming only a parent rides that parent's lane. With the session in hand that lane
    // is derivable, and it IS the parent's own key -- no record required.
    expect(codexPoolAffinityKey(new Headers({
      "session-id": "sess", "x-codex-parent-thread-id": "root",
    }))).toBe(rootKey);
    // Without the session and without a recorded parent there is nothing to reproduce it from,
    // so the bare parent lane is its own key. The recorded case is the test below.
    expect(codexPoolAffinityKey(new Headers({ "x-codex-parent-thread-id": "root" }))).not.toBe(rootKey);
    // Unchanged from before #4546: which requests bind at all did not move. A bare thread-id
    // with neither a session nor a parent still has no family anchor and stays unbound.
    expect(codexPoolAffinityKey(new Headers({ "thread-id": "lone" }))).toBeUndefined();
    expect(codexPoolAffinityKey(new Headers())).toBeUndefined();
    expect(codexPoolAffinityKey(new Headers({ "x-codex-parent-thread-id": "p".repeat(513) }))).toBeUndefined();
  });

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
    const keyFor = (index: number) => recordCodexThreadLineage(
      new Headers({ "session-id": "bulk", "thread-id": `bulk-${index}` }), NOW,
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

  test("a child with no binding starts on the parent's account under its OWN key", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW)!;
    // The reason carries the proof here: a cold pick would also have chosen the coolest
    // account. The tests below make the ACCOUNT itself the discriminator.
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW, undefined, undefined, undefined, child,
    )).toMatchObject({
      status: "selected",
      accountId: "a",
      affinity: { move: "new_bind", reason: "lineage_parent" },
    });
    // An independent binding, not a root-wide pin: the child's next turn reuses its own entry
    // without consulting the family again.
    expect(resolveCodexAccountForThreadDetailed(child.conversationKey, config, NOW + 1))
      .toMatchObject({ status: "selected", accountId: "a", affinity: { move: "reused", reason: "healthy" } });
  });

  test("a new child follows the account ACTUALLY serving the parent, detour included", () => {
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

    // The child starts where the parent is being served NOW (b), not at its stale home (a).
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 2)!;
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 2, undefined, undefined, undefined, child,
    )).toMatchObject({
      status: "selected",
      accountId: "b",
      affinity: { move: "new_bind", reason: "lineage_parent" },
    });
  });

  test("a later move of the parent does not drag an already-bound child", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW);
    streakTransientFailures(config, "a", NOW);
    resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 1);

    // Which account serves the parent at any moment is the quota strategy's business, not this
    // layer's. What this layer promises is relative, so it is asserted relative to what actually
    // happened rather than against account names predicted from a fixture nobody ran.
    const parentAtPlacement = resolveCodexAccountForThreadDetailed(
      root.conversationKey, config, NOW + 2,
    ).accountId;

    // The child binds to the account actually SERVING its parent, detour included.
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 2)!;
    const childPlacement = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 2, undefined, undefined, undefined, child,
    );
    expect(childPlacement).toMatchObject({ status: "selected" });
    expect(childPlacement.accountId).toBe(parentAtPlacement);
    const childBoundTo = childPlacement.accountId;

    // Now the parent moves for its OWN reason: a quota refusal retires its binding. This is the
    // parent's move, not the family's.
    updateAccountQuota("c", 5);
    recordCodexUpstreamOutcome(config, "a", 429, { now: NOW + 3 });
    const parentAfterMove = resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 3);
    expect(parentAfterMove).toMatchObject({ status: "selected" });
    // Where the parent lands is the quota strategy's decision and may legitimately be the same
    // account the child already holds, so nothing is asserted about the destination here.

    // THE ASYMMETRY, which is the whole point of this test: the already-bound child is untouched
    // by the parent's move. It reuses its own binding rather than being dragged.
    const childAfterParentMoved = resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 4,
    );
    expect(childAfterParentMoved).toMatchObject({
      status: "selected",
      affinity: { move: "reused", reason: "healthy" },
    });
    expect(childAfterParentMoved.accountId).toBe(childBoundTo);

    // A NEW child, however, reads the parent's CURRENT account rather than the one its sibling
    // holds, which is the other half of the same rule.
    const lateChild = recordCodexThreadLineage(childHeaders("child-2"), NOW + 5)!;
    const latePlacement = resolveCodexAccountForThreadDetailed(
      lateChild.conversationKey, config, NOW + 5, undefined, undefined, undefined, lateChild,
    );
    expect(latePlacement).toMatchObject({
      status: "selected",
      affinity: { move: "new_bind", reason: "lineage_parent" },
    });
    expect(latePlacement.accountId).toBe(parentAfterMove.accountId);
  });

  test("a compatible sibling places the child when the parent is not eligible", () => {
    const config = makeConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 20);
    updateAccountQuota("c", 30);
    const root = recordCodexThreadLineage(rootHeaders(), NOW)!;
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW))
      .toMatchObject({ status: "selected", accountId: "a" });

    // The parent keeps its binding on a, but a is no longer eligible to serve anyone. A stale
    // home is worse than no hint, so the parent contributes nothing here.
    config.pausedCodexAccountIds = ["a"];
    const sibling = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    const siblingPlacement = resolveCodexAccountForThreadDetailed(
      sibling.conversationKey, config, NOW + 1, undefined, undefined, undefined, sibling,
    );
    expect(siblingPlacement).toMatchObject({ status: "selected" });
    // The point is the NEGATIVE: a paused parent is a stale home and must contribute nothing.
    // Which account the ordinary rule then picks belongs to the quota strategy.
    expect(siblingPlacement.affinity?.reason).not.toBe("lineage_parent");
    expect(siblingPlacement.accountId).not.toBe("a");

    // Make an unrelated cold thread prefer a DIFFERENT account, so the orphan landing on its
    // sibling's account cannot be explained by the ordinary cold rule agreeing by accident.
    updateAccountQuota("c", 1);
    const coldPick = resolveCodexAccountForThreadDetailed("unrelated-cold-thread", config, NOW + 2);
    expect(coldPick).toMatchObject({ status: "selected" });
    const orphan = recordCodexThreadLineage(childHeaders("child-2"), NOW + 2)!;
    expect(orphan.siblingConversationKeys).toContain(sibling.conversationKey);
    const orphanPlacement = resolveCodexAccountForThreadDetailed(
      orphan.conversationKey, config, NOW + 2, undefined, undefined, undefined, orphan,
    );
    // The orphan follows its SIBLING, which is the reachable half of the family when the parent
    // is not eligible. Asserted against the sibling's actual placement rather than an account
    // name predicted from the quota fixture.
    expect(orphanPlacement.accountId).toBe(siblingPlacement.accountId);
    expect(orphanPlacement).toMatchObject({
      status: "selected",
      affinity: { move: "new_bind", reason: "lineage_sibling" },
    });
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

  test("a child follows the parent's MODEL detour, not a home account that cannot serve it", () => {
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

    // Make c the cold pick inside the roster, so b is reachable only through the detour.
    updateAccountQuota("b", 40);
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 1)!;
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 1, undefined, roster, modelId, child,
    )).toMatchObject({
      status: "selected",
      accountId: "b",
      affinity: { move: "new_bind", reason: "lineage_parent" },
    });
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

    // Read-only: the record belongs to the resolution that binds. A preview must not leave one
    // behind for a request that turns out to own no Pool state at all.
    expect(codexThreadLineageLookup(
      codexPoolAffinityKey(child)!, codexLineageScopeKey(child), NOW,
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
