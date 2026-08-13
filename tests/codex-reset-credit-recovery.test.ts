import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CodexResetCreditRecoveryCoordinator,
  MAX_OPERATION_TIMEOUT_MS,
  MAX_TRACKED_RECOVERY_ACCOUNTS,
  MAX_TRACKED_RECOVERY_FLIGHTS,
  MAX_TRACKED_RECOVERY_WAITERS_PER_FLIGHT,
  resetCodexResetCreditRecoveryProcessStateForTests,
  type CodexResetCreditLogicalTurn,
  type CodexResetCreditRecoveryAuthorization,
  type CodexResetCreditRecoveryDependencies,
  type CodexResetCreditRecoveryGeneration,
  type CodexResetCreditRevalidationResult,
} from "../src/codex/reset-credit-recovery";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";

const BASE_GENERATION: CodexResetCreditRecoveryGeneration = {
  accountId: "account-a",
  credentialGeneration: 4,
  exhaustionGeneration: 9,
};

function eligible(
  generation: CodexResetCreditRecoveryGeneration,
  availableCredits = 1,
): CodexResetCreditRevalidationResult {
  return {
    kind: "eligible",
    accountId: generation.accountId,
    credentialGeneration: generation.credentialGeneration,
    exhaustionGeneration: generation.exhaustionGeneration,
    availableCredits,
  };
}

const AUTHORIZATION = {
  enabled: true,
  isOutputExposed: () => false,
  rejection: {
    kind: "reset-eligible-exhaustion",
    status: 429,
    alternateRetryEligible: true,
    resetCreditEligible: true,
    semanticCode: "usage_limit_exceeded",
  },
} as const satisfies CodexResetCreditRecoveryAuthorization;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIFFERENT_OPERATION_ID = "00000000-0000-4000-8000-000000000999";
const DEFAULT_COORDINATION_SCOPE = Object.freeze({});
const INVALID_TIMEOUT_MESSAGE = `operationTimeoutMs must be an integer from 1 to ${MAX_OPERATION_TIMEOUT_MS}`;
const INVALID_ATTEMPTS_MESSAGE = "maxConsumeAttempts must be an integer from 1 to 3";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeCoordinator(
  overrides: Partial<CodexResetCreditRecoveryDependencies> = {},
): CodexResetCreditRecoveryCoordinator {
  return new CodexResetCreditRecoveryCoordinator({
    coordinationScope: DEFAULT_COORDINATION_SCOPE,
    revalidate: async generation => eligible(generation),
    consume: async ({ operationId }) => ({ code: "reset", operationId }),
    ...overrides,
  });
}

function recover(
  coordinator: CodexResetCreditRecoveryCoordinator,
  turn: CodexResetCreditLogicalTurn,
  generation: CodexResetCreditRecoveryGeneration = BASE_GENERATION,
  options: { signal?: AbortSignal } = {},
  authorization: CodexResetCreditRecoveryAuthorization = AUTHORIZATION,
) {
  return coordinator.recover(turn, generation, authorization, options);
}

beforeEach(async () => {
  await resetCodexResetCreditRecoveryProcessStateForTests();
});

afterEach(async () => {
  await resetCodexResetCreditRecoveryProcessStateForTests();
});

describe("Codex reset-credit recovery coordinator", () => {
  test("creates one stable operation identity and permits only one attempt per turn", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const seenOperationIds: string[] = [];
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        seenOperationIds.push(operationId);
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();

    const first = await recover(coordinator, turn);
    const second = await recover(coordinator, turn, {
      ...BASE_GENERATION,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
    });

    expect(turn.operationId).toMatch(UUID_V4_RE);
    expect(first).toEqual({ kind: "refresh-required", code: "reset" });
    expect(second).toEqual(first);
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 1,
      consumeCalls: 1,
    });
    expect(seenOperationIds).toEqual([turn.operationId]);
  });

  test("reserves a logical turn before an output guard can re-enter recovery", async () => {
    const seenGenerations: CodexResetCreditRecoveryGeneration[] = [];
    const seenOperationIds: string[] = [];
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        seenGenerations.push(generation);
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        seenOperationIds.push(operationId);
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();
    let reentered = false;
    let reentrantAttempt: ReturnType<typeof recover> | undefined;
    const authorization: CodexResetCreditRecoveryAuthorization = {
      ...AUTHORIZATION,
      isOutputExposed: () => {
        if (!reentered) {
          reentered = true;
          reentrantAttempt = recover(coordinator, turn, {
            ...BASE_GENERATION,
            exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
          });
        }
        return false;
      },
    };

    const attempt = recover(coordinator, turn, BASE_GENERATION, {}, authorization);

    expect(reentrantAttempt).toBe(attempt);
    expect(await attempt).toEqual({ kind: "refresh-required", code: "reset" });
    expect(await reentrantAttempt).toEqual({ kind: "refresh-required", code: "reset" });
    expect(seenGenerations).toEqual([BASE_GENERATION]);
    expect(consumeCalls).toBe(1);
    expect(seenOperationIds).toEqual([turn.operationId]);
  });

  test("generation accessors cannot outrun a re-entrant turn reservation", async () => {
    const seenGenerations: CodexResetCreditRecoveryGeneration[] = [];
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        seenGenerations.push(generation);
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();
    const reentrantGeneration = {
      ...BASE_GENERATION,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
    };
    let reentered = false;
    let reentrantAttempt: ReturnType<typeof recover> | undefined;
    const generationWithGetter = {
      get accountId() {
        if (!reentered) {
          reentered = true;
          reentrantAttempt = recover(coordinator, turn, reentrantGeneration);
        }
        return BASE_GENERATION.accountId;
      },
      credentialGeneration: BASE_GENERATION.credentialGeneration,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration,
    } satisfies CodexResetCreditRecoveryGeneration;

    const attempt = recover(coordinator, turn, generationWithGetter);

    expect(reentrantAttempt).toBe(attempt);
    expect(await attempt).toEqual({ kind: "refresh-required", code: "reset" });
    expect(seenGenerations).toEqual([BASE_GENERATION]);
    expect(consumeCalls).toBe(1);
  });

  test("a throwing generation accessor rejects the reserved re-entrant attempt", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();
    const accessorError = new Error("generation accessor failed");
    let reentrantAttempt: ReturnType<typeof recover> | undefined;
    const generationWithThrowingGetter = {
      get accountId() {
        reentrantAttempt = recover(coordinator, turn, BASE_GENERATION);
        throw accessorError;
      },
      credentialGeneration: BASE_GENERATION.credentialGeneration,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration,
    } satisfies CodexResetCreditRecoveryGeneration;

    const attempt = recover(coordinator, turn, generationWithThrowingGetter);

    expect(reentrantAttempt).toBe(attempt);
    await expect(attempt).rejects.toBe(accessorError);
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
  });

  test("rejects inherited generation fields before creating a flight", async () => {
    const coordinator = makeCoordinator();
    const inheritedGeneration = Object.create(BASE_GENERATION) as CodexResetCreditRecoveryGeneration;

    await expect(recover(
      coordinator,
      coordinator.createLogicalTurn(),
      inheritedGeneration,
    )).rejects.toThrow("generation fields must be own properties");
    expect(coordinator.activeFlightCountForTests()).toBe(0);
  });

  test("admits the main sentinel and rejects noncanonical account ids", async () => {
    const coordinator = makeCoordinator();
    expect(await recover(coordinator, coordinator.createLogicalTurn(), {
      ...BASE_GENERATION,
      accountId: MAIN_CODEX_ACCOUNT_ID,
    })).toEqual({ kind: "refresh-required", code: "reset" });

    for (const accountId of ["", " ", "__proto__", "__PROTO__", "constructor", "a".repeat(65)]) {
      await expect(recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId,
      })).rejects.toThrow("accountId must be the main sentinel or a canonical pool-account id");
    }
  });

  test.each([
    ["revalidate", { revalidate: 0 }],
    ["consume", { consume: {} }],
  ] as const)("rejects a non-callable %s adapter at construction", (name, invalid) => {
    const dependencies = {
      coordinationScope: DEFAULT_COORDINATION_SCOPE,
      revalidate: async (generation: CodexResetCreditRecoveryGeneration) => eligible(generation),
      consume: async ({ operationId }: { operationId: string }) => ({ code: "reset", operationId }),
      ...invalid,
    } as unknown as CodexResetCreditRecoveryDependencies;

    expect(() => new CodexResetCreditRecoveryCoordinator(dependencies))
      .toThrow(`${name} must be a function`);
  });

  test("rejects a non-AbortSignal lifecycle dependency at construction", () => {
    expect(() => makeCoordinator({ lifecycleSignal: {} as AbortSignal }))
      .toThrow("lifecycleSignal must be an AbortSignal");
  });

  test.each([
    [{ operationTimeoutMs: 0 }, INVALID_TIMEOUT_MESSAGE],
    [{ operationTimeoutMs: MAX_OPERATION_TIMEOUT_MS + 1 }, INVALID_TIMEOUT_MESSAGE],
    [{ operationTimeoutMs: 1.5 }, INVALID_TIMEOUT_MESSAGE],
    [{ maxConsumeAttempts: 0 }, INVALID_ATTEMPTS_MESSAGE],
    [{ maxConsumeAttempts: 4 }, INVALID_ATTEMPTS_MESSAGE],
    [{ maxConsumeAttempts: 1.5 }, INVALID_ATTEMPTS_MESSAGE],
  ] as const)("rejects invalid constructor limit %o", (invalid, message) => {
    expect(() => makeCoordinator(invalid)).toThrow(message);
  });

  test("requires explicit opt-in, unexposed output, and a verified reset rejection", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const disabled = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, enabled: false },
    );
    const exposed = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: () => true },
    );
    const generic = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        enabled: true,
        isOutputExposed: () => false,
        rejection: {
          kind: "generic-rate-limit",
          status: 429,
          alternateRetryEligible: true,
          resetCreditEligible: false,
        },
      },
    );
    const wrongStatus = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: { ...AUTHORIZATION.rejection, status: 500 },
      },
    );
    const resetFlagFalse = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: { ...AUTHORIZATION.rejection, resetCreditEligible: false },
      },
    );
    const wrongKind = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: { ...AUTHORIZATION.rejection, kind: "generic-rate-limit" },
      } as unknown as CodexResetCreditRecoveryAuthorization,
    );
    const unknownSemanticCode = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: { ...AUTHORIZATION.rejection, semanticCode: "unknown_quota_code" },
      } as unknown as CodexResetCreditRecoveryAuthorization,
    );
    const inheritedRejection = await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: Object.create(AUTHORIZATION.rejection),
      },
    );

    expect(disabled).toEqual({ kind: "not-dispatched", reason: "disabled" });
    expect(exposed).toEqual({
      kind: "not-dispatched",
      reason: "output-already-exposed",
    });
    expect(generic).toEqual({
      kind: "not-dispatched",
      reason: "ineligible-rejection",
    });
    expect(wrongStatus).toEqual(generic);
    expect(resetFlagFalse).toEqual(generic);
    expect(wrongKind).toEqual(generic);
    expect(unknownSemanticCode).toEqual(generic);
    expect(inheritedRejection).toEqual(generic);
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
  });

  test("accepts the verified 402 insufficient-quota classifier output", async () => {
    const coordinator = makeCoordinator();
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      {
        ...AUTHORIZATION,
        rejection: {
          ...AUTHORIZATION.rejection,
          status: 402,
          semanticCode: "insufficient_quota",
        },
      },
    )).toEqual({ kind: "refresh-required", code: "reset" });
  });

  test("rechecks the live output commitment before irreversible dispatch", async () => {
    const started = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let outputExposed = false;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async () => {
        started.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: () => outputExposed },
    );
    await started.promise;
    outputExposed = true;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await pending).toEqual({
      kind: "not-dispatched",
      reason: "output-already-exposed",
    });
    expect(consumeCalls).toBe(0);
  });

  test("a removed re-entrant guard cannot authorize an exposed waiter", async () => {
    const firstCancelled = new AbortController();
    const revalidationStarted = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let firstGuardCalls = 0;
    let secondOutputExposed = false;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async () => {
        revalidationStarted.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const first = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: firstCancelled.signal },
      {
        ...AUTHORIZATION,
        isOutputExposed: () => {
          firstGuardCalls += 1;
          if (firstGuardCalls === 2) firstCancelled.abort();
          return false;
        },
      },
    );
    const second = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: () => secondOutputExposed },
    );

    await revalidationStarted.promise;
    secondOutputExposed = true;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(await second).toEqual({
      kind: "not-dispatched",
      reason: "output-already-exposed",
    });
    expect(firstGuardCalls).toBe(2);
    expect(consumeCalls).toBe(0);
  });

  test("duplicate guard functions retain distinct waiter registrations", async () => {
    const firstCancelled = new AbortController();
    const revalidationStarted = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let guardCalls = 0;
    let outputExposed = false;
    let consumeCalls = 0;
    const sharedGuard = () => {
      guardCalls += 1;
      if (guardCalls === 3) {
        outputExposed = true;
        firstCancelled.abort();
        return false;
      }
      return outputExposed;
    };
    const coordinator = makeCoordinator({
      revalidate: async () => {
        revalidationStarted.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const first = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: firstCancelled.signal },
      { ...AUTHORIZATION, isOutputExposed: sharedGuard },
    );
    const second = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: sharedGuard },
    );

    await revalidationStarted.promise;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(await second).toEqual({
      kind: "not-dispatched",
      reason: "output-already-exposed",
    });
    expect(guardCalls).toBe(4);
    expect(consumeCalls).toBe(0);
  });

  test("rechecks a waiter registered during re-entrant guard evaluation", async () => {
    const firstCancelled = new AbortController();
    const revalidationStarted = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let firstGuardCalls = 0;
    let replacementGuardCalls = 0;
    let consumeCalls = 0;
    let replacement: ReturnType<typeof recover> | undefined;
    const replacementGuard = () => {
      replacementGuardCalls += 1;
      return false;
    };
    const coordinator = makeCoordinator({
      revalidate: async () => {
        revalidationStarted.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const first = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: firstCancelled.signal },
      {
        ...AUTHORIZATION,
        isOutputExposed: () => {
          firstGuardCalls += 1;
          if (firstGuardCalls === 2) {
            replacement = recover(
              coordinator,
              coordinator.createLogicalTurn(),
              BASE_GENERATION,
              {},
              { ...AUTHORIZATION, isOutputExposed: replacementGuard },
            );
            firstCancelled.abort();
          }
          return false;
        },
      },
    );

    await revalidationStarted.promise;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(replacement).toBeDefined();
    expect(await replacement).toEqual({ kind: "refresh-required", code: "reset" });
    expect(firstGuardCalls).toBe(2);
    expect(replacementGuardCalls).toBeGreaterThanOrEqual(2);
    expect(consumeCalls).toBe(1);
  });

  test("bounds guards registered during re-entrant evaluation", async () => {
    const revalidationStarted = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    const attempts: Array<ReturnType<typeof recover>> = [];
    let consumeCalls = 0;
    let coordinator!: CodexResetCreditRecoveryCoordinator;

    const makeGuard = (depth: number): (() => boolean) => {
      let calls = 0;
      return () => {
        calls += 1;
        if (calls === 1) return false;
        if (calls === 2 && depth < 3) {
          attempts.push(recover(
            coordinator,
            coordinator.createLogicalTurn(),
            BASE_GENERATION,
            {},
            { ...AUTHORIZATION, isOutputExposed: makeGuard(depth + 1) },
          ));
        }
        return depth < 3;
      };
    };

    coordinator = makeCoordinator({
      revalidate: async () => {
        revalidationStarted.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const first = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: makeGuard(0) },
    );
    attempts.push(first);
    await revalidationStarted.promise;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "output-already-exposed",
    });
    expect(attempts).toHaveLength(4);
    expect(await Promise.all(attempts)).toEqual(Array.from(
      { length: 4 },
      () => ({ kind: "not-dispatched", reason: "output-already-exposed" }),
    ));
    expect(consumeCalls).toBe(0);
  });

  test("single-flights concurrent turns process-wide for the same generation", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    const started = deferred<void>();
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const seenOperationIds: string[] = [];
    const revalidate = async () => {
      revalidationCalls += 1;
      started.resolve();
      return await gate.promise;
    };
    const consume: CodexResetCreditRecoveryDependencies["consume"] = async ({
      operationId,
    }) => {
      consumeCalls += 1;
      seenOperationIds.push(operationId);
      return { code: "reset", operationId };
    };
    const firstCoordinator = makeCoordinator({
      revalidate,
      consume,
      onCapacitySaturated: () => undefined,
    });
    const secondCoordinator = makeCoordinator({
      revalidate,
      consume,
      onCapacitySaturated: () => undefined,
    });

    const firstTurn = firstCoordinator.createLogicalTurn();
    const secondTurn = secondCoordinator.createLogicalTurn();
    const first = recover(firstCoordinator, firstTurn);
    const second = recover(secondCoordinator, secondTurn);
    await started.promise;
    gate.resolve(eligible(BASE_GENERATION));

    expect(await Promise.all([first, second])).toEqual([
      { kind: "refresh-required", code: "reset" },
      { kind: "refresh-required", code: "reset" },
    ]);
    expect(revalidationCalls).toBe(1);
    expect(consumeCalls).toBe(1);
    expect(secondTurn.operationId).not.toBe(firstTurn.operationId);
    expect(seenOperationIds).toEqual([firstTurn.operationId]);
    expect(firstCoordinator.activeFlightCountForTests()).toBe(0);
    expect(firstCoordinator.terminalGenerationCountForTests()).toBe(1);
  });

  test("executes the contract snapshot when the dependencies object is mutated", async () => {
    const executedBy: string[] = [];
    const dependencies: CodexResetCreditRecoveryDependencies = {
      coordinationScope: Object.freeze({}),
      revalidate: async generation => {
        executedBy.push("original-revalidate");
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        executedBy.push("original-consume");
        return { code: "reset", operationId };
      },
    };
    const coordinator = new CodexResetCreditRecoveryCoordinator(dependencies);
    dependencies.revalidate = async generation => {
      executedBy.push("replacement-revalidate");
      return eligible(generation);
    };
    dependencies.consume = async ({ operationId }) => {
      executedBy.push("replacement-consume");
      return { code: "reset", operationId };
    };

    expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
      kind: "refresh-required",
      code: "reset",
    });
    expect(executedBy).toEqual(["original-revalidate", "original-consume"]);
  });

  test("rejects a mismatched coordinator contract instead of joining its flight", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    const started = deferred<void>();
    const executedBy: string[] = [];
    const revalidate = async () => {
      started.resolve();
      return await gate.promise;
    };
    const firstCoordinator = makeCoordinator({
      revalidate,
      consume: async ({ operationId }) => {
        executedBy.push("first");
        return { code: "reset", operationId };
      },
    });
    const secondCoordinator = makeCoordinator({
      revalidate,
      consume: async ({ operationId }) => {
        executedBy.push("second");
        return { code: "reset", operationId };
      },
    });

    const first = recover(firstCoordinator, firstCoordinator.createLogicalTurn());
    await started.promise;
    expect(await recover(
      secondCoordinator,
      secondCoordinator.createLogicalTurn(),
    )).toEqual({
      kind: "not-dispatched",
      reason: "coordination-mismatch",
    });
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({ kind: "refresh-required", code: "reset" });
    expect(executedBy).toEqual(["first"]);
  });

  test("rejects an active-flight join from a different coordination scope", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    const started = deferred<void>();
    let consumeCalls = 0;
    const revalidate = async () => {
      started.resolve();
      return await gate.promise;
    };
    const consume: CodexResetCreditRecoveryDependencies["consume"] = async ({
      operationId,
    }) => {
      consumeCalls += 1;
      return { code: "reset", operationId };
    };
    const owner = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });
    const joiner = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });

    const first = recover(owner, owner.createLogicalTurn());
    await started.promise;
    expect(await recover(joiner, joiner.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "coordination-mismatch",
    });
    gate.resolve(eligible(BASE_GENERATION));
    expect(await first).toEqual({ kind: "refresh-required", code: "reset" });
    expect(consumeCalls).toBe(1);
  });

  test("does not reuse a terminal outcome across coordination scopes", async () => {
    let consumeCalls = 0;
    const revalidate = async (generation: CodexResetCreditRecoveryGeneration) => (
      eligible(generation)
    );
    const consume: CodexResetCreditRecoveryDependencies["consume"] = async ({
      operationId,
    }) => {
      consumeCalls += 1;
      return { code: "reset", operationId };
    };
    const owner = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });
    const other = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });

    expect(await recover(owner, owner.createLogicalTurn())).toEqual({
      kind: "refresh-required",
      code: "reset",
    });
    expect(await recover(other, other.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "coordination-mismatch",
    });
    expect(consumeCalls).toBe(1);
  });

  test("checks terminal coordination before rejecting an older generation", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const revalidate = async (generation: CodexResetCreditRecoveryGeneration) => {
      revalidationCalls += 1;
      return eligible(generation);
    };
    const consume: CodexResetCreditRecoveryDependencies["consume"] = async ({
      operationId,
    }) => {
      consumeCalls += 1;
      return { code: "reset", operationId };
    };
    const owner = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });
    const other = makeCoordinator({
      coordinationScope: Object.freeze({}),
      revalidate,
      consume,
    });
    const newerGeneration = {
      ...BASE_GENERATION,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
    };

    expect(await recover(owner, owner.createLogicalTurn(), newerGeneration)).toEqual({
      kind: "refresh-required",
      code: "reset",
    });
    expect(await recover(other, other.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "coordination-mismatch",
    });
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 1,
      consumeCalls: 1,
    });
  });

  test("does not share flights across accounts or generation tuples", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    await Promise.all([
      recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION),
      recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId: "account-b",
      }),
      recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        credentialGeneration: BASE_GENERATION.credentialGeneration + 1,
      }),
      recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
      }),
    ]);

    expect(revalidationCalls).toBe(4);
    expect(consumeCalls).toBe(4);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
  });

  test("fails closed when process account-state capacity is exhausted", async () => {
    let consumeCalls = 0;
    const saturations: Array<{
      activeFlights: number;
      trackedAccounts: number;
    }> = [];
    const replacementSaturations: typeof saturations = [];
    const dependencies: CodexResetCreditRecoveryDependencies = {
      coordinationScope: DEFAULT_COORDINATION_SCOPE,
      revalidate: async generation => eligible(generation),
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
      onCapacitySaturated: capacity => saturations.push(capacity),
    };
    const coordinator = new CodexResetCreditRecoveryCoordinator(dependencies);
    dependencies.onCapacitySaturated = capacity => replacementSaturations.push(capacity);

    for (let index = 0; index < MAX_TRACKED_RECOVERY_ACCOUNTS; index += 1) {
      expect(await recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId: `capacity-${index}`,
      })).toEqual({ kind: "refresh-required", code: "reset" });
    }

    expect(await recover(coordinator, coordinator.createLogicalTurn(), {
      ...BASE_GENERATION,
      accountId: "capacity-overflow",
    })).toEqual({
      kind: "not-dispatched",
      reason: "recovery-state-capacity",
    });
    expect(consumeCalls).toBe(MAX_TRACKED_RECOVERY_ACCOUNTS);
    expect(coordinator.terminalGenerationCountForTests())
      .toBe(MAX_TRACKED_RECOVERY_ACCOUNTS);
    expect(saturations).toEqual([{
      activeFlights: 0,
      trackedAccounts: MAX_TRACKED_RECOVERY_ACCOUNTS,
    }]);
    expect(replacementSaturations).toEqual([]);
  });

  test("fails closed when process flight capacity is exhausted", async () => {
    const gate = deferred<void>();
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const saturations: Array<{
      activeFlights: number;
      trackedAccounts: number;
    }> = [];
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        await gate.promise;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
      onCapacitySaturated: capacity => saturations.push(capacity),
    });

    const pending = Array.from(
      { length: MAX_TRACKED_RECOVERY_FLIGHTS },
      (_, exhaustionGeneration) => recover(
      coordinator,
      coordinator.createLogicalTurn(),
      { ...BASE_GENERATION, exhaustionGeneration },
      ),
    );
    expect(await recover(coordinator, coordinator.createLogicalTurn(), {
      ...BASE_GENERATION,
      exhaustionGeneration: MAX_TRACKED_RECOVERY_FLIGHTS,
    })).toEqual({
      kind: "not-dispatched",
      reason: "recovery-state-capacity",
    });

    gate.resolve();
    await Promise.all(pending);
    expect(revalidationCalls).toBe(MAX_TRACKED_RECOVERY_FLIGHTS);
    expect(consumeCalls).toBe(MAX_TRACKED_RECOVERY_FLIGHTS);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(saturations).toEqual([{
      activeFlights: MAX_TRACKED_RECOVERY_FLIGHTS,
      trackedAccounts: 1,
    }]);
  });

  test("fails closed when one shared flight reaches waiter capacity", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let consumeCalls = 0;
    const saturations: Array<{
      activeFlights: number;
      trackedAccounts: number;
    }> = [];
    const coordinator = makeCoordinator({
      revalidate: async () => await gate.promise,
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
      onCapacitySaturated: capacity => saturations.push(capacity),
    });

    const pending = Array.from(
      { length: MAX_TRACKED_RECOVERY_WAITERS_PER_FLIGHT },
      () => recover(coordinator, coordinator.createLogicalTurn()),
    );
    expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "recovery-state-capacity",
    });

    gate.resolve(eligible(BASE_GENERATION));
    const results = await Promise.all(pending);
    expect(results.every(result => (
      result.kind === "refresh-required" && result.code === "reset"
    ))).toBe(true);
    expect(consumeCalls).toBe(1);
    expect(saturations).toEqual([{ activeFlights: 1, trackedAccounts: 1 }]);
  });

  test("counts timed-out orphan executions against flight capacity", async () => {
    const never = new Promise<never>(() => undefined);
    let revalidationCalls = 0;
    const saturations: Array<{
      activeFlights: number;
      trackedAccounts: number;
    }> = [];
    const coordinator = makeCoordinator({
      operationTimeoutMs: 5,
      revalidate: async () => {
        revalidationCalls += 1;
        return await never;
      },
      onCapacitySaturated: capacity => saturations.push(capacity),
    });

    const pending = Array.from(
      { length: MAX_TRACKED_RECOVERY_FLIGHTS },
      (_, index) => recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + index,
      }),
    );
    const results = await Promise.all(pending);
    expect(results.every(result => (
      result.kind === "not-dispatched"
        && result.reason === "operation-expired-before-dispatch"
    ))).toBe(true);
    expect(coordinator.activeFlightCountForTests()).toBe(0);

    expect(await recover(coordinator, coordinator.createLogicalTurn(), {
      ...BASE_GENERATION,
      exhaustionGeneration:
        BASE_GENERATION.exhaustionGeneration + MAX_TRACKED_RECOVERY_FLIGHTS,
    })).toEqual({
      kind: "not-dispatched",
      reason: "recovery-state-capacity",
    });
    expect(revalidationCalls).toBe(MAX_TRACKED_RECOVERY_FLIGHTS);
    expect(saturations).toEqual([{
      activeFlights: MAX_TRACKED_RECOVERY_FLIGHTS,
      trackedAccounts: 1,
    }]);
  });

  test("skips dispatch when every waiter cancels during revalidation", async () => {
    const started = deferred<void>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async (_generation, signal) => {
        started.resolve();
        return await new Promise<CodexResetCreditRevalidationResult>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    const first = recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION, {
      signal: firstAbort.signal,
    });
    const second = recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION, {
      signal: secondAbort.signal,
    });
    await started.promise;
    firstAbort.abort();
    secondAbort.abort();

    expect(await Promise.all([first, second])).toEqual([
      { kind: "not-dispatched", reason: "cancelled-before-dispatch" },
      { kind: "not-dispatched", reason: "cancelled-before-dispatch" },
    ]);
    await coordinator.waitForIdleForTests();
    expect(consumeCalls).toBe(0);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
  });

  test("rejects malformed request signals before creating a flight", async () => {
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    await expect(recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: {} as AbortSignal },
    )).rejects.toThrow("options.signal must be an AbortSignal");
    await Promise.resolve();

    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("rolls back a waiter when abort-listener registration throws", async () => {
    const request = new AbortController();
    const lifecycleTarget = new AbortController().signal;
    const lifecycleSignal = new Proxy(lifecycleTarget, {
      get: (target, property) => {
        return Reflect.get(target, property, target);
      },
    });
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      lifecycleSignal,
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    await expect(recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: request.signal },
    )).rejects.toBeInstanceOf(TypeError);
    await coordinator.waitForIdleForTests();

    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("uses intrinsic listener registration for validated request signals", async () => {
    const cancelled = new AbortController();
    Object.defineProperty(cancelled.signal, "addEventListener", {
      configurable: true,
      value: () => undefined,
    });
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: cancelled.signal },
    );
    cancelled.abort();

    expect(await pending).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    await coordinator.waitForIdleForTests();
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("skips revalidation when the last waiter cancels before the flight starts", async () => {
    const cancelled = new AbortController();
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: cancelled.signal },
    );
    cancelled.abort();

    expect(await pending).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    await coordinator.waitForIdleForTests();
    expect({ revalidationCalls, consumeCalls }).toEqual({
      revalidationCalls: 0,
      consumeCalls: 0,
    });
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("an already-cancelled request or lifecycle never creates a flight", async () => {
    let revalidationCalls = 0;
    const lifecycle = new AbortController();
    lifecycle.abort();
    const lifecycleCoordinator = makeCoordinator({
      lifecycleSignal: lifecycle.signal,
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
    });
    const requestCoordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        return eligible(generation);
      },
    });

    const lifecycleResult = await recover(
      lifecycleCoordinator,
      lifecycleCoordinator.createLogicalTurn(),
    );
    const requestResult = await recover(
      requestCoordinator,
      requestCoordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: AbortSignal.abort() },
    );

    expect(lifecycleResult).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(requestResult).toEqual(lifecycleResult);
    expect(revalidationCalls).toBe(0);
    expect(requestCoordinator.activeFlightCountForTests()).toBe(0);
  });

  test("one cancelled waiter does not cancel the shared flight for a live waiter", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    const started = deferred<void>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async () => {
        started.resolve();
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const cancelled = new AbortController();

    const first = recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION, {
      signal: cancelled.signal,
    });
    const second = recover(coordinator, coordinator.createLogicalTurn());
    await started.promise;
    cancelled.abort();
    gate.resolve(eligible(BASE_GENERATION));

    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(await second).toEqual({ kind: "refresh-required", code: "reset" });
    expect(consumeCalls).toBe(1);
  });

  test("a post-dispatch cancellation reports the outcome but cannot authorize replay", async () => {
    const consumeStarted = deferred<void>();
    const consumeGate = deferred<void>();
    const cancelled = new AbortController();
    const coordinator = makeCoordinator({
      consume: async ({ operationId }) => {
        consumeStarted.resolve();
        await consumeGate.promise;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION, {
      signal: cancelled.signal,
    });
    await consumeStarted.promise;
    cancelled.abort();
    consumeGate.resolve();

    expect(await pending).toEqual({
      kind: "detached",
      reason: "cancelled-after-dispatch",
      outcome: { kind: "refresh-required", code: "reset" },
    });
  });

  test("output committed after dispatch detaches the waiter from replay", async () => {
    const consumeStarted = deferred<void>();
    const consumeGate = deferred<void>();
    let outputExposed = false;
    const coordinator = makeCoordinator({
      consume: async ({ operationId }) => {
        consumeStarted.resolve();
        await consumeGate.promise;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: () => outputExposed },
    );
    await consumeStarted.promise;
    outputExposed = true;
    consumeGate.resolve();

    expect(await pending).toEqual({
      kind: "detached",
      reason: "output-exposed-after-dispatch",
      outcome: { kind: "refresh-required", code: "reset" },
    });
  });

  test("observes an abort fired re-entrantly by the completion guard", async () => {
    const consumeStarted = deferred<void>();
    const consumeGate = deferred<void>();
    const cancelled = new AbortController();
    let guardCalls = 0;
    let completionGuardArmed = false;
    const coordinator = makeCoordinator({
      consume: async ({ operationId }) => {
        consumeStarted.resolve();
        await consumeGate.promise;
        completionGuardArmed = true;
        return { code: "reset", operationId };
      },
    });
    const pending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: cancelled.signal },
      {
        ...AUTHORIZATION,
        isOutputExposed: () => {
          guardCalls += 1;
          if (completionGuardArmed) cancelled.abort();
          return false;
        },
      },
    );

    await consumeStarted.promise;
    consumeGate.resolve();

    expect(await pending).toEqual({
      kind: "detached",
      reason: "cancelled-after-dispatch",
      outcome: { kind: "refresh-required", code: "reset" },
    });
    expect(guardCalls).toBe(3);
  });

  test("caps a retiring pre-dispatch flight until its abort settles", async () => {
    const firstStarted = deferred<void>();
    const never = deferred<unknown>();
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async generation => {
        revalidationCalls += 1;
        if (revalidationCalls === 1) {
          firstStarted.resolve();
          return await never.promise;
        }
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const cancelled = new AbortController();

    const first = recover(coordinator, coordinator.createLogicalTurn(), BASE_GENERATION, {
      signal: cancelled.signal,
    });
    await firstStarted.promise;
    cancelled.abort();
    expect(await first).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });

    const second = await recover(coordinator, coordinator.createLogicalTurn());
    expect(second).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });
    expect(revalidationCalls).toBe(1);
    expect(consumeCalls).toBe(0);
    never.resolve(eligible(BASE_GENERATION));
    await coordinator.waitForIdleForTests();
    const third = await recover(coordinator, coordinator.createLogicalTurn());
    expect(third).toEqual({ kind: "refresh-required", code: "reset" });
    expect(revalidationCalls).toBe(2);
    expect(consumeCalls).toBe(1);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
  });

  test("test reset settles an active flight and suppresses late terminal state", async () => {
    const revalidationStarted = deferred<void>();
    const revalidationSettled = deferred<void>();
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 60_000,
      revalidate: async () => {
        revalidationStarted.resolve();
        try {
          return await gate.promise;
        } finally {
          revalidationSettled.resolve();
        }
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    const pending = recover(coordinator, coordinator.createLogicalTurn());
    await revalidationStarted.promise;
    const resetPending = resetCodexResetCreditRecoveryProcessStateForTests();
    expect(await pending).toEqual({
      kind: "not-dispatched",
      reason: "cancelled-before-dispatch",
    });

    gate.resolve(eligible(BASE_GENERATION));
    await revalidationSettled.promise;
    await resetPending;
    expect(consumeCalls).toBe(0);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("refuses process-state reset without the repository test preload", async () => {
    const originalGuard = process.env.OCX_TEST_HOME_GUARD;
    process.env.OCX_TEST_HOME_GUARD = "0";
    try {
      await expect(resetCodexResetCreditRecoveryProcessStateForTests()).rejects.toThrow(
        "resetProcessStateForTests is available only under the repository test preload",
      );
    } finally {
      if (originalGuard === undefined) delete process.env.OCX_TEST_HOME_GUARD;
      else process.env.OCX_TEST_HOME_GUARD = originalGuard;
    }
  });

  test("does not dispatch after synchronous revalidation outlives the deadline", async () => {
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 5,
      revalidate: async generation => {
        Bun.sleepSync(25);
        return eligible(generation);
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "operation-expired-before-dispatch",
    });
    expect(consumeCalls).toBe(0);
  });

  test("reports expiry when synchronous revalidation fails after the deadline", async () => {
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 5,
      revalidate: async () => {
        Bun.sleepSync(25);
        throw new Error("late revalidation failure");
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "operation-expired-before-dispatch",
    });
    expect(consumeCalls).toBe(0);
  });

  test("does not accept a synchronous consume result returned after the deadline", async () => {
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 5,
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        Bun.sleepSync(25);
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();

    expect(await recover(coordinator, turn)).toEqual({
      kind: "ambiguous",
      reason: "consume-timeout",
      operationId: turn.operationId,
    });
    expect(consumeCalls).toBe(1);
  });

  test("expires an abort-ignoring revalidation without dispatch", async () => {
    const never = deferred<unknown>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 25,
      revalidate: async generation => (
        generation.accountId === BASE_GENERATION.accountId
          ? await never.promise
          : eligible(generation)
      ),
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    try {
      expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
        kind: "not-dispatched",
        reason: "operation-expired-before-dispatch",
      });
      expect(coordinator.activeFlightCountForTests()).toBe(0);
      expect(await recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId: "account-b",
      })).toEqual({ kind: "refresh-required", code: "reset" });
      expect(consumeCalls).toBe(1);
    } finally {
      // Settle only after proving the pending adapter no longer consumes active
      // capacity, so test cleanup cannot mask the regression.
      never.resolve(eligible(BASE_GENERATION));
      await coordinator.waitForIdleForTests();
    }
  });

  test("test reset detaches an abort-ignoring orphan execution", async () => {
    const never = deferred<unknown>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 25,
      revalidate: async () => await never.promise,
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    expect(await recover(coordinator, coordinator.createLogicalTurn())).toEqual({
      kind: "not-dispatched",
      reason: "operation-expired-before-dispatch",
    });
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    await resetCodexResetCreditRecoveryProcessStateForTests();
    expect(consumeCalls).toBe(0);
    expect(coordinator.activeFlightCountForTests()).toBe(0);
    expect(coordinator.terminalGenerationCountForTests()).toBe(0);
  });

  test("quarantines a timed-out consume result for the same generation", async () => {
    const never = deferred<unknown>();
    const consumeStarted = deferred<void>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 25,
      consume: async () => {
        consumeCalls += 1;
        consumeStarted.resolve();
        return await never.promise;
      },
    });

    const firstTurn = coordinator.createLogicalTurn();
    const firstPending = recover(coordinator, firstTurn);
    await consumeStarted.promise;
    const first = await firstPending;
    const secondTurn = coordinator.createLogicalTurn();
    const second = await recover(coordinator, secondTurn);

    expect(first).toEqual({
      kind: "ambiguous",
      reason: "consume-timeout",
      operationId: firstTurn.operationId,
    });
    expect(second).toEqual(first);
    expect(secondTurn.operationId).not.toBe(firstTurn.operationId);
    expect(consumeCalls).toBe(1);
    expect(coordinator.terminalGenerationCountForTests()).toBe(1);
    never.resolve(undefined);
    await coordinator.waitForIdleForTests();
  });

  test("does not launch a late retry after the operation deadline", async () => {
    const firstAttempt = deferred<unknown>();
    const consumeStarted = deferred<void>();
    const firstAttemptSettled = deferred<void>();
    let consumeCalls = 0;
    let operationSignal: AbortSignal | undefined;
    const coordinator = makeCoordinator({
      operationTimeoutMs: 25,
      maxConsumeAttempts: 2,
      consume: async ({ signal }) => {
        consumeCalls += 1;
        operationSignal = signal;
        consumeStarted.resolve();
        try {
          return await firstAttempt.promise;
        } finally {
          firstAttemptSettled.resolve();
        }
      },
    });

    const pending = recover(coordinator, coordinator.createLogicalTurn());
    await consumeStarted.promise;
    expect(await pending).toMatchObject({
      kind: "ambiguous",
      reason: "consume-timeout",
    });
    expect(operationSignal?.aborted).toBe(true);
    firstAttempt.reject(new Error("late transport rejection"));
    await firstAttemptSettled.promise;
    await coordinator.waitForIdleForTests();
    expect(consumeCalls).toBe(1);
  });

  test("bounded consume retries reuse one operation identity", async () => {
    const seenOperationIds: string[] = [];
    const coordinator = makeCoordinator({
      maxConsumeAttempts: 2,
      consume: async ({ operationId }) => {
        seenOperationIds.push(operationId);
        if (seenOperationIds.length === 1) throw new Error("lost response");
        return { code: "already_redeemed", operationId };
      },
    });

    const turn = coordinator.createLogicalTurn();
    expect(await recover(coordinator, turn)).toEqual({
      kind: "refresh-required",
      code: "already_redeemed",
    });
    expect(seenOperationIds).toEqual([turn.operationId, turn.operationId]);
  });

  test.each([
    ["reset", { kind: "refresh-required", code: "reset" }],
    ["already_redeemed", { kind: "refresh-required", code: "already_redeemed" }],
    ["nothing_to_reset", { kind: "stopped", code: "nothing_to_reset" }],
    ["no_credit", { kind: "stopped", code: "no_credit" }],
  ] as const)("maps the exact %s consume outcome", async (code, expected) => {
    const coordinator = makeCoordinator({
      consume: async ({ operationId }) => ({ code, operationId }),
    });
    expect(await recover(coordinator, coordinator.createLogicalTurn(), {
      ...BASE_GENERATION,
      accountId: `outcome-${code.replaceAll("_", "-")}`,
    })).toEqual(expected);
  });

  test("fails closed for inherited, unknown, or mismatched consume outcomes", async () => {
    const cases = ["inherited", "unknown", "mismatched"] as const;

    for (const [index, kind] of cases.entries()) {
      const coordinator = makeCoordinator({
        consume: async ({ operationId }) => {
          if (kind === "inherited") {
            return Object.create({ code: "reset", operationId });
          }
          if (kind === "unknown") return { code: "unexpected", operationId };
          return { code: "reset", operationId: DIFFERENT_OPERATION_ID };
        },
      });
      const turn = coordinator.createLogicalTurn();
      const result = await recover(coordinator, turn, {
        ...BASE_GENERATION,
        accountId: `invalid-outcome-${index}`,
      });
      expect(result).toEqual({
        kind: "ambiguous",
        reason: "invalid-outcome",
        operationId: turn.operationId,
      });
    }
  });

  test("malformed or failed revalidation never dispatches consume", async () => {
    let consumeCalls = 0;
    const revalidations: Array<() => Promise<unknown>> = [
      async () => undefined,
      async () => ({ kind: "unknown" }),
      async () => { throw new Error("offline"); },
    ];

    for (const [index, revalidate] of revalidations.entries()) {
      const coordinator = makeCoordinator({
        revalidate,
        consume: async ({ operationId }) => {
          consumeCalls += 1;
          return { code: "reset", operationId };
        },
      });
      const result = await recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId: `invalid-revalidation-${index}`,
      });
      expect(result).toEqual({
        kind: "not-dispatched",
        reason: index === 2 ? "revalidation-failed" : "invalid-revalidation",
      });
    }
    expect(consumeCalls).toBe(0);
  });

  test("requires an own, generation-bound, positive-credit revalidation", async () => {
    let consumeCalls = 0;
    const cases: Array<(generation: CodexResetCreditRecoveryGeneration) => unknown> = [
      generation => Object.assign(Object.create({
        accountId: generation.accountId,
        credentialGeneration: generation.credentialGeneration,
        exhaustionGeneration: generation.exhaustionGeneration,
        availableCredits: 1,
      }), { kind: "eligible" }),
      generation => eligible({
        ...generation,
        exhaustionGeneration: generation.exhaustionGeneration + 1,
      }),
      generation => eligible(generation, 0),
    ];

    for (const [index, makeRevalidation] of cases.entries()) {
      const generation = {
        ...BASE_GENERATION,
        accountId: `strict-revalidation-${index}`,
      };
      const coordinator = makeCoordinator({
        revalidate: async () => makeRevalidation(generation),
        consume: async ({ operationId }) => {
          consumeCalls += 1;
          return { code: "reset", operationId };
        },
      });
      expect(await recover(
        coordinator,
        coordinator.createLogicalTurn(),
        generation,
      )).toEqual({
        kind: "not-dispatched",
        reason: "invalid-revalidation",
      });
    }
    expect(consumeCalls).toBe(0);
  });

  test("retains an ambiguous terminal fence for later logical turns", async () => {
    let consumeCalls = 0;
    const ambiguous = makeCoordinator({
      maxConsumeAttempts: 2,
      consume: async () => {
        consumeCalls += 1;
        throw new Error("response lost");
      },
    });

    const firstTurn = ambiguous.createLogicalTurn();
    const first = await recover(ambiguous, firstTurn);
    const secondTurn = ambiguous.createLogicalTurn();
    const second = await recover(ambiguous, secondTurn);

    expect(first).toEqual({
      kind: "ambiguous",
      reason: "consume-failed",
      operationId: firstTurn.operationId,
    });
    expect(second).toEqual(first);
    expect(secondTurn.operationId).not.toBe(firstTurn.operationId);
    expect(consumeCalls).toBe(2);
  });

  test("retains a confirmed terminal fence for later logical turns", async () => {
    let confirmedCalls = 0;
    const confirmed = makeCoordinator({
      consume: async ({ operationId }) => {
        confirmedCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const confirmedFirst = await recover(confirmed, confirmed.createLogicalTurn());
    const confirmedSecond = await recover(confirmed, confirmed.createLogicalTurn());
    expect(confirmedSecond).toEqual(confirmedFirst);
    expect(confirmedCalls).toBe(1);
  });

  test("detaches a cached terminal outcome when output commits or the caller cancels", async () => {
    const coordinator = makeCoordinator();
    const outcome = await recover(coordinator, coordinator.createLogicalTurn());
    expect(outcome).toEqual({ kind: "refresh-required", code: "reset" });

    let outputExposed = false;
    const exposedPending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      {},
      { ...AUTHORIZATION, isOutputExposed: () => outputExposed },
    );
    outputExposed = true;
    expect(await exposedPending).toEqual({
      kind: "detached",
      reason: "output-exposed-after-dispatch",
      outcome,
    });

    const controller = new AbortController();
    const cancelledPending = recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: controller.signal },
    );
    controller.abort();
    expect(await cancelledPending).toEqual({
      kind: "detached",
      reason: "cancelled-after-dispatch",
      outcome,
    });

    const reentrantController = new AbortController();
    let guardCalls = 0;
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      BASE_GENERATION,
      { signal: reentrantController.signal },
      {
        ...AUTHORIZATION,
        isOutputExposed: () => {
          guardCalls += 1;
          if (guardCalls === 2) reentrantController.abort();
          return false;
        },
      },
    )).toEqual({
      kind: "detached",
      reason: "cancelled-after-dispatch",
      outcome,
    });
    expect(guardCalls).toBe(2);
  });

  test("keeps a monotonic account fence when generations finish out of order", async () => {
    const older = BASE_GENERATION;
    const newer = {
      ...BASE_GENERATION,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
    };
    const olderStarted = deferred<void>();
    const newerStarted = deferred<void>();
    const olderGate = deferred<void>();
    const newerGate = deferred<void>();
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      consume: async ({ generation, operationId }) => {
        consumeCalls += 1;
        if (generation.exhaustionGeneration === older.exhaustionGeneration) {
          olderStarted.resolve();
          await olderGate.promise;
        } else {
          newerStarted.resolve();
          await newerGate.promise;
        }
        return { code: "reset", operationId };
      },
    });

    const olderPending = recover(coordinator, coordinator.createLogicalTurn(), older);
    const newerPending = recover(coordinator, coordinator.createLogicalTurn(), newer);
    await Promise.all([olderStarted.promise, newerStarted.promise]);
    newerGate.resolve();
    expect(await newerPending).toEqual({ kind: "refresh-required", code: "reset" });
    olderGate.resolve();
    expect(await olderPending).toEqual({ kind: "refresh-required", code: "reset" });

    expect(coordinator.terminalGenerationCountForTests()).toBe(1);
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      newer,
    )).toEqual({ kind: "refresh-required", code: "reset" });
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      older,
    )).toEqual({ kind: "not-dispatched", reason: "stale-generation" });
    expect(consumeCalls).toBe(2);
  });

  test("a newer credential generation supersedes its prior exhaustion counter", async () => {
    const olderCredential = {
      ...BASE_GENERATION,
      exhaustionGeneration: 999,
    };
    const newerCredential = {
      ...BASE_GENERATION,
      credentialGeneration: BASE_GENERATION.credentialGeneration + 1,
      exhaustionGeneration: 0,
    };
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });

    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      olderCredential,
    )).toEqual({ kind: "refresh-required", code: "reset" });
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      newerCredential,
    )).toEqual({ kind: "refresh-required", code: "reset" });
    expect(await recover(
      coordinator,
      coordinator.createLogicalTurn(),
      olderCredential,
    )).toEqual({ kind: "not-dispatched", reason: "stale-generation" });
    expect(consumeCalls).toBe(2);
    expect(coordinator.terminalGenerationCountForTests()).toBe(1);
  });

  test("a concurrent re-entry of one turn cannot consume a second generation", async () => {
    const gate = deferred<CodexResetCreditRevalidationResult>();
    let revalidationCalls = 0;
    let consumeCalls = 0;
    const coordinator = makeCoordinator({
      revalidate: async () => {
        revalidationCalls += 1;
        return await gate.promise;
      },
      consume: async ({ operationId }) => {
        consumeCalls += 1;
        return { code: "reset", operationId };
      },
    });
    const turn = coordinator.createLogicalTurn();

    const first = recover(coordinator, turn);
    const second = recover(coordinator, turn, {
      ...BASE_GENERATION,
      exhaustionGeneration: BASE_GENERATION.exhaustionGeneration + 1,
    });
    expect(second).toBe(first);
    gate.resolve(eligible(BASE_GENERATION));
    await Promise.all([first, second]);

    expect(revalidationCalls).toBe(1);
    expect(consumeCalls).toBe(1);
  });

  test("cleans active flights after every terminal class", async () => {
    const cases: Array<{
      label: string;
      revalidate?: CodexResetCreditRecoveryDependencies["revalidate"];
      consume?: CodexResetCreditRecoveryDependencies["consume"];
    }> = [
      { label: "confirmed" },
      { label: "stale", revalidate: async () => ({ kind: "stale-generation" }) },
      { label: "no credit", revalidate: async () => ({ kind: "no-credit" }) },
      { label: "revalidation failure", revalidate: async () => { throw new Error("offline"); } },
      { label: "consume failure", consume: async () => { throw new Error("lost"); } },
      {
        label: "invalid outcome",
        consume: async ({ operationId }) => ({ code: "other", operationId }),
      },
    ];

    for (const [index, entry] of cases.entries()) {
      const coordinator = makeCoordinator({
        ...(entry.revalidate ? { revalidate: entry.revalidate } : {}),
        ...(entry.consume ? { consume: entry.consume } : {}),
      });
      await recover(coordinator, coordinator.createLogicalTurn(), {
        ...BASE_GENERATION,
        accountId: `cleanup-${index}`,
      });
      expect(coordinator.activeFlightCountForTests(), entry.label).toBe(0);
    }
  });
});
