import { describe, expect, test } from "bun:test";
import type {
  CatalogDisposition,
  CodexHistoryState,
  CodexObservedState,
  ConvergeOutcome,
} from "../src/codex/convergence-types";
import { toSyncResponse } from "../src/server/management/sync-response";

const history: CodexHistoryState = {
  status: "converged",
  attempts: 1,
  nextRetryAt: null,
  txId: "tx-1",
  pendingRows: 0,
  backupEntries: 0,
};

const catalogRefresh: CatalogDisposition = {
  status: "committed",
  changed: true,
  degraded: false,
  notices: [],
};

const observed: CodexObservedState = {
  aggregate: "applied",
  isApplied: true,
  desired: "on",
  converged: true,
  authority: { service: "owned", externalProvider: null },
  surfaces: {
    config: "applied",
    profile: "applied",
    catalog: "applied",
    cache: "applied",
    journal: "absent",
    history: {
      state: history,
      database: "applied",
      manifest: "applied",
      rollouts: "applied",
    },
    provenance: {
      state: "verified",
      nativeGeneration: 4,
      currentTxId: "tx-1",
    },
  },
};

async function projection(outcome: ConvergeOutcome): Promise<{
  status: number;
  body: unknown;
  retryAfter: string | null;
}> {
  const response = toSyncResponse(outcome);
  return {
    status: response.status,
    body: await response.json(),
    retryAfter: response.headers.get("Retry-After"),
  };
}

describe("toSyncResponse", () => {
  test("maps catalog-only", async () => {
    expect(await projection({
      kind: "catalog-only",
      changed: true,
      observed,
      catalogRefresh,
      history,
    })).toEqual({
      status: 200,
      body: { ok: true, changed: true, observed, catalogRefresh, history },
      retryAfter: null,
    });
  });

  test("maps converged, including desired OFF removal, without a separate desired-off row", async () => {
    expect(await projection({
      kind: "converged",
      direction: "removed",
      changed: true,
      observed,
      nativeGeneration: 4,
      currentTxId: "tx-1",
      catalogRefresh,
      history,
    })).toEqual({
      status: 200,
      body: { ok: true, changed: true, observed, catalogRefresh, history },
      retryAfter: null,
    });
  });

  test("maps skipped", async () => {
    expect(await projection({
      kind: "skipped",
      reason: "already-converged",
      observed,
      catalogRefresh,
      history,
    })).toEqual({
      status: 200,
      body: { ok: true, changed: false, observed, catalogRefresh, history },
      retryAfter: null,
    });
  });

  test("maps refused", async () => {
    expect(await projection({
      kind: "refused",
      authority: "provenance",
      message: "provenance does not authorize restore",
      observed,
    })).toEqual({
      status: 409,
      body: {
        ok: false,
        authority: "provenance",
        message: "provenance does not authorize restore",
        observed,
      },
      retryAfter: null,
    });
  });

  test("maps busy to 503 with Retry-After seconds", async () => {
    expect(await projection({
      kind: "busy",
      surface: "lock",
      retryAfterMs: 1_250,
    })).toEqual({
      status: 503,
      body: { ok: false, surface: "lock", retryAfterMs: 1_250 },
      retryAfter: "2",
    });
  });

  test("maps deferred", async () => {
    expect(await projection({
      kind: "deferred",
      direction: "applied",
      changed: true,
      unresolved: ["history", "catalog"],
      nativeGeneration: 4,
      currentTxId: "tx-1",
      observed,
      catalogRefresh,
      history,
    })).toEqual({
      status: 200,
      body: {
        ok: true,
        changed: true,
        unresolved: ["history", "catalog"],
        observed,
        catalogRefresh,
        history,
      },
      retryAfter: null,
    });
  });

  test("maps failed", async () => {
    expect(await projection({
      kind: "failed",
      surface: "provenance",
      message: "record write failed",
    })).toEqual({
      status: 500,
      body: { error: "record write failed", surface: "provenance" },
      retryAfter: null,
    });
  });
});
