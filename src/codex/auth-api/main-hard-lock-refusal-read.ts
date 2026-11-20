import type { OcxConfig } from "../../types";
import { MAIN_CODEX_ACCOUNT_ID } from "../account-id";
import { reconcileMainCodexAccountRuntimeState } from "../account-lifecycle";
import { isCodexAccountPaused } from "../account-pause";
import { isAccountNeedsReauth } from "../account-runtime-state";
import { getMainAccountHardLockStatus } from "../main-account-hard-lock";
import { getValidMainAccountToken, mainAccountTokenIsCurrent, mainAccountTokenQuotaWriter } from "../main-account";
import {
  captureMainAccountIdentityGeneration, captureMainQuotaDispatch, getMainQuotaCredentialGeneration, getObservedMainQuotaIdentityKey,
  isMainAccountIdentityGenerationLive, isMainQuotaDispatchLive, matchesMainQuotaCredential, observeMainQuotaCredential,
} from "../main-account-cache";
import { tryAcquireNativeMainProfileClaim } from "../native-main-admission";
import { isNativeMainTrafficBlocked } from "../native-profile-startup";
import {
  getMainPolicyUsageObservedAt, isValidWhamHistoryObservation, parseMainPolicyUsageQuota, parseUsageQuota, setAccountQuotaFromParsed,
  type WhamUsageResponse,
} from "../quota";
import { fetchCodexUsage, nextCodexUsageQueryAt } from "../quota-query-backoff";
import { WHAM_REQUEST_TIMEOUT_MS } from "../quota-recovery-timing";
import { captureConfigGeneration } from "../../lib/state-store-sweeper";
import type { AdmissionLease } from "../../lib/admission";
import { fetchMainAccountInfoAttempt } from "./main-account-probe";
import { isQuotaDispatchCurrent, nextQuotaDispatchSequence, publishQuotaDispatch } from "./pool-quota-probe";

/** A hard-lock reading younger than this is current enough to refuse on (#8113). */
export const MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS = 60_000;
/** At most one refusal-triggered WHAM read per main identity in this window. */
export const MAIN_HARD_LOCK_REFUSAL_READ_INTERVAL_MS = 60_000;

// Last refusal read per main identity, kept for the whole interval so an A→B→A switch cannot reset it.
const lastReadAt = new Map<string, number>();
let inFlight: Promise<void> | undefined;

/**
 * The caller's own credential when the refused request authenticates as the main login itself
 * (caller-owned Direct, or a request-scoped main bearer in Pool). Such a request may not read the
 * physical main credential, so its fresh read uses this bearer, which the lock already proved is
 * the observed main credential.
 */
export interface MainHardLockRefusalCaller {
  bearer: string;
  accountId: string;
}

/** Test-only: forget the per-identity pacing and any settled read. */
export function resetMainHardLockRefusalReadForTests(): void {
  lastReadAt.clear();
  inFlight = undefined;
}

/**
 * Before a main hard-lock refusal, read WHAM once when the reading behind the lock is stale (#8113).
 *
 * A reset redeemed outside OpenCodex leaves the cached reading above the threshold until a later
 * observation replaces it, and the paced background recovery may not run for minutes. When the
 * cached reading is older than {@link MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS}, this reads usage once:
 * with the proxy-owned main credential and the native-main claim through the recovery probe, or,
 * for a caller-owned main request, with the caller's own bearer, published only while that bearer
 * still matches the observed main credential. Concurrent refusals share
 * one read, and each main identity gets at most one read per
 * {@link MAIN_HARD_LOCK_REFUSAL_READ_INTERVAL_MS}. Server-advised usage backoff, a paused main,
 * reauthentication quarantine and native-main maintenance all skip the read. The read is passive:
 * it never sets or clears the reauthentication quarantine.
 *
 * Returns `true` when the lock no longer blocks, so the caller may resolve the request again;
 * `false` keeps the refusal. A failed read keeps the existing policy observation.
 */
export async function refreshMainHardLockBeforeRefusal(
  config: OcxConfig,
  policy: Parameters<typeof getMainAccountHardLockStatus>[0] = config,
  signal?: AbortSignal,
  /** The caller-owned main credential; `null` when the request is caller-owned but unusable for a read. */
  caller?: MainHardLockRefusalCaller | null,
  now: () => number = Date.now,
): Promise<boolean> {
  const blocked = () => getMainAccountHardLockStatus(policy, now()).state === "blocked";
  if (!blocked()) return true;
  if (caller === null) return false;
  // The usage measurement's age, not the snapshot's write time: credits-only merges rewrite the latter.
  const observedAt = getMainPolicyUsageObservedAt();
  if (observedAt !== undefined && now() - observedAt < MAIN_HARD_LOCK_REFUSAL_READ_AGE_MS) return false;
  if (isNativeMainTrafficBlocked() || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)
    || isCodexAccountPaused(config, MAIN_CODEX_ACCOUNT_ID)) return false;
  if (!inFlight) {
    const identity = getObservedMainQuotaIdentityKey() ?? "";
    for (const [key, at] of lastReadAt) {
      if (now() - at >= MAIN_HARD_LOCK_REFUSAL_READ_INTERVAL_MS) lastReadAt.delete(key);
    }
    if (lastReadAt.has(identity)) return false;
    const queryAfter = nextCodexUsageQueryAt(`main:${captureConfigGeneration()}:${getMainQuotaCredentialGeneration()}`);
    if (queryAfter !== undefined && queryAfter > now()) return false;
    let read: Promise<void>;
    if (caller) {
      // Without a live proof for the caller's credential there is nothing to read; keep the minute.
      const dispatch = captureMainQuotaDispatch(caller.bearer, caller.accountId, captureConfigGeneration());
      if (!dispatch) return false;
      lastReadAt.set(identity, now());
      read = readCallerMainUsage(caller, dispatch);
    } else {
      const lease = tryAcquireNativeMainProfileClaim();
      if (!lease) return false;
      lastReadAt.set(identity, now());
      read = readMainUsage(config, lease).finally(() => lease.release());
    }
    read = read
      .catch(() => { /* the refusal stands on the existing observation */ })
      .finally(() => { if (inFlight === read) inFlight = undefined; });
    inFlight = read;
  }
  await abortable(inFlight, signal);
  return !blocked();
}

async function readMainUsage(config: OcxConfig, lease: AdmissionLease): Promise<void> {
  reconcileMainCodexAccountRuntimeState();
  const identityGeneration = captureMainAccountIdentityGeneration();
  // Refresh can need an exclusive credential claim, so obtain the token before WHAM's shared claim.
  const prepared = await getValidMainAccountToken({ preserveReauth: true });
  if (!prepared) return;
  if (mainAccountTokenQuotaWriter(prepared)) {
    if (!mainAccountTokenIsCurrent(prepared)) return;
  } else observeMainQuotaCredential(prepared.accessToken, prepared.chatgptAccountId);
  if (!isMainAccountIdentityGenerationLive(identityGeneration) || isAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID)) return;
  // Paced in every account mode: a failed or Retry-After answer must defer the next read.
  await fetchMainAccountInfoAttempt(true, 1, lease, false, false, false, config,
    { passive: true, preparedToken: prepared, paced: true });
}

/** Usage read with the caller's own main bearer: no physical credential read, no reauth state. */
async function readCallerMainUsage(
  caller: MainHardLockRefusalCaller, dispatch: NonNullable<ReturnType<typeof captureMainQuotaDispatch>>,
): Promise<void> {
  // The dispatch proof also fences credential commits (refresh, reauthentication) that advance the
  // mutation epoch before the observed credential itself changes.
  const writerGeneration = dispatch.configGeneration;
  // Ordered like the main probe: a response publishes only if no later dispatch already published.
  const sequence = nextQuotaDispatchSequence();
  const key = `main:${writerGeneration}:${dispatch.credentialGeneration}`;
  const admission = await fetchCodexUsage(key, {
    headers: { Authorization: `Bearer ${caller.bearer}`, "ChatGPT-Account-Id": caller.accountId },
    signal: AbortSignal.timeout(WHAM_REQUEST_TIMEOUT_MS),
  }, undefined, { pacingKey: key });
  // A joined read belongs to another owner, which publishes its own evidence.
  if (!admission || admission.kind === "joined") return;
  let usable = false;
  try {
    if (!admission.response.ok) return;
    const data = await admission.response.json() as WhamUsageResponse;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return;
    // The main login may have changed while the read was in flight; never publish across it.
    if (!isMainQuotaDispatchLive(dispatch) || !matchesMainQuotaCredential(caller.bearer, caller.accountId)
      || writerGeneration !== captureConfigGeneration() || !isQuotaDispatchCurrent(sequence)) return;
    const quota = parseUsageQuota(data);
    const acceptedTopology = setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, quota, writerGeneration, dispatch.writer, parseMainPolicyUsageQuota(data),
      undefined, false, false, isValidWhamHistoryObservation(data) ? quota : null, { data });
    if (quota || acceptedTopology) publishQuotaDispatch(sequence);
    if (!quota) return;
    usable = true;
  } finally {
    admission.settle(usable);
  }
}

function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
