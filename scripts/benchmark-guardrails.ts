import {
  createBuiltinGuardrailsRegistry,
  createGuardrailsRegistry,
} from "../src/guardrails/registry";
import {
  createGuardrailsDemaskSession,
  createGuardrailsMaskSession,
} from "../src/guardrails/placeholders";
import {
  GuardrailsScanCapacityError,
  MAX_GUARDRAILS_REGEX_INPUT_BYTES,
  createGuardrailsScanBudget,
  scanGuardrailsText,
  type GuardrailsScanBudget,
} from "../src/guardrails/scanner";
import type {
  GuardrailsCustomRule,
  GuardrailsPlaceholderState,
  GuardrailsRegistry,
} from "../src/guardrails/types";

const LARGE_TURN_BYTES = 2 * 1024 * 1024;
const LARGE_LEAF_BYTES = 128 * 1024;
const MAX_CUSTOM_RULES = 100;
const TYPICAL_ITERATIONS = 50;
const MANY_FIELD_COUNT = 1_000;
const DEMASK_EVENT_COUNT = 1_000;

interface Measurement {
  iterations: number;
  maxMs: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index]!;
}

function measure(iterations: number, operation: () => void): Measurement {
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const startedAt = performance.now();
    operation();
    samples.push(performance.now() - startedAt);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  return {
    iterations,
    minMs: sorted[0]!,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1)!,
    meanMs: total / samples.length,
  };
}

function benchmarkCustomRules(
  generation: "old" | "new",
  keywordPrefilterFixture = false,
): GuardrailsCustomRule[] {
  return Array.from({ length: MAX_CUSTOM_RULES }, (_, index) => {
    const sequence = String(index + 1).padStart(3, "0");
    return {
      ruleId: `benchmark.${generation}.rule-${sequence}`,
      name: `benchmark.${generation}.rule-${sequence}`,
      dataType: 6,
      group: "BENCHMARK",
      groupPriority: 0,
      displayName: `Benchmark rule ${sequence}`,
      description: "Synthetic no-keyword rule for the bounded Guardrails benchmark",
      regex: `OCX_BENCHMARK_${generation.toUpperCase()}_${sequence}_[A-Z]{16}`,
      keywords: keywordPrefilterFixture ? ["ocx_benchmark_never"] : [],
      banlist: [],
      validators: [],
      masking: {
        captureGroups: [],
        placeholderType: `BENCHMARK_${generation.toUpperCase()}_${sequence}`,
      },
    };
  });
}

function compileRegistry(
  customRules: readonly GuardrailsCustomRule[] = [],
  keywordPrefilterEnabled = false,
): {
  compileMs: number;
  registry: GuardrailsRegistry;
} {
  const startedAt = performance.now();
  const registry = customRules.length === 0
    ? createBuiltinGuardrailsRegistry()
    : createGuardrailsRegistry({ customRules, keywordPrefilterEnabled });
  return { compileMs: performance.now() - startedAt, registry };
}

function scanNoFindings(
  registry: GuardrailsRegistry,
  text: string,
  budget?: GuardrailsScanBudget,
): void {
  const findings = scanGuardrailsText(registry, text, budget);
  assert(findings.length === 0, `benchmark fixture unexpectedly produced ${findings.length} finding(s)`);
}

function scanLargeTurn(
  registry: GuardrailsRegistry,
  leaf: string,
  leaves = LARGE_TURN_BYTES / LARGE_LEAF_BYTES,
): void {
  const budget = createGuardrailsScanBudget();
  for (let index = 0; index < leaves; index += 1) {
    scanNoFindings(registry, leaf, budget);
  }
}

function executableRuleCount(registry: GuardrailsRegistry, text: string): number {
  if (!registry.keywordPrefilterEnabled) return registry.rules.length;
  const folded = text.toLowerCase();
  return registry.rules.reduce(
    (count, rule) => count + (
      rule.prefilterKeywords.length === 0
      || rule.prefilterKeywords.some(keyword => folded.includes(keyword))
        ? 1
        : 0
    ),
    0,
  );
}

function admittedLargeTurnLeaves(registry: GuardrailsRegistry, leaf: string): number {
  const inputBytes = Buffer.byteLength(leaf, "utf8");
  const rules = executableRuleCount(registry, leaf);
  assert(rules > 0, "prefiltered benchmark must execute at least one rule");
  const capacityLeaves = Math.floor(MAX_GUARDRAILS_REGEX_INPUT_BYTES / (inputBytes * rules));
  return Math.min(LARGE_TURN_BYTES / LARGE_LEAF_BYTES, capacityLeaves);
}

function measureExpectedCapacityRejection(registry: GuardrailsRegistry, leaf: string): number {
  const startedAt = performance.now();
  try {
    scanLargeTurn(registry, leaf);
  } catch (error) {
    assert(error instanceof GuardrailsScanCapacityError, "large no-prefilter turn must fail with a capacity error");
    return performance.now() - startedAt;
  }
  throw new Error("large no-prefilter turn unexpectedly passed its regex work budget");
}

function explicitWorstBudget(): number | undefined {
  const raw = process.argv.find(argument => argument.startsWith("--max-worst-ms="))?.split("=")[1];
  if (raw === undefined) return undefined;
  const budget = Number(raw);
  assert(Number.isFinite(budget) && budget > 0, "--max-worst-ms must be a positive number");
  return budget;
}

function measureManyFieldMasking(): Measurement {
  const texts = Array.from(
    { length: MANY_FIELD_COUNT },
    (_, index) => `synthetic-sensitive-value-${String(index).padStart(4, "0")}`,
  );
  return measure(5, () => {
    const session = createGuardrailsMaskSession(undefined, texts);
    for (const text of texts) {
      const masked = session.mask(text, [{
        ruleId: "benchmark.secret",
        dataType: 1,
        placeholderType: "BENCHMARK_SECRET",
        start: 0,
        end: text.length,
        value: text,
      }]);
      assert(masked.startsWith("<BENCHMARK_SECRET_"), "many-field masking returned an invalid placeholder");
    }
    assert(session.finish().replacements.length === MANY_FIELD_COUNT, "many-field masking lost placeholder mappings");
  });
}

function measureManyEventDemasking(): Measurement {
  const state: GuardrailsPlaceholderState = {
    replacements: Array.from({ length: MANY_FIELD_COUNT }, (_, index) => ({
      ruleId: "benchmark.secret",
      dataType: 1,
      original: `secret-${index}`,
      placeholder: `<BENCHMARK_SECRET_${index + 1}>`,
      placeholderType: "BENCHMARK_SECRET",
    })),
    reservedPlaceholders: [],
  };
  return measure(5, () => {
    const session = createGuardrailsDemaskSession(state);
    for (let index = 0; index < DEMASK_EVENT_COUNT; index += 1) {
      const mappingIndex = index % MANY_FIELD_COUNT;
      const restored = session.demask(`<BENCHMARK_SECRET_${mappingIndex + 1}>`);
      assert(restored === `secret-${mappingIndex}`, "many-event demasking restored an invalid value");
    }
  });
}

function main(): void {
  const typicalText = "Summarize the release notes and list the next three review steps.";
  const largeLeaf = "x".repeat(LARGE_LEAF_BYTES);
  assert(Buffer.byteLength(largeLeaf, "utf8") === LARGE_LEAF_BYTES, "large benchmark leaf must be exactly 128 KiB");

  const builtin = compileRegistry();
  let typical: Measurement;
  let builtinMaxLeaf: Measurement;
  const manyFieldMasking = measureManyFieldMasking();
  const manyEventDemasking = measureManyEventDemasking();
  const builtinRuleCount = builtin.registry.rules.length;
  try {
    assert(builtinRuleCount === 272, "built-in benchmark registry must contain 272 rules");
    scanNoFindings(builtin.registry, typicalText);
    typical = measure(TYPICAL_ITERATIONS, () => scanNoFindings(builtin.registry, typicalText));
    builtinMaxLeaf = measure(1, () => scanNoFindings(builtin.registry, largeLeaf));
  } finally {
    builtin.registry.dispose();
  }

  const old = compileRegistry(benchmarkCustomRules("old"));
  const worst = compileRegistry(benchmarkCustomRules("new"));
  const worstRuleCount = worst.registry.rules.length;
  const fullRegistryRuleCount = builtinRuleCount + MAX_CUSTOM_RULES;
  let noPrefilterMaxLeaf: Measurement;
  let overBudgetLargeTurnRejectedMs: number;
  try {
    assert(
      old.registry.rules.length === fullRegistryRuleCount,
      `old atomic-swap registry must contain ${fullRegistryRuleCount} rules`,
    );
    assert(
      worstRuleCount === fullRegistryRuleCount,
      `worst benchmark registry must contain ${fullRegistryRuleCount} rules`,
    );
    noPrefilterMaxLeaf = measure(1, () => scanNoFindings(worst.registry, largeLeaf));
    overBudgetLargeTurnRejectedMs = measureExpectedCapacityRejection(worst.registry, largeLeaf);
  } finally {
    old.registry.dispose();
    worst.registry.dispose();
  }

  const filteredOld = compileRegistry(benchmarkCustomRules("old", true), true);
  const filtered = compileRegistry(benchmarkCustomRules("new", true), true);
  let prefilteredLargeTurn: Measurement;
  try {
    assert(
      filteredOld.registry.rules.length === fullRegistryRuleCount,
      `old prefiltered registry must contain ${fullRegistryRuleCount} rules`,
    );
    assert(
      filtered.registry.rules.length === fullRegistryRuleCount,
      `new prefiltered registry must contain ${fullRegistryRuleCount} rules`,
    );
    const prefilteredLeaves = admittedLargeTurnLeaves(filtered.registry, largeLeaf);
    assert(prefilteredLeaves > 0, "prefiltered benchmark must admit at least one maximum-size leaf");
    prefilteredLargeTurn = measure(1, () =>
      scanLargeTurn(filtered.registry, largeLeaf, prefilteredLeaves));
    const budget = explicitWorstBudget();
    const measuredWorstMs = Math.max(noPrefilterMaxLeaf.maxMs, prefilteredLargeTurn.maxMs);
    if (budget !== undefined) {
      assert(
        measuredWorstMs <= budget,
        `worst admitted registry scan took ${measuredWorstMs.toFixed(2)} ms, above ${budget} ms`,
      );
    }
    console.log(JSON.stringify({
      environment: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      fixtures: {
        typicalBytes: Buffer.byteLength(typicalText, "utf8"),
        requestedLargeTurnBytes: LARGE_TURN_BYTES,
        largeLeafBytes: LARGE_LEAF_BYTES,
        requestedLargeTurnLeaves: LARGE_TURN_BYTES / LARGE_LEAF_BYTES,
        prefilteredLargeTurnBytes: prefilteredLeaves * LARGE_LEAF_BYTES,
        prefilteredLargeTurnLeaves: prefilteredLeaves,
        prefilteredExecutableRules: executableRuleCount(filtered.registry, largeLeaf),
        builtinRules: builtinRuleCount,
        maximumCustomRules: MAX_CUSTOM_RULES,
        manyFieldCount: MANY_FIELD_COUNT,
        demaskEventCount: DEMASK_EVENT_COUNT,
        worstEffectiveRules: worstRuleCount,
        atomicSwapResidentRules: filteredOld.registry.rules.length + filtered.registry.rules.length,
      },
      compilation: {
        builtinMs: builtin.compileMs,
        oldEffectiveMs: old.compileMs,
        worstEffectiveMs: worst.compileMs,
        oldPrefilteredMs: filteredOld.compileMs,
        newPrefilteredMs: filtered.compileMs,
      },
      scans: {
        typical,
        builtinMaxLeaf,
        noPrefilterMaxLeaf,
        overBudgetLargeTurnRejectedMs,
        prefilteredLargeTurn,
        manyFieldMasking,
        manyEventDemasking,
      },
      enforcedWorstBudgetMs: budget ?? null,
    }, null, 2));
  } finally {
    filteredOld.registry.dispose();
    filtered.registry.dispose();
  }
}

main();
