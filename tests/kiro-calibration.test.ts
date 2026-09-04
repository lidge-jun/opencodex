import { beforeEach, describe, expect, test } from "bun:test";
import { calibrateKiroEstimate, recordKiroCalibration, resetKiroCalibration } from "../src/adapters/kiro-calibration";

beforeEach(() => resetKiroCalibration());

describe("kiro per-conversation calibration", () => {
  test("an unseen conversation is returned untouched", () => {
    expect(calibrateKiroEstimate("conv-new", 1000)).toBe(1000);
    expect(calibrateKiroEstimate(undefined, 1000)).toBe(1000);
  });

  test("an under-estimate is corrected upward on the next turn", () => {
    // Upstream charged 1500 for a payload we called 1000: we are reading 2/3 of the truth.
    recordKiroCalibration("conv-a", 1000, 1500);
    const corrected = calibrateKiroEstimate("conv-a", 1000);
    expect(corrected).toBeGreaterThan(1000);
    expect(corrected).toBeLessThanOrEqual(1500);
  });

  test("repeated consistent observations converge toward the observed ratio", () => {
    for (let i = 0; i < 12; i++) recordKiroCalibration("conv-b", 1000, 1500);
    // Smoothing means it approaches 1.5 rather than jumping there.
    expect(calibrateKiroEstimate("conv-b", 1000)).toBeGreaterThan(1400);
    expect(calibrateKiroEstimate("conv-b", 1000)).toBeLessThanOrEqual(1500);
  });

  test("a single outlier cannot swing the estimate to the outlier's ratio", () => {
    for (let i = 0; i < 10; i++) recordKiroCalibration("conv-c", 1000, 1000);
    recordKiroCalibration("conv-c", 1000, 2900);
    // One reading moves it partway, not all the way.
    expect(calibrateKiroEstimate("conv-c", 1000)).toBeLessThan(1800);
  });

  test("the factor stays inside its clamp under absurd input", () => {
    for (let i = 0; i < 50; i++) recordKiroCalibration("conv-hi", 1, 5);
    expect(calibrateKiroEstimate("conv-hi", 1000)).toBeLessThanOrEqual(3000);
    for (let i = 0; i < 50; i++) recordKiroCalibration("conv-lo", 1000, 1);
    // Shrinking is the dangerous direction, so the lower clamp is tighter.
    expect(calibrateKiroEstimate("conv-lo", 1000)).toBeGreaterThanOrEqual(700);
  });

  test("implausible and malformed observations are ignored, not clamped in", () => {
    for (const [est, charged] of [[1000, 0], [0, 1000], [1000, Number.NaN], [Number.POSITIVE_INFINITY, 1000], [1000, 100_000]] as const) {
      recordKiroCalibration("conv-junk", est, charged);
    }
    expect(calibrateKiroEstimate("conv-junk", 1000)).toBe(1000);
  });

  test("conversations are isolated from each other", () => {
    recordKiroCalibration("conv-x", 1000, 2000);
    expect(calibrateKiroEstimate("conv-y", 1000)).toBe(1000);
    expect(calibrateKiroEstimate("conv-x", 1000)).toBeGreaterThan(1000);
  });

  test("tracking is bounded: old conversations are evicted rather than accumulating", () => {
    for (let i = 0; i < 600; i++) recordKiroCalibration("conv-" + i, 1000, 1500);
    // The earliest conversation has been evicted and behaves as unseen again.
    expect(calibrateKiroEstimate("conv-0", 1000)).toBe(1000);
    // The most recent is still remembered.
    expect(calibrateKiroEstimate("conv-599", 1000)).toBeGreaterThan(1000);
  });

  test("a conversation that was already accurate is left essentially alone", () => {
    for (let i = 0; i < 10; i++) recordKiroCalibration("conv-ok", 1000, 1000);
    expect(calibrateKiroEstimate("conv-ok", 1000)).toBe(1000);
  });

  // The correction must be learned against the RAW heuristic output. If it were learned against
  // the already-corrected estimate it would only ever measure its own leftover error, so each
  // round would close part of the remaining gap and the factor would stall short of the truth.
  test("a mis-estimating conversation converges on the real charge, not part of the way to it", () => {
    const conv = "conv-converge";
    const trueRatio = 1.35;
    let lastRatio = 0;
    for (let turn = 1; turn <= 6; turn++) {
      const raw = 10_000 * turn;
      const applied = calibrateKiroEstimate(conv, raw);
      const charged = Math.round(raw * trueRatio);
      lastRatio = applied / charged;
      recordKiroCalibration(conv, applied, charged);
    }
    expect(lastRatio).toBeGreaterThan(0.97);
    expect(lastRatio).toBeLessThan(1.03);
  });

  test("the raw-estimate map is bounded even when turns are never charged", () => {
    for (let i = 0; i < 600; i++) calibrateKiroEstimate("uncharged-" + i, 1000);
    recordKiroCalibration("uncharged-0", 1000, 1500);
    // Evicted, so it learns from the caller's value and stays inside the clamp.
    expect(calibrateKiroEstimate("uncharged-0", 1000)).toBeLessThanOrEqual(1500);
  });

  // A retry can report twice for one turn. The second report must not be scored against the
  // first turn's baseline, which by then describes a payload that has already grown.
  test("a repeated report for the same turn is not re-learned from a stale baseline", () => {
    calibrateKiroEstimate("conv-dup", 1000);
    recordKiroCalibration("conv-dup", 1000, 1300);
    const afterFirst = calibrateKiroEstimate("conv-dup", 1000);
    recordKiroCalibration("conv-dup", 1000, 1300);
    const afterSecond = calibrateKiroEstimate("conv-dup", 1000);
    // The second identical observation is consistent, so it must not push the factor further.
    expect(afterSecond).toBe(afterFirst);
  });

  // The upstream checkpoint is the context size AFTER the response, while the estimate covers the
  // request alone. Learning from the raw checkpoint would charge generated tokens to
  // prompt-tokenization error: a short prompt answered at length would look like a huge
  // under-estimate and inflate every later request in that conversation.
  test("output tokens must be removed before learning, or a long answer poisons the factor", () => {
    const requestEstimate = 1000;
    const trulyAccurate = 1000;   // our estimate was exactly right for the prompt
    const longAnswer = 2000;      // ...but the model then wrote a long response
    const checkpointAfterResponse = trulyAccurate + longAnswer;

    // Correct: subtract the output, observe a 1.0 ratio, leave the estimate alone.
    calibrateKiroEstimate("conv-good", requestEstimate);
    recordKiroCalibration("conv-good", requestEstimate, checkpointAfterResponse - longAnswer);
    expect(calibrateKiroEstimate("conv-good", requestEstimate)).toBe(requestEstimate);

    // Wrong: feeding the post-response checkpoint straight in learns a 3x error that never existed.
    calibrateKiroEstimate("conv-bad", requestEstimate);
    recordKiroCalibration("conv-bad", requestEstimate, checkpointAfterResponse);
    expect(calibrateKiroEstimate("conv-bad", requestEstimate)).toBeGreaterThan(requestEstimate * 2);
  });
});
