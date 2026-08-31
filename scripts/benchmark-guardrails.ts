import {
  createBuiltinGuardrailsRegistry,
  createGuardrailsRegistry,
} from "../src/guardrails/registry";
import {
  GuardrailsScanCapacityError,
  createGuardrailsScanBudget,
  scanGuardrailsText,
  type GuardrailsScanBudget,
} from "../src/guardrails/scanner";
import type { GuardrailsCustomRule, GuardrailsRegistry } from "../src/guardrails/types";

const LARGE_TURN_BYTES = 2 * 1024 * 1024;
const LARGE_LEAF_BYTES = 128 * 1024;
const MAX_CUSTOM_RULES = 100;
const TYPICAL_ITERATIONS = 50;

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

function scanLargeTurn(registry: GuardrailsRegistry, leaf: string): void {
  const budget = createGuardrailsScanBudget();
  for (let index = 0; index < LARGE_TURN_BYTES / LARGE_LEAF_BYTES; index += 1) {
    scanNoFindings(registry, leaf, budget);
  }
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

function main(): void {
  const typicalText = "Summarize the release notes and list the next three review steps.";
  const largeLeaf = "x".repeat(LARGE_LEAF_BYTES);
  assert(Buffer.byteLength(largeLeaf, "utf8") === LARGE_LEAF_BYTES, "large benchmark leaf must be exactly 128 KiB");

  const builtin = compileRegistry();
  let typical: Measurement;
  let builtinMaxLeaf: Measurement;
  const builtinRuleCount = builtin.registry.rules.length;
  try {
    assert(builtinRuleCount === 271, "built-in benchmark registry must contain 271 rules");
    scanNoFindings(builtin.registry, typicalText);
    typical = measure(TYPICAL_ITERATIONS, () => scanNoFindings(builtin.registry, typicalText));
    builtinMaxLeaf = measure(1, () => scanNoFindings(builtin.registry, largeLeaf));
  } finally {
    builtin.registry.dispose();
  }

  const old = compileRegistry(benchmarkCustomRules("old"));
  const worst = compileRegistry(benchmarkCustomRules("new"));
  const worstRuleCount = worst.registry.rules.length;
  let noPrefilterMaxLeaf: Measurement;
  let overBudgetLargeTurnRejectedMs: number;
  try {
    assert(old.registry.rules.length === 371, "old atomic-swap registry must contain 371 rules");
    assert(worstRuleCount === 371, "worst benchmark registry must contain 371 rules");
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
    assert(filteredOld.registry.rules.length === 371, "old prefiltered registry must contain 371 rules");
    assert(filtered.registry.rules.length === 371, "new prefiltered registry must contain 371 rules");
    prefilteredLargeTurn = measure(1, () => scanLargeTurn(filtered.registry, largeLeaf));
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
        largeTurnBytes: LARGE_TURN_BYTES,
        largeLeafBytes: LARGE_LEAF_BYTES,
        largeTurnLeaves: LARGE_TURN_BYTES / LARGE_LEAF_BYTES,
        builtinRules: builtinRuleCount,
        maximumCustomRules: MAX_CUSTOM_RULES,
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
      },
      enforcedWorstBudgetMs: budget ?? null,
    }, null, 2));
  } finally {
    filteredOld.registry.dispose();
    filtered.registry.dispose();
  }
}

main();
