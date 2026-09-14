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
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
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

const rootHeaders = () => new Headers({ "session-id": "root", "thread-id": "root" });
const childHeaders = (threadId: string, parentId = "root") => new Headers({
  "session-id": "root",
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
    expect(childKey).toBe(codexPoolAffinityKey(new Headers({ "session-id": "root", "thread-id": "child-1" })));
    // A request naming only a parent rides that parent's lane. Codex's root sends its session
    // id as its own thread id, so for the root that lane IS the root's binding.
    expect(codexPoolAffinityKey(new Headers({ "x-codex-parent-thread-id": "root" }))).toBe(rootKey);
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

    // The child binds to b, the account actually serving its parent.
    const child = recordCodexThreadLineage(childHeaders("child-1"), NOW + 2)!;
    expect(resolveCodexAccountForThreadDetailed(
      child.conversationKey, config, NOW + 2, undefined, undefined, undefined, child,
    )).toMatchObject({ status: "selected", accountId: "b" });

    // Now the parent moves for its OWN reason: a quota refusal retires its binding, and c is
    // the coolest account left. This is the parent's move, not the family's.
    updateAccountQuota("c", 5);
    recordCodexUpstreamOutcome(config, "a", 429, { now: NOW + 3 });
    expect(resolveCodexAccountForThreadDetailed(root.conversationKey, config, NOW + 3))
      .toMatchObject({ status: "selected", accountId: "c" });

    // The asymmetry: the child is still progressing on b. Its own policy may move it later for
    // its own reasons; the parent having moved is not one of them.
    expect(resolveCodexAccountForThreadDetailed(child.conversationKey, config, NOW + 4))
      .toMatchObject({ status: "selected", accountId: "b", affinity: { move: "reused", reason: "healthy" } });

    // A NEW child, however, reads the parent's current account, which is now c.
    const lateChild = recordCodexThreadLineage(childHeaders("child-2"), NOW + 5)!;
    expect(resolveCodexAccountForThreadDetailed(
      lateChild.conversationKey, config, NOW + 5, undefined, undefined, undefined, lateChild,
    )).toMatchObject({
      status: "selected",
      accountId: "c",
      affinity: { move: "new_bind", reason: "lineage_parent" },
    });
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
    expect(siblingPlacement).toMatchObject({ status: "selected", accountId: "b" });
    expect(siblingPlacement.affinity?.reason).not.toBe("lineage_parent");

    // c is now the coolest account, so an unrelated cold thread goes to c. The orphan child
    // still starts on b, which is only reachable through its sibling.
    updateAccountQuota("c", 1);
    expect(resolveCodexAccountForThreadDetailed("unrelated-cold-thread", config, NOW + 2))
      .toMatchObject({ status: "selected", accountId: "c" });
    const orphan = recordCodexThreadLineage(childHeaders("child-2"), NOW + 2)!;
    expect(orphan.siblingConversationKeys).toContain(sibling.conversationKey);
    expect(resolveCodexAccountForThreadDetailed(
      orphan.conversationKey, config, NOW + 2, undefined, undefined, undefined, orphan,
    )).toMatchObject({
      status: "selected",
      accountId: "b",
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

