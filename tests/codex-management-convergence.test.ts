import { expect, test } from "bun:test";

import { createCatalogConvergeRequest } from "../src/codex/catalog-admission";
import {
  createManagementConvergeCodex,
  projectCatalogOnlyOutcome,
} from "../src/codex/management-convergence";
import type { CatalogDisposition } from "../src/codex/convergence-types";
import type { OcxConfig } from "../src/types";

function config(): OcxConfig {
  return { port: 10100, providers: {}, defaultProvider: "openai" };
}

test("projects unavailable generation admission as retryable busy", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  const outcome = await convergeCodex(createCatalogConvergeRequest({ deadlineMs: 1_000 }));

  expect(outcome).toEqual({
    kind: "catalog-only",
    changed: false,
    catalogRefresh: { status: "skipped", reason: "busy", retryable: true },
    history: {
      status: "not-evaluated",
      attempts: 0,
      nextRetryAt: null,
      txId: null,
      pendingRows: null,
      backupEntries: null,
    },
    observed: {
      aggregate: "not-evaluated",
      isApplied: null,
      desired: "unknown",
      converged: null,
      authority: { service: "unknown", externalProvider: null },
      surfaces: {
        config: "not-evaluated",
        profile: "not-evaluated",
        catalog: "not-evaluated",
        cache: "not-evaluated",
        journal: "not-evaluated",
        history: {
          state: {
            status: "not-evaluated",
            attempts: 0,
            nextRetryAt: null,
            txId: null,
            pendingRows: null,
            backupEntries: null,
          },
          database: "not-evaluated",
          manifest: "not-evaluated",
          rollouts: "not-evaluated",
        },
        provenance: {
          state: "not-evaluated",
          nativeGeneration: null,
          currentTxId: null,
        },
      },
    },
  });
});

test("refuses a non-catalog request through the total projection", async () => {
  const convergeCodex = createManagementConvergeCodex(config());

  const outcome = await convergeCodex({
    action: "observe",
    scope: "full",
    reason: "cli",
    mode: "explicit",
    deadlineMs: 1_000,
  });
  expect(outcome.kind).toBe("catalog-only");
  expect(outcome.catalogRefresh).toEqual({
    status: "failed",
    reason: "disk",
    phase: "gather",
    retryable: false,
    partialWrite: false,
  });
});

test("constructs the fixed catalog request and ignores caller attempts to choose direction", () => {
  const malformedInput = {
    action: "remove",
    scope: "full",
    reason: "cli",
    mode: "explicit",
    deadlineMs: 1_000,
  } as unknown as Parameters<typeof createCatalogConvergeRequest>[0];
  const request = createCatalogConvergeRequest(malformedInput);

  expect(request).toEqual({
    action: "converge",
    scope: "catalog",
    reason: "management-mutation",
    mode: "automatic",
    deadlineMs: 1_000,
  });
});

test("rejects malformed catalog request deadlines", () => {
  for (const deadlineMs of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(() => createCatalogConvergeRequest({ deadlineMs })).toThrow(
      "Catalog convergence deadlineMs must be a positive safe integer.",
    );
  }
});

const booleans = [false, true] as const;
const catalogRefreshVariants: readonly CatalogDisposition[] = [
  ...booleans.flatMap(changed => booleans.map(degraded => ({
    status: "committed" as const,
    changed,
    degraded,
    notices: ["provider-auth", "provider-network", "fallback"] as const,
  }))),
  ...(["not-requested", "catalog-unavailable", "busy", "stale", "refused"] as const)
    .flatMap(reason => booleans.map(retryable => ({
      status: "skipped" as const,
      reason,
      retryable,
    }))),
  ...(["provider-auth", "provider-network", "disk"] as const).flatMap(reason =>
    (["gather", "commit"] as const).flatMap(phase =>
      booleans.flatMap(retryable => booleans.map(partialWrite => ({
        status: "failed" as const,
        reason,
        phase,
        retryable,
        partialWrite,
      }))),
    ),
  ),
];

for (const changed of booleans) {
  for (const [variantIndex, catalogRefresh] of catalogRefreshVariants.entries()) {
    test(`projects changed=${changed} with catalog variant ${variantIndex} exactly`, () => {
      expect(projectCatalogOnlyOutcome({ changed, catalogRefresh })).toEqual({
        kind: "catalog-only",
        changed,
        catalogRefresh,
        history: {
          status: "not-evaluated",
          attempts: 0,
          nextRetryAt: null,
          txId: null,
          pendingRows: null,
          backupEntries: null,
        },
        observed: {
          aggregate: "not-evaluated",
          isApplied: null,
          desired: "unknown",
          converged: null,
          authority: { service: "unknown", externalProvider: null },
          surfaces: {
            config: "not-evaluated",
            profile: "not-evaluated",
            catalog: "not-evaluated",
            cache: "not-evaluated",
            journal: "not-evaluated",
            history: {
              state: {
                status: "not-evaluated",
                attempts: 0,
                nextRetryAt: null,
                txId: null,
                pendingRows: null,
                backupEntries: null,
              },
              database: "not-evaluated",
              manifest: "not-evaluated",
              rollouts: "not-evaluated",
            },
            provenance: {
              state: "not-evaluated",
              nativeGeneration: null,
              currentTxId: null,
            },
          },
        },
      });
    });
  }
}
