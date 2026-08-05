import { describe, expect, spyOn, test } from "bun:test";
import {
  catalogRefreshIsPending,
  normalizeCatalogDisposition,
} from "../src/codex/catalog-refresh-status";
import type { CatalogDisposition } from "../src/codex/convergence-types";

describe("catalogRefreshIsPending", () => {
  test.each([
    {
      status: "committed",
      changed: false,
      degraded: false,
      notices: [],
    },
    {
      status: "committed",
      changed: true,
      degraded: true,
      notices: ["provider-network"],
    },
  ] satisfies CatalogDisposition[])("committed catalog state is not pending", disposition => {
    expect(catalogRefreshIsPending(disposition)).toBe(false);
  });

  test.each([
    { status: "skipped", reason: "not-requested", retryable: false },
    { status: "skipped", reason: "catalog-unavailable", retryable: false },
    { status: "skipped", reason: "busy", retryable: true },
    { status: "skipped", reason: "stale", retryable: true },
    { status: "skipped", reason: "refused", retryable: false },
  ] satisfies CatalogDisposition[])("skipped catalog state remains pending", disposition => {
    expect(catalogRefreshIsPending(disposition)).toBe(true);
  });

  test.each([
    {
      status: "failed",
      reason: "provider-auth",
      phase: "gather",
      retryable: true,
      partialWrite: false,
    },
    {
      status: "failed",
      reason: "provider-network",
      phase: "gather",
      retryable: true,
      partialWrite: false,
    },
    {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    },
  ] satisfies CatalogDisposition[])("failed catalog state remains pending", disposition => {
    expect(catalogRefreshIsPending(disposition)).toBe(true);
  });

  test("projects only a boolean and never exposes unexpected private detail", () => {
    const privateDetail = "https://alice:horse-battery@example.test/home/example/acct-123456";
    const disposition = {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
      privateDetail,
    } as CatalogDisposition & { privateDetail: string };
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const warningLog = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const projection = { catalogRefreshPending: catalogRefreshIsPending(disposition) };

      expect(projection).toEqual({ catalogRefreshPending: true });
      expect(JSON.stringify(projection)).not.toContain(privateDetail);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warningLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      warningLog.mockRestore();
    }
  });
});

describe("normalizeCatalogDisposition", () => {
  test("rebuilds only the public disposition fields", () => {
    const privateDetail = "Bearer private-token acct-private /private/catalog/path";
    const disposition = {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
      privateDetail,
      toJSON: () => ({ privateDetail }),
    };

    const normalized = normalizeCatalogDisposition(disposition);

    expect(normalized).toEqual({
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    });
    expect(JSON.stringify(normalized)).not.toContain(privateDetail);
    expect(JSON.stringify(normalized)).not.toContain("private-token");
  });

  test("rejects coercive and accessor-backed fields without invoking user code", () => {
    let coercions = 0;
    const coerciveReason = {
      privateDetail: "Bearer private-token",
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

  test("copies notice data without trusting a custom iterator", () => {
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
