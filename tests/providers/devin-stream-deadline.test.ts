import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cloudStreamHeadersMsForTests, CloudChatError } from "../../src/adapters/devin/cloud-direct/chat";
import { devinErrorClassification } from "../../src/adapters/devin";
import { repoPath } from "../helpers/repo-root";

const CHAT_SRC = readFileSync(repoPath("src/adapters/devin/cloud-direct/chat.ts"), "utf8");

function withEnv(value: string | undefined, run: () => void): void {
  const key = "OPENCODEX_DEVIN_TTFB_MS";
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

describe("cloud-direct response-headers deadline", () => {
  // A 60s budget killed live swe-2 high turns at exactly 60000ms with no output
  // while a sibling call on the same account was still alive at 76s. Cognition
  // withholds headers until the first token, so this budget bounds generation.
  test("the default outlives a reasoning model that thinks past a minute", () => {
    withEnv(undefined, () => {
      expect(cloudStreamHeadersMsForTests()).toBe(300_000);
    });
  });

  test("the headers budget is not shorter than the body idle budget", () => {
    // Inverting these is what made the pre-header window the tightest part of a
    // long turn, which is backwards.
    const idle = Number(/CLOUD_STREAM_IDLE_MS = ([0-9_]+)/.exec(CHAT_SRC)?.[1]?.replace(/_/g, ""));
    expect(idle).toBeGreaterThan(0);
    withEnv(undefined, () => {
      expect(cloudStreamHeadersMsForTests()).toBeGreaterThanOrEqual(idle);
    });
  });

  test("an operator override is honoured", () => {
    withEnv("1000", () => {
      expect(cloudStreamHeadersMsForTests()).toBe(1000);
    });
  });

  test("an override is clamped so a stray value cannot wedge a turn forever", () => {
    withEnv("999999999", () => {
      expect(cloudStreamHeadersMsForTests()).toBe(1_800_000);
    });
  });

  test.each(["", "   ", "0", "-5", "not-a-number"])("a useless override %p falls back to the default", (raw) => {
    withEnv(raw, () => {
      expect(cloudStreamHeadersMsForTests()).toBe(300_000);
    });
  });
});

describe("cloud-direct headers-deadline failure is ours, not the upstream", () => {
  // The old abort raised a bare Error, so devinErrorClassification returned {}
  // and the failure was inferred from message text as an upstream 502/504.
  test("the deadline error classifies as a gateway timeout the caller may retry", () => {
    const err = new CloudChatError("cloud-direct: no response headers within 300000ms", undefined, undefined, 504);
    expect(devinErrorClassification(err)).toEqual({ status: 504, retryable: true });
  });

  test("a bare Error still classifies as nothing, which is why the status is set explicitly", () => {
    expect(devinErrorClassification(new Error("cloud-direct: no response headers within 300000ms"))).toEqual({});
  });

  test("the message no longer claims a first-byte measurement it cannot make", () => {
    // Nothing is on the wire before headers, so "time-to-first-byte" described a
    // measurement that does not exist. Dropping the word "timeout" from it is why
    // the explicit 504 above is mandatory rather than cosmetic.
    expect(CHAT_SRC).not.toContain("time-to-first-byte");
  });
});

describe("cloud-direct headers deadline guards", () => {
  test("the abort callback records that we fired before aborting", () => {
    // Bun rejects the fetch with its own AbortError instead of handing back
    // signal.reason, so a typed error passed to abort() would be discarded and
    // the catch could not tell our deadline from a caller cancel.
    expect(CHAT_SRC).toMatch(/headersDeadlineFired = true;\s*\n\s*ttfbController\.abort\(\);/);
    expect(CHAT_SRC).not.toMatch(/ttfbController\.abort\(new /);
  });

  test("the GetChatMessage fetch disables the competing runtime timeout", () => {
    // Two independent deadlines on one hop means the shorter wins silently and
    // this function can no longer explain its own failure.
    const call = CHAT_SRC.slice(CHAT_SRC.indexOf("ApiServerService/GetChatMessage"));
    expect(call.slice(0, call.indexOf("} as RequestInit"))).toContain("timeout: 0");
  });

  test("a caller cancel is re-thrown unchanged", () => {
    expect(CHAT_SRC).toMatch(/if \(headersDeadlineFired\) \{[\s\S]*?\}\s*\n\s*throw err;/);
  });
});
