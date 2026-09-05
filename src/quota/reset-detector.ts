/**
 * Pure quota-reset detection: two consecutive observations of one usage window in, at most
 * one reset event out.
 *
 * Nothing here reads a clock, a config, or the disk. `now` is a parameter so a test can
 * place a deadline in the past without waiting for it, and so the same snapshot pair always
 * yields the same answer.
 *
 * Design and the seven false-positive traps this guards against:
 * devlog/_plan/260828_quota_reset_detection/000_plan.md
 */

/** One observed usage window, normalized away from provider-specific field names. */
export type QuotaWindowObservation = {
  /** Window identity: "5h", "weekly", "monthly", or "custom:<label>". */
  readonly window: string;
  /** 0-100 used percent. Absent when upstream stopped reporting this window. */
  readonly percent?: number;
  /** Epoch ms. Absent when upstream declares no clock, or declared a sentinel. */
  readonly resetAt?: number;
  /**
   * Window length in seconds, when upstream states it.
   *
   * Used only to bound natural decay in a rolling window (see the surprise branch). Absent
   * for providers that never declare a length; the label table then supplies a conservative
   * default.
   */
  readonly windowSeconds?: number;
  /**
   * When this observation was taken, stamped by the observer as it stores the baseline.
   *
   * Needed because a rolling window's percent decays with WALL TIME, so distinguishing decay
   * from a reset requires knowing how much time separates the two observations. Absent in
   * baselines written before this field existed, and the decay bound is then skipped rather
   * than guessed.
   */
  readonly observedAt?: number;
};

export type QuotaResetKind = "scheduled" | "surprise";

export type QuotaResetEvent = {
  readonly kind: QuotaResetKind;
  /** "codex" or a provider name. Never an account identifier. */
  readonly scope: string;
  /** Non-identifying account discriminator; see quotaAccountTag. */
  readonly accountTag: string;
  readonly window: string;
  readonly percentBefore?: number;
  readonly percentAfter?: number;
  readonly previousResetAt?: number;
  readonly resetAt?: number;
  /**
   * When WE noticed, not when the reset happened.
   *
   * Observation cadence is bounded by the 5-minute provider cache TTL and the 10-minute
   * per-account TTL, so the reset instant can only ever be bracketed between two
   * observations. Naming this field `detectedAt` keeps that limitation visible to every
   * consumer instead of implying a precision we do not have.
   */
  readonly detectedAt: number;
  /** Idempotence key: scope|accountTag|window|resetAt. */
  readonly key: string;
};

/**
 * A drop smaller than this is rounding noise or a same-window correction, not a reset.
 *
 * Upstream percents are integers and a real window rollover drops by tens of points, so
 * nothing genuine sits under this floor. It applies only to the surprise branch: a
 * scheduled rollover is proven by its own expired deadline and needs no magnitude test.
 */
export const MIN_SURPRISE_DROP_PERCENT = 5;

/**
 * Account discriminator: stable for this install, unlinkable outside it.
 *
 * Events must distinguish accounts — a provider report is keyed by provider only, so an
 * account switch would otherwise inherit the previous account's history — while carrying no
 * account identity, because the payload crosses a webhook boundary to a third party.
 *
 * The salt is what makes the second half true. An unsalted `Bun.hash` of an email is
 * brute-forceable in tens of guesses against a small, highly guessable input space, which
 * would let a webhook recipient confirm-or-deny any guessed account. Salted, the tag is
 * meaningless to anyone without the install salt, and still stable across restarts because
 * the salt is persisted — which is what the durable idempotence key depends on.
 *
 * Not a cryptographic commitment: it defeats an offline dictionary attack by a payload
 * recipient, which is the threat the privacy constraint names.
 */
export function quotaAccountTag(accountKey: string, salt: string): string {
  return Bun.hash(`${salt}\u0000${accountKey}`).toString(36).slice(0, 8).padStart(8, "0");
}

export function quotaResetKey(input: {
  readonly scope: string;
  readonly accountTag: string;
  readonly window: string;
  readonly resetAt?: number;
  readonly previousResetAt?: number;
}): string {
  // Prefer the NEW deadline: every later observation of the same post-reset window computes
  // the same key, which is what makes repeated detection idempotent.
  //
  // Fall back to the deadline that just expired when upstream reports no new one. A bare
  // "none" discriminator would collapse every clockless reset of one window onto a single
  // key, so the first claim would permanently suppress all later ones.
  const discriminator = input.resetAt ?? input.previousResetAt ?? "none";
  return [input.scope, input.accountTag, input.window, discriminator].join("|");
}

/**
 * Percent guard applied at this boundary.
 *
 * Both upstream normalizers clamp to 0-100, but a value outside that range means the payload
 * bypassed them, and admitting a negative would manufacture an enormous apparent drop. Same
 * philosophy as the resetAt guard below: re-check rather than trust the caller.
 */
function finitePercent(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 0 && value <= 100 ? value : undefined;
}

/**
 * Epoch-ms guard applied at this boundary on purpose.
 *
 * The two callers normalize differently — src/providers/quota.ts:279 treats <= 0 as a
 * sentinel and scales seconds to ms, while src/codex/quota.ts:192 admits 0 and does not
 * scale — so the detector cannot trust either and re-checks here.
 */
function finiteResetAt(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Decide whether one window transition is a reset.
 *
 * Returns null for every ambiguous case. The bias is deliberate: a missed notification is
 * an inconvenience, while a false one trains the operator to ignore the channel.
 */
export function detectQuotaReset(input: {
  readonly scope: string;
  readonly accountTag: string;
  readonly previous: QuotaWindowObservation | undefined;
  readonly next: QuotaWindowObservation;
  readonly now: number;
}): QuotaResetEvent | null {
  const { scope, accountTag, previous, next, now } = input;

  // No baseline, no transition. This one line is what stops a cold start (writers do not
  // hydrate from disk), a reauth row clear, a reconciliation delete, and an account switch
  // from each manufacturing an event out of thin air.
  if (!previous) return null;
  if (previous.window !== next.window) return null;

  const percentBefore = finitePercent(previous.percent);
  const percentAfter = finitePercent(next.percent);
  const previousResetAt = finiteResetAt(previous.resetAt);
  const resetAt = finiteResetAt(next.resetAt);

  const build = (kind: QuotaResetKind): QuotaResetEvent => ({
    kind,
    scope,
    accountTag,
    window: next.window,
    ...(percentBefore !== undefined ? { percentBefore } : {}),
    ...(percentAfter !== undefined ? { percentAfter } : {}),
    ...(previousResetAt !== undefined ? { previousResetAt } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    detectedAt: now,
    key: quotaResetKey({
      scope,
      accountTag,
      window: next.window,
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(previousResetAt !== undefined ? { previousResetAt } : {}),
    }),
  });

  // A window whose percent vanished says nothing about a reset: upstream simply stopped
  // reporting it. Treating absence as 0% would fire on every degraded payload.
  if (percentAfter === undefined) return null;

  const deadlinePassed = previousResetAt !== undefined && now >= previousResetAt;

  if (deadlinePassed) {
    if (percentBefore !== undefined && percentAfter > percentBefore) return null;
    // An expired deadline alone is NOT enough. src/codex/quota.ts:323-329 carries the
    // previous burst tuple forward verbatim when a header write omits it, so a partial
    // write reproduces the old deadline and the old percent exactly. Once wall-clock passes
    // that copied deadline, "the clock expired" would fire on a snapshot where upstream
    // said nothing at all — a false positive on the highest-frequency write path in the
    // system (one per pooled response).
    //
    // Require corroboration that the window actually turned over: either usage fell, or
    // upstream issued a new deadline. A byte-identical carried-forward window gives
    // neither, so it stays silent.
    const usageFell = percentBefore !== undefined && percentAfter < percentBefore;
    const deadlineAdvanced = resetAt !== undefined && resetAt > previousResetAt!;
    if (!usageFell && !deadlineAdvanced) return null;
    return build("scheduled");
  }

  // Still inside the previous window, so quota coming back means upstream moved the window
  // out of band.
  //
  // A material percent DROP is the only accepted evidence here. An advancing deadline is
  // deliberately NOT sufficient, even though it looks like a fresh window: a ROLLING window
  // (Anthropic's five_hour, Codex's burst window) reports a deadline that creeps forward on
  // every poll by exactly the elapsed time, so "the deadline advanced" is true of every
  // healthy observation of a rolling window and would fire continuously.
  //
  // Nothing is lost by requiring the drop. A surprise reset is worth telling an operator
  // about because quota came BACK; if usage did not fall, none did, and there is nothing to
  // report. The scheduled branch above can still accept an advancing deadline as evidence,
  // because there the previous deadline had genuinely expired.
  if (
    previousResetAt !== undefined
    && percentBefore !== undefined
    && percentBefore - percentAfter >= MIN_SURPRISE_DROP_PERCENT
    && !isRollingWindowCreep({
      previousResetAt,
      resetAt,
      previousObservedAt: previous.observedAt,
      now,
    })
  ) {
    return build("surprise");
  }

  // A window with no deadline on either side is not evaluated. Several provider parsers
  // never emit a reset clock at all (credit balances, prepaid pools), and a bare percent
  // drop there is as likely to be a top-up or a plan change as a window rollover. Firing on
  // it would make the channel noise; the honest answer is that those providers expose no
  // window semantics to detect.
  return null;
}

/**
 * True when the deadline merely CREPT forward with the clock, which is what a rolling window
 * does while nothing resets.
 *
 * A rolling window (Anthropic five_hour, Codex burst) has no rollover instant: usage ages out
 * continuously, so its percent falls on its own and its deadline slides forward by roughly the
 * elapsed time on every poll. MIN_SURPRISE_DROP_PERCENT only screens integer rounding, so a
 * healthy rolling window fired false "surprise" events — measured: 88% -> 61% one hour into a
 * 5h window, a 27-point drop with no reset involved.
 *
 * The discriminator is deadline MOVEMENT against elapsed time, not drop magnitude. Decay
 * magnitude cannot be bounded from elapsed time alone, because the percent that ages out
 * depends on WHEN the usage happened: an hour of idling can retire a large burst that all
 * landed in one minute. Deadline movement behaves differently — while a window is merely
 * rolling, its deadline advances by about the elapsed time, whereas a genuine out-of-band
 * reset issues a deadline a FULL window into the future, jumping far beyond the elapsed gap.
 *
 * Fails OPEN (returns false, letting the event through) whenever the evidence is missing: no
 * baseline timestamp, no deadline on either side, or a deadline that moved backwards. A
 * missed reset is an inconvenience; a suppressed one on an unproven guess is a defect.
 */
function isRollingWindowCreep(input: {
  readonly previousResetAt: number | undefined;
  readonly resetAt: number | undefined;
  readonly previousObservedAt: number | undefined;
  readonly now: number;
}): boolean {
  const observedAt = finiteResetAt(input.previousObservedAt);
  const previousResetAt = input.previousResetAt;
  const resetAt = input.resetAt;
  if (observedAt === undefined || previousResetAt === undefined || resetAt === undefined) {
    return false;
  }
  const elapsedMs = input.now - observedAt;
  if (elapsedMs <= 0) return false;
  const deadlineShiftMs = resetAt - previousResetAt;
  // A deadline that stood still or moved backwards is not creep. Standing still while usage
  // fell is the clearest possible surprise-reset signature, so it must reach the operator.
  if (deadlineShiftMs <= 0) return false;
  // Creep tracks the clock. The 2x tolerance absorbs polling jitter and upstream rounding to
  // whole minutes without approaching a real reset, which shifts the deadline by a whole
  // window — hours, against a gap that is minutes on the observation paths that exist here.
  return deadlineShiftMs <= elapsedMs * 2;
}

/** Pair two window lists by identity and yield every detected reset. */
export function detectQuotaResets(input: {
  readonly scope: string;
  readonly accountTag: string;
  readonly previous: ReadonlyArray<QuotaWindowObservation>;
  readonly next: ReadonlyArray<QuotaWindowObservation>;
  readonly now: number;
}): QuotaResetEvent[] {
  const before = new Map(input.previous.map(item => [item.window, item]));
  const events: QuotaResetEvent[] = [];
  for (const observation of input.next) {
    const event = detectQuotaReset({
      scope: input.scope,
      accountTag: input.accountTag,
      previous: before.get(observation.window),
      next: observation,
      now: input.now,
    });
    if (event) events.push(event);
  }
  return events;
}
