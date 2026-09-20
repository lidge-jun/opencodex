import { capturePoolQuotaWriter, getValidCodexToken, isCodexAccountGenerationLive, forceRefreshCodexPoolToken, markCodexAccountValidated, markCodexAccountValidationFailed, readCodexAccountRecord, isTerminalCodexPoolRefreshFailure, CodexCredentialGenerationConflictError, CodexCredentialRefreshLockTimeoutError, CodexCredentialRefreshBusyError, CodexCredentialRefreshStaleError, TokenRefreshError } from "../account-store";
import type { PoolQuotaWriter } from "../quota-types";
import { isValidWhamHistoryObservation, getAccountQuota, isCompleteCodexQuotaRecoverySnapshot, parseUsageQuota, setAccountQuotaFromParsed } from "../quota";
import type { StoredAccountQuota, WhamUsageResponse } from "../quota";
import type { ManualResetRefreshLineage } from "../routing";
import { clearAccountNeedsReauth, markAccountNeedsReauth } from "../account-runtime-state";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import { codexWarmupFailureReason, warmCodexAccount } from "../warmup";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { ResourceAdmissionError } from "../../lib/admission";
import { WHAM_REQUEST_TIMEOUT_MS } from "../quota-recovery-timing";
import { claimQuotaRecovery, fencePropagatedQuotaRecovery, quotaRecoveryTerminalFor, releaseQuotaRecovery, settleQuotaRecovery, settleQuotaRecoveryTerminal } from "../quota-401-recovery";
import { seedLoginRowsForTests } from "./login-state";
import { nonEmptyPlan } from "./runtime-config";

export const POOL_CACHE_TTL = 5 * 60_000;
export const POOL_QUOTA_REFRESH_CONCURRENCY = 4;

export const MAIN_TERMINAL_AUTH_CODES = new Set([
  "invalid_workspace_selected",
  "invalid_refresh_token",
]);

export async function readMainAuthErrorCode(resp: Response): Promise<unknown> {
  try {
    const body = await readBoundedResponseBody(resp, { totalTimeoutMs: 1_000, inactivityTimeoutMs: 1_000 });
    if (!body.displaySafe) return undefined;
    const parsed = JSON.parse(body.text) as {
      detail?: { code?: unknown } | string;
      error?: { code?: unknown } | string;
      code?: unknown;
    };
    const code = typeof parsed.detail === "object" && parsed.detail !== null
      ? parsed.detail.code
      : typeof parsed.error === "object" && parsed.error !== null
        ? parsed.error.code
        : parsed.code;
    return code;
  } catch {
    return undefined;
  }
}

export interface PoolQuotaResult {
  /** Actual refresh result attached only to the successful usage replay. */
  resetRefreshLineage?: ManualResetRefreshLineage;
  quota: StoredAccountQuota | null;
  needsReauth: boolean;
  /** Failure source observed while obtaining the quota, when reauthentication is required. */
  reauthReason?: "refresh_failed" | "quota_unauthorized";
  /** Credential generation whose cache or network result this DTO state belongs to. */
  credentialGeneration?: number;
  /** Present only when this call freshly parsed a WHAM usage response. */
  freshQuota?: Omit<StoredAccountQuota, "updatedAt">;
  /** Present only when this call's WHAM response included a non-empty `plan_type`. */
  freshPlan?: string;
  /** Credential generation used by this fresh quota request. */
  freshCredentialGeneration?: number;
  /** Present only when this call's WHAM response included `rate_limit_reset_credits.available_count`. */
  freshResetCredits?: number;
  quotaProbeSkipped?: true;
  /** Positive evidence captured immediately before an upstream WHAM dispatch. */
  quotaProbeAttempted?: { at: number; credentialGeneration: number; dispatchSequence: number };
}

// Process-local ordering, never a timestamp or a serialized account identifier.
let quotaDispatchSequence = 0;
// Shared native-main ownership permits concurrent usage readers. Only a later
// successfully published response advances this fence; failed reads do not win.
let mainQuotaPublishedSequence = 0;

export function nextQuotaDispatchSequence(): number {
  return ++quotaDispatchSequence;
}

export function currentQuotaDispatchSequence(): number {
  return quotaDispatchSequence;
}

export function isQuotaDispatchCurrent(sequence: number): boolean {
  return sequence >= mainQuotaPublishedSequence;
}

export function publishQuotaDispatch(sequence: number): void {
  mainQuotaPublishedSequence = sequence;
}

export interface PoolQuotaProbeEvidence {
  onDispatch?: (sequence: number) => void;
  mayPublish?: () => boolean;
  attempted?: NonNullable<PoolQuotaResult["quotaProbeAttempted"]>;
}

export function markQuotaProbeAttempted(evidence: PoolQuotaProbeEvidence, credentialGeneration: number): void {
  const dispatchSequence = nextQuotaDispatchSequence();
  evidence.attempted = { at: Date.now(), credentialGeneration, dispatchSequence };
  evidence.onDispatch?.(dispatchSequence);
}

export function withQuotaProbeEvidence(
  result: PoolQuotaResult,
  evidence: PoolQuotaProbeEvidence,
): PoolQuotaResult {
  return evidence.attempted ? { ...result, quotaProbeAttempted: evidence.attempted } : result;
}

export interface PoolQuotaRefreshFlight {
  state: {
    dispatchSequence?: number;
    superseded?: boolean;
    startCredentialGeneration?: number;
    resolvedCredentialGeneration?: number;
    validatePending?: boolean;
  };
  promise: Promise<PoolQuotaResult>;
}

export const poolQuotaRefreshInFlight = new Map<string, Set<PoolQuotaRefreshFlight>>();
export const MAX_POOL_QUOTA_FLIGHTS = 16;

export class PoolQuotaProbeBusyError extends ResourceAdmissionError {
  constructor() {
    super("pool_quota_flights", MAX_POOL_QUOTA_FLIGHTS);
    this.name = "PoolQuotaProbeBusyError";
  }
}

export function poolQuotaFlightCount(): number {
  let count = 0;
  for (const flights of poolQuotaRefreshInFlight.values()) count += flights.size;
  return count;
}

/** Focused admission tests only; returns cleanup for the synthetic owners it inserts. */
export function seedCodexAuthAdmissionForTests(options: { loginFlows?: number; quotaFlights?: number }): () => void {
  const prefix = `admission-test-${crypto.randomUUID()}`;
  const cleanupLoginRows = seedLoginRowsForTests(prefix, options.loginFlows ?? 0);
  for (let index = 0; index < (options.quotaFlights ?? 0); index++) {
    poolQuotaRefreshInFlight.set(`${prefix}-quota-${index}`, new Set([{
      state: {},
      promise: new Promise<PoolQuotaResult>(() => {}),
    }]));
  }
  return () => {
    cleanupLoginRows();
    for (const key of [...poolQuotaRefreshInFlight.keys()]) if (key.startsWith(prefix)) poolQuotaRefreshInFlight.delete(key);
  };
}

/**
 * One refresh-and-replay for a pool account whose WHAM request came back 401 (#3019).
 *
 * The account list used to convert any 401 straight into `needsReauth`, and a bare 401 is
 * exactly what a stale-but-refreshable bearer produces after a plan change — so a healthy
 * credential was thrown away and the operator was told to log in again.
 *
 * Bounded by the recovery store: one attempt per credential lineage. An unbounded retry
 * against an upstream 401 is a self-inflicted credential-stuffing loop, which is why the
 * claim is taken BEFORE the refresh and settled by the flight rather than by this caller.
 */
export async function recoverPoolQuotaFrom401(ctx: {
  accountId: string;
  existing: StoredAccountQuota | null;
  configuredPlan: string | undefined;
  rejectedAccessToken: string;
  rejectedGeneration: number;
  resp: Response;
  quotaProbeEvidence: PoolQuotaProbeEvidence;
  onCredentialGeneration?: (generation: number) => void;
}): Promise<PoolQuotaResult> {
  const { accountId, existing, configuredPlan, rejectedAccessToken, rejectedGeneration, resp } = ctx;

  // Structured terminal evidence short-circuits everything: the same allowlist and bounded
  // parser the main account uses, because it is the same endpoint answering.
  if (await isTerminalPoolAuthResponse(resp)) {
    // Durable, not just this response: the account list re-polls, and without a recorded
    // mark the next bare 401 finds nothing terminal and reports the account healthy.
    //
    // Scoped to the generation this evidence is ABOUT. An account-wide mark would outlive
    // the credential it condemned, so a late terminal response arriving after the operator
    // re-authenticated would quarantine the replacement.
    markAccountNeedsReauth(accountId, captureConfigGeneration(), rejectedGeneration);
    return { quota: existing ?? null, needsReauth: true, reauthReason: "quota_unauthorized", credentialGeneration: rejectedGeneration };
  }

  const claim = claimQuotaRecovery(accountId, rejectedGeneration);
  if (!claim.granted) {
    // A lineage fenced by a TERMINAL refresh failure stays terminal. Without this, the
    // budget being used would make the next bare 401 report a dead credential as healthy.
    if (quotaRecoveryTerminalFor(accountId, rejectedGeneration)) {
      return { quota: existing ?? null, needsReauth: true, reauthReason: "refresh_failed", credentialGeneration: rejectedGeneration };
    }
    // Otherwise: this lineage spent its attempt, another caller is mid-refresh, or a
    // transient failure is backing off. Report transient and let the next poll try —
    // quarantining here would undo the whole point of the budget.
    return { quota: existing ?? null, needsReauth: false, credentialGeneration: rejectedGeneration };
  }

  let refreshed: Awaited<ReturnType<typeof forceRefreshCodexPoolToken>>;
  try {
    refreshed = await forceRefreshCodexPoolToken(accountId, {
      rejectedGeneration,
      rejectedAccessToken,
      // Settlement rides the flight, not this await: a cancelled caller would otherwise
      // leave the claim to expire while the shared refresh commits, and the already
      // refreshed lineage would get a second attempt.
      onSettled: outcome => {
        if (outcome.kind === "resolved") {
          settleQuotaRecovery(accountId, claim.claimId, outcome);
          // A propagated alias adopted the rotated grant without spending its own claim. Fence
          // each committed alias generation so a later 401 on it cannot claim a second refresh
          // of the same underlying grant.
          for (const alias of outcome.propagatedAliases ?? []) {
            fencePropagatedQuotaRecovery(alias.id, alias.generation);
          }
        } else if (outcome.error instanceof TokenRefreshError && isTerminalRefreshError(outcome.error)) {
          // A revoked or expired grant does not become valid on the next poll. Releasing it
          // into backoff would let the following bare 401 find a non-terminal record and
          // report a dead credential as healthy.
          settleQuotaRecoveryTerminal(accountId, claim.claimId);
        } else {
          releaseQuotaRecovery(accountId, claim.claimId, QUOTA_RECOVERY_BACKOFF_MS);
        }
      },
    });
  } catch (e) {
    // A refresh that failed terminally is the one case where the credential really is gone.
    // Everything else is unknown, and unknown is not proof.
    if (e instanceof TokenRefreshError && isTerminalRefreshError(e)) {
      // Persist the same verdict the token guardian writes: the in-memory mark dies with
      // this process, and only the stored terminal failure keeps a cached listing from
      // calling the dead grant healthy after a restart.
      markCodexAccountValidationFailed(accountId, `refresh_${e.reason}`, {
        expectedGeneration: rejectedGeneration,
        terminal: true,
      });
      markAccountNeedsReauth(accountId, captureConfigGeneration(), rejectedGeneration);
      return { quota: existing ?? null, needsReauth: true, reauthReason: "refresh_failed", credentialGeneration: rejectedGeneration };
    }
    return { quota: existing ?? null, needsReauth: false, credentialGeneration: rejectedGeneration };
  }

  // A byte-identical access token means replaying earns the same 401. Report transient
  // rather than burning the replay; the fence already moved to the returned generation.
  if (!refreshed.rotated) {
    return { quota: existing ?? null, needsReauth: false, credentialGeneration: refreshed.generation };
  }

  // The flight may have moved the generation while this request was in the air. Tell the
  // coalescing layer where the credential actually is, or a late caller joins on a stale
  // generation and opens a redundant flight.
  ctx.onCredentialGeneration?.(refreshed.generation);

  const writerGeneration = captureConfigGeneration();
  markQuotaProbeAttempted(ctx.quotaProbeEvidence, refreshed.generation);
  const poolWriter = capturePoolQuotaWriter(accountId, refreshed);
  const replay = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${refreshed.accessToken}`,
      "ChatGPT-Account-Id": refreshed.chatgptAccountId,
    },
    signal: AbortSignal.timeout(WHAM_REQUEST_TIMEOUT_MS),
  });
  if (!replay.ok) {
    if (replay.status === 401 && await isTerminalPoolAuthResponse(replay)) {
      // The refresh already settled this claim non-terminally, so the record alone would
      // let the next poll call a dead credential healthy. The evidence is about the
      // REFRESHED credential, which is what the replay used.
      markAccountNeedsReauth(accountId, writerGeneration, refreshed.generation);
      return { quota: existing ?? null, needsReauth: true, reauthReason: "quota_unauthorized", credentialGeneration: refreshed.generation };
    }
    return { quota: existing ?? null, needsReauth: false, credentialGeneration: refreshed.generation };
  }
  const result = await commitPoolQuotaResponse(replay, {
    accountId, existing, configuredPlan, generation: refreshed.generation, writerGeneration, poolWriter,
    mayPublish: ctx.quotaProbeEvidence.mayPublish,
  });
  return result.freshCredentialGeneration === refreshed.generation ? {
    ...result,
    resetRefreshLineage: {
      fromGeneration: rejectedGeneration,
      toGeneration: refreshed.generation,
      provenance: refreshed.provenance,
    },
  } : result;
}

/** Backoff after a refresh failure that proved nothing about the credential. */
export const QUOTA_RECOVERY_BACKOFF_MS = 60_000;

/** Same allowlist and bounded parser as the main account: it is the same endpoint. */
export async function isTerminalPoolAuthResponse(resp: Response): Promise<boolean> {
  // Consume the original rather than a clone. `resp.clone()` tees the body, and the
  // bounded parser's timeout cancels only its own reader — the unread original branch
  // keeps buffering. Nothing needs this response afterwards, so there is nothing to tee.
  const code = await readMainAuthErrorCode(resp);
  return typeof code === "string" && MAIN_TERMINAL_AUTH_CODES.has(code);
}

/** A revoked or expired grant is terminal; an unknown or transport failure is not. */
export function isTerminalRefreshError(error: TokenRefreshError): boolean {
  // Read the discriminator, not the message. TokenRefreshError carries `reason`, and
  // matching on human text would let a durable quarantine decision change the next time
  // somebody rewords an error string.
  return error.reason === "revoked" || error.reason === "expired";
}

/** Parse and store a successful WHAM response. Shared by the first attempt and the replay. */
export async function commitPoolQuotaResponse(
  resp: Response,
  ctx: {
    accountId: string;
    existing: StoredAccountQuota | null;
    configuredPlan: string | undefined;
    generation: number;
    writerGeneration: number;
    poolWriter?: PoolQuotaWriter;
    mayPublish?: () => boolean;
  },
): Promise<PoolQuotaResult> {
  const { accountId, existing, configuredPlan, generation, writerGeneration } = ctx;
  const data = (await resp.json()) as WhamUsageResponse;
  const observedAt = Date.now();
  if (ctx.mayPublish?.() === false) {
    return { quota: getAccountQuota(accountId), needsReauth: false, credentialGeneration: generation };
  }
  const freshPlan = nonEmptyPlan(data.plan_type) ?? undefined;
  const quota = parseUsageQuota({ ...data, plan_type: freshPlan ?? configuredPlan });
  const freshResetCredits = quota?.resetCredits;
  if (!quota) {
    return {
      quota: isCodexAccountGenerationLive(accountId, generation) ? existing ?? null : getAccountQuota(accountId),
      needsReauth: false,
      credentialGeneration: generation,
      ...(freshPlan !== undefined ? { freshPlan, freshCredentialGeneration: generation } : {}),
    };
  }
  if (!isCodexAccountGenerationLive(accountId, generation)) {
    return { quota: null, needsReauth: false, credentialGeneration: generation };
  }
  setAccountQuotaFromParsed(accountId, quota, writerGeneration, undefined, quota,
    ctx.poolWriter && isValidWhamHistoryObservation(data) ? { writer: ctx.poolWriter, observedAt, source: "wham", raw: quota } : undefined);
  return {
    quota: getAccountQuota(accountId),
    needsReauth: false,
    credentialGeneration: generation,
    freshQuota: quota,
    freshCredentialGeneration: generation,
    ...(freshPlan !== undefined ? { freshPlan } : {}),
    ...(freshResetCredits !== undefined ? { freshResetCredits } : {}),
  };
}

export async function fetchFreshPoolAccountQuota(
  accountId: string,
  existing: StoredAccountQuota | null,
  configuredPlan?: string,
  onCredentialGeneration?: (generation: number) => void,
  getValidToken: typeof getValidCodexToken = getValidCodexToken,
  quotaProbeEvidence: PoolQuotaProbeEvidence = {},
): Promise<PoolQuotaResult> {
  const writerGeneration = captureConfigGeneration();
  let requestCredentialGeneration = readCodexAccountRecord(accountId)?.generation;
  try {
    const { accessToken, chatgptAccountId, generation } = await getValidToken(accountId);
    const poolWriter = capturePoolQuotaWriter(accountId, { accessToken, chatgptAccountId, generation });
    requestCredentialGeneration = generation;
    onCredentialGeneration?.(generation);
    markQuotaProbeAttempted(quotaProbeEvidence, generation);
    const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      if (resp.status !== 401) {
        return withQuotaProbeEvidence(
          { quota: existing ?? null, needsReauth: false, credentialGeneration: generation },
          quotaProbeEvidence,
        );
      }
      // A bare 401 is what a stale-but-refreshable bearer produces after a plan change, so
      // quarantining on it tells the operator to re-authenticate an account that was fine
      // (#3019). Refresh once, replay once, and only then decide.
      const recovered = await recoverPoolQuotaFrom401({
        accountId,
        existing,
        configuredPlan,
        rejectedAccessToken: accessToken,
        rejectedGeneration: generation,
        resp,
        quotaProbeEvidence,
        onCredentialGeneration,
      });
      return withQuotaProbeEvidence(recovered, quotaProbeEvidence);
    }
    const committed = await commitPoolQuotaResponse(resp, {
      accountId, existing, configuredPlan, generation, writerGeneration, poolWriter,
      mayPublish: quotaProbeEvidence.mayPublish,
    });
    return withQuotaProbeEvidence(committed, quotaProbeEvidence);
  } catch (e) {
    if (e instanceof CodexCredentialGenerationConflictError || e instanceof CodexCredentialRefreshLockTimeoutError
      || e instanceof CodexCredentialRefreshBusyError || e instanceof CodexCredentialRefreshStaleError) {
      return withQuotaProbeEvidence({
        quota: existing ?? null,
        needsReauth: false,
        credentialGeneration: requestCredentialGeneration,
        quotaProbeSkipped: true,
      }, quotaProbeEvidence);
    }
    // Terminal means the grant itself is dead or missing; an `unknown` refresh failure (a
    // token-endpoint 5xx, a transport blip) may clear, so it reports transient like the
    // 401-recovery path instead of quarantining a healthy account (#2887). A revoked or
    // expired grant is also written to the record as a terminal validation failure, the same
    // verdict the token guardian persists: the in-memory mark dies with this process, and
    // the stored verdict is what keeps a cached listing from calling the dead grant healthy
    // after a restart.
    if (isTerminalCodexPoolRefreshFailure(e)) {
      if (e instanceof TokenRefreshError && isTerminalRefreshError(e)) {
        markCodexAccountValidationFailed(accountId, `refresh_${e.reason}`, {
          expectedGeneration: requestCredentialGeneration,
          terminal: true,
        });
      }
      markAccountNeedsReauth(accountId, captureConfigGeneration(), requestCredentialGeneration);
      return withQuotaProbeEvidence(
        { quota: existing ?? null, needsReauth: true, reauthReason: "refresh_failed", credentialGeneration: requestCredentialGeneration },
        quotaProbeEvidence,
      );
    }
    return withQuotaProbeEvidence(
      { quota: existing ?? null, needsReauth: false, credentialGeneration: requestCredentialGeneration },
      quotaProbeEvidence,
    );
  }
}

export async function fetchPoolAccountQuota(
  accountId: string,
  forceRefresh = false,
  configuredPlan?: string,
  getValidToken: typeof getValidCodexToken = getValidCodexToken,
  validatePending = false,
  afterDispatchSequence?: number,
): Promise<PoolQuotaResult> {
  const existing = getAccountQuota(accountId);
  if (afterDispatchSequence === undefined && !forceRefresh && existing && Date.now() - existing.updatedAt < POOL_CACHE_TTL) {
    return {
      quota: existing,
      needsReauth: false,
      credentialGeneration: readCodexAccountRecord(accountId)?.generation,
    };
  }
  // A token refresh may increment the generation (and rotate the refresh token) before WHAM
  // completes. Join a flight whose starting or resolved generation is still current, but let a
  // replacement credential with the same pool id start its own request.
  const record = readCodexAccountRecord(accountId);
  const flights = poolQuotaRefreshInFlight.get(accountId);
  const current = flights && [...flights].find(flight => {
    const generation = flight.state.resolvedCredentialGeneration
      ?? flight.state.startCredentialGeneration;
    return !flight.state.superseded
      && (afterDispatchSequence === undefined || (flight.state.dispatchSequence ?? 0) > afterDispatchSequence)
      && generation !== undefined && isCodexAccountGenerationLive(accountId, generation);
  });
  if (current) {
    // A manual refresh joining a passive read must not lose its validation intent.
    current.state.validatePending ||= validatePending;
    return current.promise;
  }
  if (poolQuotaFlightCount() >= MAX_POOL_QUOTA_FLIGHTS) throw new PoolQuotaProbeBusyError();

  // A post-reset request must not let an older same-account response overwrite its evidence.
  // Flags live only as long as the bounded flights; no retained per-account sequence map.
  if (afterDispatchSequence !== undefined) {
    for (const flight of flights ?? []) flight.state.superseded = true;
  }
  const state: PoolQuotaRefreshFlight["state"] = {
    startCredentialGeneration: record?.generation,
    validatePending,
  };
  const refresh = fetchFreshPoolAccountQuota(
    accountId,
    existing,
    configuredPlan,
    generation => { state.resolvedCredentialGeneration = generation; },
    getValidToken,
    {
      onDispatch: sequence => { state.dispatchSequence = sequence; },
      mayPublish: () => state.superseded !== true,
    },
  ).then(async result => {
    // A passive flight has consumed its validation decision. Remove it before
    // promise settlement queues other continuations, so a late explicit caller
    // starts fresh work instead of setting an intent nobody will read again.
    if (!state.validatePending) {
      releaseFlight();
      return result;
    }
    // Only an explicit account-list refresh finishes deferred registration. Passive quota
    // polls and startup priming remain read-only with respect to inference spending.
    const generation = result.freshCredentialGeneration;
    const record = state.validatePending ? readCodexAccountRecord(accountId) : null;
    if (record?.codexValidationPending && record.credential && record.deletedAt == null
      && generation !== undefined && record.generation === generation
      && isCompleteCodexQuotaRecoverySnapshot(result.freshQuota ?? null, result.freshPlan ?? configuredPlan)) {
      try {
        // Quota I/O may outlive the source capture. Never validate a rotated or revoked link
        // using an older generation's observation. Explicit validation consent still applies.
        const sourceToken = record.credential.sourceAuthPath ? await getValidToken(accountId) : null;
        if (sourceToken && (sourceToken.generation !== generation
          || !isCodexAccountGenerationLive(accountId, generation))) return result;
        await warmCodexAccount({
          accessToken: sourceToken?.accessToken ?? record.credential.accessToken,
          chatgptAccountId: sourceToken?.chatgptAccountId ?? record.credential.chatgptAccountId,
        });
        markCodexAccountValidated(accountId, Date.now(), generation);
        clearAccountNeedsReauth(accountId, generation);
      } catch (error) {
        // Keep the durable restriction on any failed/partial inference response, even
        // when WHAM just reported headroom. No raw upstream text enters diagnostics.
        const reason = codexWarmupFailureReason(error);
        if (reason === "http_status:401" || reason === "http_status:403") {
          markCodexAccountValidationFailed(accountId, reason, { expectedGeneration: generation });
          markAccountNeedsReauth(accountId, captureConfigGeneration(), generation);
        }
      }
    }
    return result;
  });
  const flight: PoolQuotaRefreshFlight = { state, promise: refresh };
  const activeFlights = flights ?? new Set<PoolQuotaRefreshFlight>();
  activeFlights.add(flight);
  if (!flights) poolQuotaRefreshInFlight.set(accountId, activeFlights);
  const releaseFlight = () => {
    activeFlights.delete(flight);
    if (activeFlights.size === 0 && poolQuotaRefreshInFlight.get(accountId) === activeFlights) {
      poolQuotaRefreshInFlight.delete(accountId);
    }
  };
  try {
    return await refresh;
  } finally {
    releaseFlight();
  }
}
