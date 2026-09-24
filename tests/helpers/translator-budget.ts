import { afterEach, onTestFinished } from "bun:test";
import type { IncomingMeta, ProviderAdapter } from "../../src/adapters/base";
import {
  createTranslatorBudget,
  resetTranslatorAggregateForTests,
  type TranslatorBudget,
} from "../../src/lib/translator-budget";

const liveTestBudgets = new Set<TranslatorBudget>();

function disposeTestTranslatorBudgets(): void {
  for (const budget of liveTestBudgets) budget.dispose();
  liveTestBudgets.clear();
  resetTranslatorAggregateForTests();
}

export function createTestTranslatorBudget(options?: Parameters<typeof createTranslatorBudget>[0]): TranslatorBudget {
  const budget = createTranslatorBudget(options);
  liveTestBudgets.add(budget);
  // The `afterEach` below only runs for the first test file that imports this module: a
  // shared Bun process evaluates it once, so every later importer keeps its budgets and the
  // aggregate for the rest of the run. `onTestFinished` belongs to the running test, whatever
  // file it is in. Outside a test (module scope, `beforeAll`) it throws, and the `afterEach`
  // stays the only cleanup.
  try {
    onTestFinished(disposeTestTranslatorBudgets);
  } catch {
    // Not inside a running test.
  }
  return budget;
}

afterEach(disposeTestTranslatorBudgets);

type TestAdapter<T extends ProviderAdapter> = Omit<T, "buildRequest" | "parseStream" | "parseResponse"> & {
  buildRequest(
    parsed: Parameters<T["buildRequest"]>[0],
    incoming?: Partial<IncomingMeta>,
  ): ReturnType<T["buildRequest"]>;
  parseStream(response: Response, budget?: TranslatorBudget): ReturnType<T["parseStream"]>;
  parseResponse?: (
    response: Response,
    budget?: TranslatorBudget,
  ) => ReturnType<NonNullable<T["parseResponse"]>>;
};

/** Keeps production budgets mandatory while adapting legacy direct adapter tests. */
export function withTestTranslatorBudget<T extends ProviderAdapter>(adapter: T): TestAdapter<T> {
  const budget = createTestTranslatorBudget();
  const buildRequest = adapter.buildRequest.bind(adapter);
  const parseStream = adapter.parseStream.bind(adapter);
  const parseResponse = adapter.parseResponse?.bind(adapter);
  return {
    ...adapter,
    buildRequest(parsed: Parameters<T["buildRequest"]>[0], incoming?: Partial<IncomingMeta>) {
      return buildRequest(parsed, {
        ...incoming,
        headers: incoming?.headers ?? new Headers(),
        translatorBudget: incoming?.translatorBudget ?? budget,
      });
    },
    parseStream(response: Response, explicitBudget?: TranslatorBudget) {
      return parseStream(response, explicitBudget ?? budget);
    },
    ...(parseResponse ? {
      parseResponse(response: Response, explicitBudget?: TranslatorBudget) {
        return parseResponse(response, explicitBudget ?? budget);
      },
    } : {}),
  } as unknown as TestAdapter<T>;
}
