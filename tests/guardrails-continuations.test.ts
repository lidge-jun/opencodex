import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  clearGuardrailsContinuationsForTests,
  createGuardrailsContinuationScope,
  evictOldestGuardrailsContinuationForBudget,
  GuardrailsContinuationConflictError,
  guardrailsContinuationStatsForTests,
  mergeGuardrailsContinuationStates,
  rememberGuardrailsContinuation,
  retainGuardrailsContinuation,
  sweepExpiredGuardrailsContinuations,
} from "../src/guardrails/continuations";
import { createGuardrailsRegistry } from "../src/guardrails/registry";
import { demaskGuardrailsText } from "../src/guardrails/placeholders";
import { maskResponsesRequestFields } from "../src/guardrails/fields/responses";

setDefaultTimeout(15_000);

beforeEach(() => clearGuardrailsContinuationsForTests());
afterEach(() => clearGuardrailsContinuationsForTests());

test("Guardrails continuation mappings remain scoped, pinned, and preserve prior placeholders", () => {
  const registry = createGuardrailsRegistry({
    disabledBuiltinRuleIds: ["credentials.url_with_creds"],
  });
  try {
    const scope = createGuardrailsContinuationScope("configured", "key-a", "  client-thread-a ");
    const otherThread = createGuardrailsContinuationScope("configured", "key-a", "client-thread-b");
    const otherKey = createGuardrailsContinuationScope("configured", "key-b", "client-thread-a");
    const firstSecret = "sk_live_abcdefghijklmnopqrstuvwx";
    const first = maskResponsesRequestFields({ input: firstSecret }, registry);
    expect(first.body).toEqual({ input: "<STRIPE_ACCESS_TOKEN_1>" });
    const stored = rememberGuardrailsContinuation({
      responseId: "resp-guardrails-1",
      state: first.state,
      scope,
      lineageId: "lineage-a",
      policyRevision: "a".repeat(64),
    });
    expect(stored.status).toBe("stored");
    if (stored.status !== "stored") throw new Error("expected continuation mapping to be stored");

    expect(retainGuardrailsContinuation("resp-guardrails-1", otherThread)).toBeUndefined();
    expect(retainGuardrailsContinuation("resp-guardrails-1", otherKey)).toBeUndefined();
    expect(retainGuardrailsContinuation("resp-guardrails-1", undefined)).toBeUndefined();
    const inherited = retainGuardrailsContinuation("resp-guardrails-1", scope);
    expect(inherited).toBeDefined();
    if (!inherited) throw new Error("expected continuation mapping to be retained");
    const secondSecret = "sk_live_zyxwvutsrqponmlkjihgfedc";
    const second = maskResponsesRequestFields(
      { input: `prior <STRIPE_ACCESS_TOKEN_1>; new ${secondSecret}` },
      registry,
      inherited.state,
    );
    expect(second.body).toEqual({ input: "prior <STRIPE_ACCESS_TOKEN_1>; new <STRIPE_ACCESS_TOKEN_2>" });
    expect(demaskGuardrailsText("repeat <STRIPE_ACCESS_TOKEN_1>; current <STRIPE_ACCESS_TOKEN_2>", second.state)).toBe(`repeat ${firstSecret}; current ${secondSecret}`);

    const stats = guardrailsContinuationStatsForTests();
    expect(stats.entries).toBe(1);
    expect(stats.retainedBytes).toBeGreaterThan(0);
    expect(stats.pinnedBytes).toBe(stats.retainedBytes);
    expect(evictOldestGuardrailsContinuationForBudget()).toBe(0);

    inherited.release();
    stored.lease.release();
    expect(evictOldestGuardrailsContinuationForBudget()).toBeGreaterThan(0);
  } finally {
    registry.dispose();
  }
});

test("Guardrails continuation isolates identical response ids across scopes", () => {
  const registry = createGuardrailsRegistry();
  try {
    const masked = maskResponsesRequestFields(
      { input: "sk_live_abcdefghijklmnopqrstuvwx" },
      registry,
    );
    const first = rememberGuardrailsContinuation({
      responseId: "resp-collision",
      state: masked.state,
      scope: createGuardrailsContinuationScope("loopback", undefined, "thread-a"),
      lineageId: "lineage-a",
      policyRevision: "a".repeat(64),
    });
    expect(first.status).toBe("stored");
    const second = rememberGuardrailsContinuation({
      responseId: "resp-collision",
      state: masked.state,
      scope: createGuardrailsContinuationScope("loopback", undefined, "thread-b"),
      lineageId: "lineage-b",
      policyRevision: "b".repeat(64),
    });
    expect(second.status).toBe("stored");
    if (first.status !== "stored" || second.status !== "stored") {
      throw new Error("expected both scoped continuation mappings to be stored");
    }
    first.lease.release();
    second.lease.release();
    const firstRetained = retainGuardrailsContinuation(
      "resp-collision",
      createGuardrailsContinuationScope("loopback", undefined, "thread-a"),
    );
    const secondRetained = retainGuardrailsContinuation(
      "resp-collision",
      createGuardrailsContinuationScope("loopback", undefined, "thread-b"),
    );
    expect(firstRetained?.lineageId).toBe("lineage-a");
    expect(secondRetained?.lineageId).toBe("lineage-b");
    firstRetained?.release();
    secondRetained?.release();
  } finally {
    registry.dispose();
  }
});

test("Guardrails continuation retains only bounded digests for large WS scope identifiers", () => {
  const rawThreadId = "w".repeat(4_096);
  const rawKeyId = "configured-key-that-must-not-be-retained";
  const scope = createGuardrailsContinuationScope("configured", rawKeyId, rawThreadId);
  expect(scope).toBeDefined();
  expect(scope?.clientThreadDigest).toMatch(/^[0-9a-f]{32}$/);
  expect(scope?.apiKeyDigest).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.stringify(scope)).not.toContain(rawThreadId);
  expect(JSON.stringify(scope)).not.toContain(rawKeyId);

  const stored = rememberGuardrailsContinuation({
    responseId: "resp-large-ws-scope",
    scope,
    lineageId: "lineage-large-ws-scope",
    policyRevision: "a".repeat(64),
    state: {
      replacements: [{
        dataType: 6,
        original: "secret",
        placeholder: "<CUSTOM_1>",
        placeholderType: "CUSTOM",
        ruleId: "custom.large-ws-scope",
      }],
      reservedPlaceholders: [],
    },
  });
  expect(stored.status).toBe("stored");
  if (stored.status !== "stored") throw new Error("expected continuation mapping to be stored");
  expect(guardrailsContinuationStatsForTests().retainedBytes).toBeLessThan(2_048);
  stored.lease.release();

  const retained = retainGuardrailsContinuation(
    "resp-large-ws-scope",
    createGuardrailsContinuationScope("configured", rawKeyId, rawThreadId),
  );
  expect(retained?.lineageId).toBe("lineage-large-ws-scope");
  retained?.release();
  expect(createGuardrailsContinuationScope("configured", rawKeyId, `${rawThreadId}x`)).toBeUndefined();
});

test("Guardrails continuation merge rejects one original mapped to different placeholders", () => {
  const replacement = {
    dataType: 6,
    original: "same-secret",
    placeholderType: "CUSTOM",
    ruleId: "custom.merge",
  };
  expect(() => mergeGuardrailsContinuationStates(
    {
      replacements: [{ ...replacement, placeholder: "<CUSTOM_1>" }],
      reservedPlaceholders: [],
    },
    {
      replacements: [{ ...replacement, placeholder: "<CUSTOM_2>" }],
      reservedPlaceholders: [],
    },
  )).toThrow(GuardrailsContinuationConflictError);
});

test("Guardrails continuation poisons a same-scope response-id collision until expiry", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "collision-thread");
  const expiresAt = Date.now() + 60_000;
  const first = rememberGuardrailsContinuation({
    expiresAt,
    responseId: "resp-same-scope-collision",
    scope,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    state: {
      replacements: [{
        dataType: 6,
        original: "secret-a",
        placeholder: "<CUSTOM_1>",
        placeholderType: "CUSTOM",
        ruleId: "custom.collision",
      }],
      reservedPlaceholders: [],
    },
  });
  expect(first.status).toBe("stored");
  if (first.status !== "stored") throw new Error("expected continuation mapping to be stored");

  const collision = rememberGuardrailsContinuation({
    responseId: "resp-same-scope-collision",
    scope,
    lineageId: "lineage-b",
    policyRevision: "b".repeat(64),
    state: {
      replacements: [{
        dataType: 6,
        original: "secret-b",
        placeholder: "<CUSTOM_1>",
        placeholderType: "CUSTOM",
        ruleId: "custom.collision",
      }],
      reservedPlaceholders: [],
    },
  });
  expect(collision.status).toBe("collision");
  expect(retainGuardrailsContinuation("resp-same-scope-collision", scope)).toBeUndefined();
  expect(first.lease.state.replacements[0]?.original).toBe("secret-a");
  first.lease.release();

  expect(retainGuardrailsContinuation("resp-same-scope-collision", scope)).toBeUndefined();
  const stats = guardrailsContinuationStatsForTests();
  expect(stats.entries).toBe(1);
  expect(stats.retainedBytes).toBeGreaterThan(0);
  expect(stats.pinnedBytes).toBe(0);
  expect(evictOldestGuardrailsContinuationForBudget()).toBeGreaterThan(0);
  expect(sweepExpiredGuardrailsContinuations(expiresAt + 1)).toBe(0);
  expect(guardrailsContinuationStatsForTests()).toEqual({
    entries: 0,
    retainedBytes: 0,
    pinnedBytes: 0,
  });
});

test("Guardrails continuation accepts exact duplicate storage but poisons same-lineage mapping drift", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "same-lineage-collision");
  const state = {
    replacements: [{
      dataType: 6 as const,
      original: "secret-a",
      placeholder: "<CUSTOM_1>",
      placeholderType: "CUSTOM",
      ruleId: "custom.same-lineage",
    }],
    reservedPlaceholders: [],
  };
  const first = rememberGuardrailsContinuation({
    responseId: "resp-same-lineage",
    scope,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    state,
  });
  expect(first.status).toBe("stored");
  if (first.status !== "stored") throw new Error("expected continuation mapping to be stored");
  const duplicate = rememberGuardrailsContinuation({
    responseId: "resp-same-lineage",
    scope,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    state,
  });
  expect(duplicate.status).toBe("stored");
  if (duplicate.status !== "stored") throw new Error("expected duplicate continuation mapping to be leased");

  const collision = rememberGuardrailsContinuation({
    responseId: "resp-same-lineage",
    scope,
    lineageId: "lineage-a",
    policyRevision: "a".repeat(64),
    state: {
      replacements: [{
        ...state.replacements[0]!,
        original: "secret-b",
      }],
      reservedPlaceholders: [],
    },
  });

  expect(collision.status).toBe("collision");
  expect(retainGuardrailsContinuation("resp-same-lineage", scope)).toBeUndefined();
  expect(first.lease.state.replacements[0]?.original).toBe("secret-a");
  duplicate.lease.release();
  first.lease.release();
});

test("Guardrails continuation keeps inherited absolute expiry", () => {
  const registry = createGuardrailsRegistry();
  try {
    const masked = maskResponsesRequestFields(
      { input: "sk_live_abcdefghijklmnopqrstuvwx" },
      registry,
    );
    const expiresAt = Date.now() + 50;
    const stored = rememberGuardrailsContinuation({
      responseId: "resp-expiry",
      state: masked.state,
      scope: createGuardrailsContinuationScope("environment", undefined, "thread-a"),
      lineageId: "lineage-a",
      policyRevision: "a".repeat(64),
      expiresAt,
    });
    expect(stored.status).toBe("stored");
    if (stored.status !== "stored") throw new Error("expected continuation mapping to be stored");
    expect(stored.lease.expiresAt).toBe(expiresAt);
    expect(sweepExpiredGuardrailsContinuations(expiresAt + 1)).toBe(0);
    stored.lease.release();
    expect(sweepExpiredGuardrailsContinuations(expiresAt + 1)).toBe(1);
  } finally {
    registry.dispose();
  }
});

test("Guardrails continuation mappings are intentionally lost after process restart", () => {
  const registry = createGuardrailsRegistry();
  try {
    const scope = createGuardrailsContinuationScope(
      "configured",
      "key-restart",
      "thread-restart",
    );
    const masked = maskResponsesRequestFields(
      { input: "sk_live_abcdefghijklmnopqrstuvwx" },
      registry,
    );
    const stored = rememberGuardrailsContinuation({
      responseId: "resp-restart-loss",
      state: masked.state,
      scope,
      lineageId: "lineage-restart",
      policyRevision: "a".repeat(64),
    });
    expect(stored.status).toBe("stored");
    if (stored.status === "stored") stored.lease.release();
    expect(retainGuardrailsContinuation("resp-restart-loss", scope)).toBeDefined();

    clearGuardrailsContinuationsForTests();

    expect(retainGuardrailsContinuation("resp-restart-loss", scope)).toBeUndefined();
    expect(guardrailsContinuationStatsForTests()).toEqual({
      entries: 0,
      retainedBytes: 0,
      pinnedBytes: 0,
    });
  } finally {
    registry.dispose();
  }
});

test("Guardrails continuation rejects admission before pinned entries can exceed the byte cap", () => {
  const scope = createGuardrailsContinuationScope("loopback", undefined, "pinned-cap-thread");
  const leases: Array<{ release(): void }> = [];
  let rejected = false;
  try {
    for (let index = 0; index < 16; index += 1) {
      const result = rememberGuardrailsContinuation({
        responseId: `resp-pinned-${index}`,
        scope,
        lineageId: `lineage-${index}`,
        policyRevision: "a".repeat(64),
        state: {
          replacements: [{
            dataType: 6,
            original: `${index}:${"x".repeat(1024 * 1024)}`,
            placeholder: `<TOKEN_${index + 1}>`,
            placeholderType: "TOKEN",
            ruleId: "test.capacity",
          }],
          reservedPlaceholders: [],
        },
      });
      if (result.status === "stored") {
        leases.push(result.lease);
        expect(guardrailsContinuationStatsForTests().retainedBytes)
          .toBeLessThanOrEqual(8 * 1024 * 1024);
        continue;
      }
      expect(result.status).toBe("over_capacity");
      rejected = true;
      break;
    }
    expect(rejected).toBe(true);
    expect(guardrailsContinuationStatsForTests().retainedBytes)
      .toBeLessThanOrEqual(8 * 1024 * 1024);
  } finally {
    for (const lease of leases) lease.release();
  }
});
