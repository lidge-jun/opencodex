import { describe, expect, test } from "bun:test";
import {
  catalogRefreshIsPending,
  normalizeCatalogDisposition,
} from "../src/codex/catalog-refresh-status";
import type { CatalogDisposition } from "../src/codex/convergence-types";

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
