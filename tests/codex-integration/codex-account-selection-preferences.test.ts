import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  resolveCodexAccountForThread,
  resolveCodexAccountForThreadDetailed,
} from "../../src/codex/routing";
import { clearPoolRotationState } from "../../src/codex/pool-rotation";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  clearAccountNeedsReauth,
  clearAccountQuota,
  updateAccountQuota,
} from "../../src/codex/auth-api";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Selection PREFERENCES, as distinct from selection ELIGIBILITY.
 *
 * `isCodexAccountSelectable` stays the sole authority for whether an account may serve at all --
 * pause, plan exclusion, quota cooldown and avoidance, soft avoidance, refresh cooling, usability
 * -- and `codexAccountBlockReason` reports which of those guards fired. Nothing in this file
 * touches that. What these cases pin is the layer above it: given a list those guards already
 * produced, which member does routing prefer, and what must a preference never be allowed to do.
 *
 * Two preferences are covered, and they share one obligation. Neither may empty a candidate set
 * that the old behaviour would have served from, and neither may overrule an explicit operator
 * control. Every positive case below is therefore paired with the negative that would make the
 * preference dangerous if it were missing.
 *
 * They live here rather than in `codex-routing.test.ts` because that file is at its file-size
 * ratchet cap.
 */

let TEST_DIR = "";
let previousOpencodexHome: string | undefined;
let previousCodexHome: string | undefined;

const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

function installRoutingScratchHome(): void {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-selection-pref-"));
  // These cases exercise account state, not the operating system ACL implementation.
  setIcaclsRunnerForTests(() => ICACLS_OK);
  setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
  process.env.OPENCODEX_HOME = TEST_DIR;
  process.env.CODEX_HOME = TEST_DIR;
}

async function removeRoutingScratchHome(): Promise<void> {
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

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    providers: {},
    codexAccounts: [
      { id: "a", email: "a@test", isMain: false },
      { id: "b", email: "b@test", isMain: false },
    ],
    activeCodexAccountId: "a",
    autoSwitchThreshold: 80,
    upstreamFailoverThreshold: 3,
    ...overrides,
  } as OcxConfig;
}

function installScratchState(): void {
  installRoutingScratchHome();
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  clearPoolRotationState();
  clearAccountNeedsReauth("a");
  clearAccountNeedsReauth("b");
  saveTestCredential("a");
  saveTestCredential("b");
}

async function removeScratchState(): Promise<void> {
  try {
    clearAccountQuota();
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearPoolRotationState();
    clearAccountNeedsReauth("a");
    clearAccountNeedsReauth("b");
  } finally {
    await removeRoutingScratchHome();
  }
}

describe("model entitlement ordering (#4768)", () => {
  beforeEach(installScratchState);
  afterEach(removeScratchState);

  /** `a` is ordered above `b`; the persisted operator selection is the lower tier. */
  function orderedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
    return makeConfig({
      activeCodexAccountId: "b",
      codexAccountPriorities: { a: 1 },
      ...overrides,
    } as Partial<OcxConfig>);
  }

  /**
   * A pool holding a Plus account and a Free account handed Sol/Astra to whichever account
   * rotation reached first, and the Free account answered with the upstream unsupported-model
   * 400. The roster evidence to avoid that already existed; selection never consulted it.
   *
   * Ordering, not eligibility. `a` is the higher priority tier here and still loses the pick,
   * which is the point: an account that cannot serve the model at all should not be the reason
   * a tier is selected.
   */
  test("a confirmed roster denial removes an account from selection", () => {
    const config = orderedConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");
    expect(resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["a"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });
  });

  /**
   * The negative case, and the one that decides whether this rule is safe to ship.
   *
   * Roster evidence can be wrong in the direction that matters -- a shard that has not caught up
   * reports a denial for a model the account genuinely owns -- so a rule that let evidence empty
   * the candidate set would turn a stale shard into a total outage for the model. Honouring the
   * denial is a preference; having somewhere to send the request is not.
   *
   * Unlike `modelEligibleAccountIds`, which is an eligibility boundary and legitimately resolves
   * to nothing, this may never reach `status: "none"`.
   */
  test("denials never empty the candidate set", () => {
    const config = orderedConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    const resolution = resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["a", "b", MAIN_CODEX_ACCOUNT_ID]) },
    );

    expect(resolution.status).toBe("selected");
    expect(["a", "b", MAIN_CODEX_ACCOUNT_ID])
      .toContain((resolution as { accountId: string }).accountId);
  });

  /**
   * Evidence about an account this pool does not hold must not perturb the pick. Same
   * configuration and the same expectation as the tier case above, which selects `a`.
   */
  test("a denial naming an account outside the pool changes nothing", () => {
    const config = orderedConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["not-in-this-pool"]) },
    )).toMatchObject({ status: "selected", accountId: "a" });
  });

  /**
   * Roster evidence orders the pool's own discretion; it does not overrule an operator. Dropping
   * a pinned account would do more than demote it -- `selectPriorityTier` reads the pin to lower
   * the tier ceiling, so a pin filtered out beforehand stops acting as a ceiling and silently
   * re-enables the tiers the operator excluded. An operator who pins an account upstream will
   * refuse still gets the alternate-account retry; the pool does not decide they were wrong.
   */
  test("a denial never drops the operator's pinned account", () => {
    const config = orderedConfig({ activeCodexAccountPinned: "b" });
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["b"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });
  });

  /**
   * The path that actually broke, and the reason it is pinned separately.
   *
   * `getEligiblePoolAccounts` is not the only door into selection: an already-ACTIVE account is
   * served straight from `isCodexAccountSelectable` and never passes through the eligible list.
   * So a rule that only orders that list left the reported case unfixed -- once the denied
   * account becomes the shared cursor, every request keeps going to it -- and
   * `pickPriorityPreemption` does not rescue it, because it refuses to move toward a tier that
   * does not strictly outrank the active one, which is exactly the shape here.
   *
   * The first resolution below promotes the cursor to `a` through preemption. The second asks
   * again with `a` denied, so it exercises the cursor path rather than the unbound one.
   */
  test("a denial moves a request off the shared cursor without persisting the move", () => {
    const config = orderedConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");
    expect(resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["a"]) },
    )).toMatchObject({ status: "selected", accountId: "b" });

    // One request's correction for one model. The operator's persisted selection is untouched,
    // and the very next request without that evidence is back on the cursor.
    expect(config.activeCodexAccountId).toBe("b");
    expect(resolveCodexAccountForThread(null, config)).toBe("a");
  });

  /**
   * The companion negative, and the gap that let the case above ship broken: every other case
   * here supplies evidence, so none of them pinned what happens with NONE. Unknown must change
   * nothing, and "nothing" has to include the shared-cursor path, not just the eligible list.
   */
  test("no denial evidence leaves the shared-cursor path exactly as it was", () => {
    const config = orderedConfig();
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);

    expect(resolveCodexAccountForThread(null, config)).toBe("a");

    // Absent evidence, and evidence about an account the cursor does not name, are both inert.
    expect(resolveCodexAccountForThreadDetailed(null, config, Date.now(), "shared"))
      .toMatchObject({ status: "selected", accountId: "a" });
    expect(resolveCodexAccountForThreadDetailed(
      null,
      config,
      Date.now(),
      "shared",
      { deniedModelAccountIds: new Set(["b"]) },
    )).toMatchObject({ status: "selected", accountId: "a" });
  });
});

describe("uploaded-file account retention (#4778)", () => {
  beforeEach(installScratchState);
  afterEach(removeScratchState);

  /**
   * Uploaded files are scoped to the account that issued them, so moving a conversation that
   * carries live references does not cost a cold prefix -- it orphans the reference, and because
   * the reference stays in conversation history every later turn is refused with
   * `409 account_change_file_scope` until the user re-uploads or restarts.
   *
   * `pool.cacheAffinity: false` is pinned here because that is the configuration where the
   * voluntary move still happens; the flag trades cache locality for capacity, and it was never
   * asking to trade correctness for capacity. Both halves are asserted against the same starting
   * state, on separate thread ids so neither resolution disturbs the other's binding.
   */
  test("a conversation carrying uploaded files keeps its issuing account", () => {
    const config = makeConfig({ pool: { cacheAffinity: false } });
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("plain-thread", config, now)).toBe("a");
    expect(resolveCodexAccountForThread("file-thread", config, now)).toBe("a");

    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    const later = now + 1_000;

    // Control: without the evidence this is the ordinary over-threshold move (#584).
    expect(resolveCodexAccountForThreadDetailed("plain-thread", config, later))
      .toMatchObject({ status: "selected", accountId: "b" });
    expect(resolveCodexAccountForThreadDetailed(
      "file-thread",
      config,
      later,
      undefined,
      { retainAccountForUploadedFiles: true },
    )).toMatchObject({ status: "selected", accountId: "a" });
  });

  /**
   * The negative case. Retention covers the VOLUNTARY move only: it must never wedge a
   * conversation on an account that cannot serve it, because the issuing account can always
   * become exhausted and the #4710 refusal is the correct answer in that corner rather than a
   * pin that keeps sending at a dead account.
   */
  test("uploaded-file retention still yields to genuine exhaustion", () => {
    const config = makeConfig({ pool: { cacheAffinity: false } });
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("file-thread", config, now)).toBe("a");

    updateAccountQuota("a", 100);
    updateAccountQuota("b", 5);
    expect(resolveCodexAccountForThreadDetailed(
      "file-thread",
      config,
      now + 1_000,
      undefined,
      { retainAccountForUploadedFiles: true },
    )).toMatchObject({ status: "selected", accountId: "b" });
  });

  /**
   * On the default configuration the retention is already implied by `pool.cacheAffinity`, so
   * the evidence must be inert rather than a second, differently-shaped rule. This is the
   * happy-path claim: an install that never attaches a file and an install that does resolve
   * identically.
   */
  test("uploaded-file retention changes nothing under the default cache affinity", () => {
    const config = makeConfig();
    const now = 1_800_000_000_000;
    updateAccountQuota("a", 10);
    updateAccountQuota("b", 10);
    expect(resolveCodexAccountForThread("plain-thread", config, now)).toBe("a");
    expect(resolveCodexAccountForThread("file-thread", config, now)).toBe("a");

    updateAccountQuota("a", 95);
    updateAccountQuota("b", 5);
    const later = now + CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS + 1;

    expect(resolveCodexAccountForThreadDetailed("plain-thread", config, later))
      .toMatchObject({ status: "selected", accountId: "a" });
    expect(resolveCodexAccountForThreadDetailed(
      "file-thread",
      config,
      later,
      undefined,
      { retainAccountForUploadedFiles: true },
    )).toMatchObject({ status: "selected", accountId: "a" });
  });
});
