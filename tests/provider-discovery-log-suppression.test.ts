import { afterEach, describe, expect, test } from "bun:test";
import {
  clearModelCache,
  markProviderDiscoveryFailed,
  markProviderDiscoveryOk,
  shouldLogDiscoveryFailure,
} from "../src/codex/model-cache";

const P = "azure-foundry-anthropic";

afterEach(() => clearModelCache(P));

describe("shouldLogDiscoveryFailure (#395 log flood)", () => {
  test("logs the first failure, then suppresses an identical repeat", () => {
    // First 404: no prior status -> log.
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(true);
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    // Same 404 signature on the next poll -> suppressed.
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(false);
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(false);
  });

  test("logs again when the HTTP status changes", () => {
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 500 })).toBe(true);
  });

  test("logs again when the failure reason changes", () => {
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    expect(shouldLogDiscoveryFailure(P, { reason: "network" })).toBe(true);
    markProviderDiscoveryFailed(P, { reason: "network" });
    expect(shouldLogDiscoveryFailure(P, { reason: "network" })).toBe(false);
  });

  test("a recovery (ok) resets suppression so the next failure logs", () => {
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(false);
    markProviderDiscoveryOk(P);
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(true);
  });

  test("clearing the cache resets suppression", () => {
    markProviderDiscoveryFailed(P, { reason: "http", httpStatus: 404 });
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(false);
    clearModelCache(P);
    expect(shouldLogDiscoveryFailure(P, { reason: "http", httpStatus: 404 })).toBe(true);
  });
});
