import type { IntegrationClientId } from "./registry";

const INTEGRATION_MUTATION_JOIN_MS = 120_000;
export const INTEGRATION_MUTATION_TERMINAL_MS = 10 * 60_000;

interface IntegrationMutationFlight {
  key: string;
  startedAt: number;
  promise: Promise<unknown>;
}

export class IntegrationMutationBusyError extends Error {
  constructor(readonly clientId: IntegrationClientId) {
    super("integration_mutation_busy");
  }
}

const integrationMutationFlights = new Map<IntegrationClientId, IntegrationMutationFlight>();
let integrationMutationRunTestHook: ((operation: () => Promise<unknown>) => Promise<unknown>) | null = null;

/**
 * One in-process flight per client, shared by explicit HTTP mutations and
 * implicit catalog refreshes. Equal operations join; different semantics are
 * busy instead of, for example, letting an explicit apply join a refresh-only
 * no-op for an absent block.
 */
export function runIntegrationMutationFlight<T>(
  clientId: IntegrationClientId,
  key: string,
  now: () => number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = now();
  const current = integrationMutationFlights.get(clientId);
  if (current) {
    const age = startedAt - current.startedAt;
    if (current.key === key && age < INTEGRATION_MUTATION_JOIN_MS) {
      return current.promise as Promise<T>;
    }
    if (age <= INTEGRATION_MUTATION_TERMINAL_MS) {
      return Promise.reject(new IntegrationMutationBusyError(clientId));
    }
    if (integrationMutationFlights.get(clientId) === current) {
      integrationMutationFlights.delete(clientId);
    }
  }

  const flight: IntegrationMutationFlight = {
    key,
    startedAt,
    promise: Promise.resolve(),
  };
  const run = async (): Promise<unknown> => operation();
  flight.promise = (integrationMutationRunTestHook
    ? integrationMutationRunTestHook(run)
    : run()
  ).finally(() => {
    if (integrationMutationFlights.get(clientId) === flight) {
      integrationMutationFlights.delete(clientId);
    }
  });
  integrationMutationFlights.set(clientId, flight);
  return flight.promise as Promise<T>;
}

export function setIntegrationMutationFlightTestHook(
  run: ((operation: () => Promise<unknown>) => Promise<unknown>) | null,
): void {
  integrationMutationRunTestHook = run;
  integrationMutationFlights.clear();
}
