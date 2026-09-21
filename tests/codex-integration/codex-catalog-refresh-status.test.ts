import { afterEach, describe, expect, test } from "bun:test";
import {
  catalogRefreshIsPending,
  lastCatalogAutoRefreshOutcome,
  normalizeCatalogDisposition,
  recordCatalogAutoRefreshOutcome,
  resetCatalogAutoRefreshStatusForTests,
} from "../../src/codex/catalog-refresh-status";
import type { CatalogDisposition } from "../../src/codex/convergence-types";

afterEach(() => {
  resetCatalogAutoRefreshStatusForTests();
});

describe("catalogRefreshIsPending", () => {
  test("only committed catalog state is complete", () => {
    const committed: CatalogDisposition = {
      status: "committed",
      changed: false,
      degraded: false,
      notices: [],
    };
    expect(catalogRefreshIsPending(committed)).toBe(false);
    expect(catalogRefreshIsPending({ status: "skipped", reason: "busy", retryable: true })).toBe(true);
    expect(catalogRefreshIsPending({
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    })).toBe(true);
  });
});

describe("normalizeCatalogDisposition", () => {
  test("rebuilds only public disposition fields", () => {
    const privateDetail = "Bearer private-token acct-private /private/catalog/path";
    const normalized = normalizeCatalogDisposition({
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
      privateDetail,
      toJSON: () => ({ privateDetail }),
    });

    expect(normalized).toEqual({
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    });
    expect(JSON.stringify(normalized)).not.toContain(privateDetail);
  });

  test("rejects coercive and accessor-backed fields without invoking them", () => {
    let coercions = 0;
    const coerciveReason = {
      toString: () => {
        coercions += 1;
        return "disk";
      },
    };
    expect(normalizeCatalogDisposition({
      status: "failed",
      reason: coerciveReason,
      phase: "commit",
      retryable: false,
      partialWrite: true,
    })).toBeNull();
    expect(coercions).toBe(0);

    let getterReads = 0;
    const accessorDisposition: Record<string, unknown> = {
      status: "failed",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    };
    Object.defineProperty(accessorDisposition, "reason", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "disk";
      },
    });
    expect(normalizeCatalogDisposition(accessorDisposition)).toBeNull();
    expect(getterReads).toBe(0);
  });

  test("copies notices without trusting a custom iterator", () => {
    let iteratorCalls = 0;
    const notices = ["provider-auth", "fallback"];
    Object.defineProperty(notices, Symbol.iterator, {
      value: () => {
        iteratorCalls += 1;
        throw new Error("private iterator detail");
      },
    });

    expect(normalizeCatalogDisposition({
      status: "committed",
      changed: true,
      degraded: true,
      notices,
    })).toEqual({
      status: "committed",
      changed: true,
      degraded: true,
      notices: ["provider-auth", "fallback"],
    });
    expect(iteratorCalls).toBe(0);
  });
});

describe("catalog auto-refresh last-outcome record", () => {
  test("consecutiveFailures climbs across pending dispositions and resets on a commit", () => {
    const skipped: CatalogDisposition = { status: "skipped", reason: "busy", retryable: true };
    const failed: CatalogDisposition = {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    };
    const committed: CatalogDisposition = {
      status: "committed",
      changed: true,
      degraded: false,
      notices: [],
    };

    const first = recordCatalogAutoRefreshOutcome(skipped, false);
    expect(first?.consecutiveFailures).toBe(1);
    const second = recordCatalogAutoRefreshOutcome(failed, false);
    expect(second?.consecutiveFailures).toBe(2);
    expect(lastCatalogAutoRefreshOutcome()?.consecutiveFailures).toBe(2);

    const done = recordCatalogAutoRefreshOutcome(committed, true);
    expect(done?.consecutiveFailures).toBe(0);
    expect(lastCatalogAutoRefreshOutcome()?.consecutiveFailures).toBe(0);
    expect(lastCatalogAutoRefreshOutcome()?.changed).toBe(true);
  });

  test("an unnormalizable disposition is dropped without changing the last outcome", () => {
    const seeded = recordCatalogAutoRefreshOutcome({
      status: "skipped",
      reason: "busy",
      retryable: true,
    }, false);
    expect(seeded?.consecutiveFailures).toBe(1);

    let coercions = 0;
    const coerciveReason = {
      toString: () => {
        coercions += 1;
        return "disk";
      },
    };
    expect(recordCatalogAutoRefreshOutcome({
      status: "failed",
      reason: coerciveReason,
      phase: "commit",
      retryable: false,
      partialWrite: true,
    } as unknown as CatalogDisposition, true)).toBeNull();
    expect(coercions).toBe(0);

    let getterReads = 0;
    const accessorDisposition: Record<string, unknown> = {
      status: "failed",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    };
    Object.defineProperty(accessorDisposition, "reason", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "disk";
      },
    });
    expect(recordCatalogAutoRefreshOutcome(
      accessorDisposition as unknown as CatalogDisposition,
      true,
    )).toBeNull();
    expect(getterReads).toBe(0);

    const last = lastCatalogAutoRefreshOutcome();
    expect(last?.consecutiveFailures).toBe(1);
    expect(last?.disposition).toEqual({ status: "skipped", reason: "busy", retryable: true });
    expect(last?.changed).toBe(false);
  });

  test("lastCatalogAutoRefreshOutcome hands back a frozen value a caller cannot mutate into scheduler state", () => {
    recordCatalogAutoRefreshOutcome({
      status: "committed",
      changed: false,
      degraded: true,
      notices: ["provider-auth"],
    }, false);
    const last = lastCatalogAutoRefreshOutcome();
    expect(last).not.toBeNull();
    expect(Object.isFrozen(last)).toBe(true);
    expect(Object.isFrozen(last!.disposition)).toBe(true);
    if (last!.disposition.status === "committed") {
      expect(Object.isFrozen(last!.disposition.notices)).toBe(true);
      expect(() => {
        (last!.disposition.notices as string[]).push("fallback");
      }).toThrow();
    }
    expect(() => {
      (last as { consecutiveFailures: number }).consecutiveFailures = 99;
    }).toThrow();
    expect(() => {
      (last as { changed: boolean }).changed = true;
    }).toThrow();

    const reread = lastCatalogAutoRefreshOutcome();
    expect(reread?.consecutiveFailures).toBe(0);
    expect(reread?.changed).toBe(false);
    expect(reread?.disposition).toEqual({
      status: "committed",
      changed: false,
      degraded: true,
      notices: ["provider-auth"],
    });
  });
});
