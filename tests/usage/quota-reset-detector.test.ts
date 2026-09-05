import { describe, expect, test } from "bun:test";
import {
  detectQuotaReset,
  detectQuotaResets,
  MIN_SURPRISE_DROP_PERCENT,
  quotaAccountTag,
} from "../../src/quota/reset-detector";

const NOW = 1_772_000_000_000;
const HOUR = 60 * 60_000;
const DAY_MS = 24 * HOUR;

function detect(
  previous: { percent?: number; resetAt?: number } | undefined,
  next: { percent?: number; resetAt?: number },
  now = NOW,
) {
  return detectQuotaReset({
    scope: "codex",
    accountTag: "tag00000",
    previous: previous ? { window: "weekly", ...previous } : undefined,
    next: { window: "weekly", ...next },
    now,
  });
}

describe("quota reset detection", () => {
  test("a passed deadline plus a percent drop is a scheduled rollover", () => {
    const event = detect(
      { percent: 96, resetAt: NOW - 60_000 },
      { percent: 2, resetAt: NOW + 7 * 24 * HOUR },
    );
    expect(event?.kind).toBe("scheduled");
    expect(event?.percentBefore).toBe(96);
    expect(event?.percentAfter).toBe(2);
  });

  test("a passed deadline with no drop is still a scheduled rollover", () => {
    // Barely-used window: percent is unchanged, but upstream issued a NEW deadline, which
    // is the corroboration that it really turned over.
    const event = detect(
      { percent: 3, resetAt: NOW - 60_000 },
      { percent: 3, resetAt: NOW + 7 * 24 * HOUR },
    );
    expect(event?.kind).toBe("scheduled");
  });

  test("a carried-forward window past its deadline is NOT a reset", () => {
    // src/codex/quota.ts:323-329 copies the previous burst tuple verbatim when a header
    // write omits it. Identical percent AND identical deadline means upstream said nothing,
    // so an expired clock alone must not fire — this path runs once per pooled response.
    expect(detect(
      { percent: 42, resetAt: NOW - 60_000 },
      { percent: 42, resetAt: NOW - 60_000 },
    )).toBeNull();
  });

  test("usage rising past a passed deadline is not a reset", () => {
    expect(detect({ percent: 10, resetAt: NOW - 60_000 }, { percent: 24 })).toBeNull();
  });

  test("a material drop inside an unexpired window is a surprise reset", () => {
    const event = detect(
      { percent: 96, resetAt: NOW + 2 * HOUR },
      { percent: 4, resetAt: NOW + 9 * HOUR },
    );
    expect(event?.kind).toBe("surprise");
  });

  test("a deadline that jumps forward at a flat percent is NOT a reset", () => {
    // A rolling window's deadline creeps forward on every poll by the elapsed time, so an
    // advancing deadline is true of every healthy observation. Firing on it would notify
    // continuously. And with usage flat, no quota came back, so there is nothing to report.
    expect(detect(
      { percent: 40, resetAt: NOW + 2 * HOUR },
      { percent: 40, resetAt: NOW + 9 * HOUR },
    )).toBeNull();
  });

  test("a rolling window creeping forward across many polls never fires", () => {
    for (let poll = 1; poll <= 5; poll += 1) {
      const event = detect(
        { percent: 40, resetAt: NOW + 5 * HOUR + (poll - 1) * 60_000 },
        { percent: 40 + poll, resetAt: NOW + 5 * HOUR + poll * 60_000 },
        NOW + poll * 60_000,
      );
      expect(event).toBeNull();
    }
  });

  test("ordinary usage increase is not a reset", () => {
    expect(detect({ percent: 40, resetAt: NOW + 2 * HOUR }, { percent: 65, resetAt: NOW + 2 * HOUR })).toBeNull();
  });

  test("a sub-threshold drop is rounding noise, not a reset", () => {
    const drop = MIN_SURPRISE_DROP_PERCENT - 1;
    expect(detect(
      { percent: 61, resetAt: NOW + 2 * HOUR },
      { percent: 61 - drop, resetAt: NOW + 2 * HOUR },
    )).toBeNull();
  });

  test("a drop exactly at the threshold fires", () => {
    expect(detect(
      { percent: 61, resetAt: NOW + 2 * HOUR },
      { percent: 61 - MIN_SURPRISE_DROP_PERCENT, resetAt: NOW + 2 * HOUR },
    )?.kind).toBe("surprise");
  });

  test("no previous observation is never a reset", () => {
    // Cold start, reauth row clear, reconciliation delete, and account switch all land here.
    expect(detect(undefined, { percent: 0, resetAt: NOW + HOUR })).toBeNull();
  });

  test("a vanished percent is not a reset", () => {
    expect(detect({ percent: 90, resetAt: NOW + HOUR }, { resetAt: NOW + HOUR })).toBeNull();
  });

  test("sentinel reset clocks are ignored rather than read as 1970", () => {
    // src/providers/quota.ts:279 and src/codex/quota.ts:192 disagree on whether 0 survives,
    // so the detector re-checks: a 0 deadline must not read as a long-passed one.
    expect(detect({ percent: 90, resetAt: 0 }, { percent: 88, resetAt: 0 })).toBeNull();
  });

  test("the same post-reset window yields a stable idempotence key", () => {
    const first = detect({ percent: 96, resetAt: NOW - 60_000 }, { percent: 2, resetAt: NOW + HOUR });
    // A second observer re-reads the same transition a moment later. The key must match, so
    // whichever one claims it first suppresses the other.
    const second = detect(
      { percent: 96, resetAt: NOW - 30_000 },
      { percent: 2, resetAt: NOW + HOUR },
      NOW + 1_000,
    );
    expect(first?.kind).toBe("scheduled");
    expect(second?.kind).toBe("scheduled");
    expect(first?.key).toBe(second?.key);
  });

  test("account tags differ per account and are salted against brute force", () => {
    const salt = "0123456789abcdef0123456789abcdef";
    const left = quotaAccountTag("acct-one@example.test", salt);
    const right = quotaAccountTag("acct-two@example.test", salt);
    expect(left).not.toBe(right);
    expect(left).not.toContain("@");
    expect(left).toHaveLength(8);

    // The salt is what makes the tag unlinkable to a webhook recipient: the same account
    // under a different install salt must not produce the same tag, or an offline dictionary
    // attack against a guessable email space would recover the identity.
    const otherInstall = quotaAccountTag("acct-one@example.test", "fedcba9876543210fedcba9876543210");
    expect(otherInstall).not.toBe(left);

    // Stable within an install, which is what the persisted idempotence key depends on.
    expect(quotaAccountTag("acct-one@example.test", salt)).toBe(left);
  });

  test("a negative percent is not read as a huge drop", () => {
    // Both upstream normalizers clamp to 0-100, but the detector re-checks its own inputs
    // rather than trusting a caller — the same reason it re-validates resetAt.
    expect(detect(
      { percent: 10, resetAt: NOW + 2 * HOUR },
      { percent: -50, resetAt: NOW + 2 * HOUR },
    )).toBeNull();
  });

  test("window lists are paired by identity, and a mismatched pairing is refused", () => {
    const events = detectQuotaResets({
      scope: "codex",
      accountTag: "tag00000",
      previous: [
        { window: "5h", percent: 88, resetAt: NOW - 60_000 },
        { window: "weekly", percent: 40, resetAt: NOW + 5 * 24 * HOUR },
      ],
      next: [
        { window: "5h", percent: 1, resetAt: NOW + 5 * HOUR },
        { window: "weekly", percent: 41, resetAt: NOW + 5 * 24 * HOUR },
      ],
      now: NOW,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.window).toBe("5h");
    expect(events[0]?.kind).toBe("scheduled");
  });

  test("a window present only in the new snapshot is a baseline, not a reset", () => {
    const events = detectQuotaResets({
      scope: "anthropic",
      accountTag: "tag00000",
      previous: [],
      next: [{ window: "custom:Opus", percent: 0, resetAt: NOW + HOUR }],
      now: NOW,
    });
    expect(events).toEqual([]);
  });

  test("a clockless reset keys on the expired deadline instead of a shared sentinel", () => {
    // Upstream reported no NEW deadline. Keying every such reset as "none" would let the
    // first claim permanently suppress every later reset of this window.
    const first = detect({ percent: 90, resetAt: NOW - 1_000 }, { percent: 1 });
    const later = detect(
      { percent: 90, resetAt: NOW + 30 * DAY_MS },
      { percent: 1 },
      NOW + 31 * DAY_MS,
    );
    expect(first?.kind).toBe("scheduled");
    expect(later?.kind).toBe("scheduled");
    expect(first?.key).not.toBe(later?.key);
  });

  test("a window with no deadline on either side is not evaluated", () => {
    // Credit-balance providers never emit a reset clock; a bare drop there is as likely to
    // be a top-up as a rollover.
    expect(detect({ percent: 90 }, { percent: 5 })).toBeNull();
  });

  test("a deadline moving backward before its own expiry is not a reset", () => {
    expect(detect(
      { percent: 40, resetAt: NOW + 2 * HOUR },
      { percent: 40, resetAt: NOW + HOUR },
    )).toBeNull();
  });

  test("a deadline exactly equal to now counts as expired", () => {
    expect(detect({ percent: 90, resetAt: NOW }, { percent: 1, resetAt: NOW + HOUR })?.kind)
      .toBe("scheduled");
  });

  test("a clockless snapshot past an expired deadline still fires when usage fell", () => {
    expect(detect({ percent: 90, resetAt: NOW - 1_000 }, { percent: 1 })?.kind).toBe("scheduled");
  });
});

describe("a rolling window's natural creep is not a reset", () => {
  const base = { scope: "codex", accountTag: "tag00000" } as const;

  test("an hour into a 5h window, a 27-point decay fires nothing", () => {
    // Measured false positive. A rolling window (Anthropic five_hour, Codex burst) has no
    // rollover instant: usage ages out continuously, so its percent falls and its deadline
    // slides forward by about the elapsed time. MIN_SURPRISE_DROP_PERCENT only screens integer
    // rounding, so 88% -> 61% read as a surprise reset on the most common window in the system.
    const now = Date.now();
    expect(detectQuotaReset({
      ...base,
      previous: {
        window: "5h",
        percent: 88,
        resetAt: now + 4 * HOUR,
        windowSeconds: 5 * 3600,
        observedAt: now - HOUR,
      },
      next: { window: "5h", percent: 61, resetAt: now + 5 * HOUR, windowSeconds: 5 * 3600 },
      now,
    })).toBeNull();
  });

  test("a deadline that jumps a whole window is still a surprise reset", () => {
    // The discriminator is deadline MOVEMENT against elapsed time, not drop magnitude: decay
    // magnitude cannot be bounded from elapsed time, since an hour of idling can retire a large
    // burst that all landed in one minute. Two minutes elapsed, deadline forward two hours —
    // that is a new window, not creep.
    const now = Date.now();
    expect(detectQuotaReset({
      ...base,
      previous: {
        window: "5h",
        percent: 95,
        resetAt: now + 3 * HOUR,
        windowSeconds: 5 * 3600,
        observedAt: now - 120_000,
      },
      next: { window: "5h", percent: 3, resetAt: now + 5 * HOUR, windowSeconds: 5 * 3600 },
      now,
    })?.kind).toBe("surprise");
  });

  test("a standing-still deadline with falling usage is the clearest surprise signature", () => {
    const now = Date.now();
    const deadline = now + 3 * HOUR;
    expect(detectQuotaReset({
      ...base,
      previous: {
        window: "5h",
        percent: 90,
        resetAt: deadline,
        windowSeconds: 5 * 3600,
        observedAt: now - 60_000,
      },
      next: { window: "5h", percent: 4, resetAt: deadline, windowSeconds: 5 * 3600 },
      now,
    })?.kind).toBe("surprise");
  });

  test("a baseline written before observedAt existed fails OPEN", () => {
    // Absent evidence must not suppress a real reset. Old state files have no observedAt.
    const now = Date.now();
    expect(detectQuotaReset({
      ...base,
      previous: { window: "5h", percent: 95, resetAt: now + 3 * HOUR, windowSeconds: 5 * 3600 },
      next: { window: "5h", percent: 3, resetAt: now + 5 * HOUR, windowSeconds: 5 * 3600 },
      now,
    })?.kind).toBe("surprise");
  });

  test("the creep rule does not touch the scheduled branch", () => {
    // A scheduled rollover is proven by its own expired deadline, so it needs no magnitude or
    // movement test — and a weekly window issuing a week-long deadline must not read as creep.
    const now = Date.now();
    expect(detectQuotaReset({
      ...base,
      previous: {
        window: "weekly",
        percent: 90,
        resetAt: now - 1_000,
        windowSeconds: 7 * 24 * 3600,
        observedAt: now - HOUR,
      },
      next: {
        window: "weekly",
        percent: 0,
        resetAt: now + 7 * 24 * HOUR,
        windowSeconds: 7 * 24 * 3600,
      },
      now,
    })?.kind).toBe("scheduled");
  });
});
