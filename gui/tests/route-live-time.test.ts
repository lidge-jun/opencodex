import { describe, expect, test } from "bun:test";
import { timeParts, type TimeRow } from "../src/pages/route-live/time-parts";

const row = (extra: Partial<TimeRow>): TimeRow => ({ durationMs: 2000, ...extra });
const attempt = (extra: object) => ({ provider: "p", model: "m", status: 200, ...extra });

describe("timeParts", () => {
  test("a normal stream splits into internal, upstream wait and streaming", () => {
    expect(timeParts(row({
      upstreamSendMs: 12, firstOutputMs: 812, attempts: [attempt({ durationMs: 1988, firstOutputMs: 800 })],
    }))).toEqual([
      { kind: "internal", ms: 12 }, { kind: "upstreamWait", ms: 800 }, { kind: "streaming", ms: 1188 },
    ]);
  });

  test("privacy redaction is its own part and leaves the internal remainder", () => {
    const parts = timeParts(row({
      upstreamSendMs: 40, privacyRedactionMs: 25, attempts: [attempt({ durationMs: 1960, firstOutputMs: 500 })],
    }));
    expect(parts).toEqual([
      { kind: "privacy", ms: 25 }, { kind: "internal", ms: 15 }, { kind: "upstreamWait", ms: 500 }, { kind: "streaming", ms: 1460 },
    ]);
  });

  test("failover: earlier attempts are subtracted from the time before the final attempt", () => {
    const parts = timeParts(row({
      durationMs: 3000, upstreamSendMs: 1010, privacyRedactionMs: 5,
      attempts: [attempt({ status: 429, durationMs: 1000 }), attempt({ durationMs: 1990, firstOutputMs: 700 })],
    }));
    expect(parts).toEqual([
      { kind: "privacy", ms: 5 }, { kind: "internal", ms: 5 }, { kind: "earlier", ms: 1000 },
      { kind: "upstreamWait", ms: 700 }, { kind: "streaming", ms: 1290 },
    ]);
  });

  test("a combo row without upstreamSendMs derives the final attempt's start from the two measured durations", () => {
    const parts = timeParts(row({
      durationMs: 2500, attempts: [attempt({ status: 503, durationMs: 600 }), attempt({ durationMs: 1800, firstOutputMs: 400 })],
    }));
    expect(parts).toEqual([
      { kind: "internal", ms: 100 }, { kind: "earlier", ms: 600 }, { kind: "upstreamWait", ms: 400 }, { kind: "streaming", ms: 1400 },
    ]);
  });

  test("with no attempt first output, the request's own firstOutputMs is taken from the send time", () => {
    const parts = timeParts(row({ upstreamSendMs: 100, firstOutputMs: 600, attempts: [attempt({ durationMs: 1900 })] }));
    expect(parts).toEqual([
      { kind: "internal", ms: 100 }, { kind: "upstreamWait", ms: 500 }, { kind: "streaming", ms: 1400 },
    ]);
  });

  test("a non-streamed reply has no first output, so the rest of the time is one reading part", () => {
    expect(timeParts(row({ upstreamSendMs: 30, attempts: [attempt({ durationMs: 1970 })] }))).toEqual([
      { kind: "internal", ms: 30 }, { kind: "reading", ms: 1970 },
    ]);
  });

  test("parts under 0.1 ms are dropped and negatives clamp to zero", () => {
    const parts = timeParts(row({
      durationMs: 1000, upstreamSendMs: 0.05, privacyRedactionMs: 3, attempts: [attempt({ durationMs: 999.95, firstOutputMs: 2000 })],
    }));
    expect(parts).toEqual([{ kind: "privacy", ms: 3 }, { kind: "upstreamWait", ms: 2000 }]);
  });

  test("no usable timing returns null", () => {
    expect(timeParts(row({}))).toBeNull();
    expect(timeParts(row({ attempts: [attempt({})] }))).toBeNull();
    expect(timeParts(row({ upstreamSendMs: Number.NaN, attempts: [] }))).toBeNull();
    expect(timeParts(row({ durationMs: Number.NaN, upstreamSendMs: 5 }))).toBeNull();
    expect(timeParts(row({ durationMs: 0, upstreamSendMs: 0, attempts: [attempt({ durationMs: 0 })] }))).toBeNull();
  });
});
