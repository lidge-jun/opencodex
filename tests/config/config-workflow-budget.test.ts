import { describe, expect, spyOn, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { configDiagnosticsFromRaw } from "../../src/config/diagnostics";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnDegradedTopLevelOptIns } from "../../src/config/load-degrade";
import { resolveWorkflowBudgetPolicy } from "../../src/lib/workflow-budget-config";
import { DEFAULT_WORKFLOW_BUDGET_POLICY } from "../../src/lib/workflow-budget";

const invalid = [null, [], true, "8", { maxConcurrentChildren: 1 }, { maxConcurrentChildren: 65 },
  { maxPhysicalSends: 0 }, { maxPhysicalSends: 2.5 }, { maxDistinctChildren: "64" },
  { maxDistinctChildren: 1_025 }, { windowMs: 60_000 }, { maxConcurrentChildren: 8, interactiveReserve: 0 }];

describe("workflow budget configuration", () => {
  test("an absent block enforces the built-in policy itself", () => {
    expect(getDefaultConfig().workflowBudget).toBeUndefined();
    expect(resolveWorkflowBudgetPolicy(getDefaultConfig())).toEqual(DEFAULT_WORKFLOW_BUDGET_POLICY);
  });

  test("valid partial blocks override only the named ceilings", () => {
    const candidate = { ...getDefaultConfig(), workflowBudget: { maxConcurrentChildren: 16, maxPhysicalSends: 1_024 } };
    const parsed = validateConfigCandidate(candidate);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.workflowBudget).toEqual({ maxConcurrentChildren: 16, maxPhysicalSends: 1_024 });
    expect(resolveWorkflowBudgetPolicy(parsed.config)).toEqual({
      ...DEFAULT_WORKFLOW_BUDGET_POLICY, maxConcurrentChildren: 16, maxPhysicalSends: 1_024,
    });
  });

  test("invalid writes are refused while an invalid disk block falls back to the built-in ceilings", () => {
    for (const budget of invalid) {
      const candidate = { ...getDefaultConfig(), workflowBudget: budget };
      const result = validateConfigCandidate(candidate);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("workflowBudget");
      const parsed = configSchema.parse(candidate);
      expect(parsed.workflowBudget).toBeUndefined();
      expect(parsed.providers).toEqual(candidate.providers);
      expect(resolveWorkflowBudgetPolicy(parsed)).toEqual(DEFAULT_WORKFLOW_BUDGET_POLICY);
      const diagnostics = configDiagnosticsFromRaw(JSON.stringify(candidate));
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings?.join(" ")).toContain("workflowBudget ignored");
    }
  });

  test("loading a malformed block warns instead of failing silently", () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = { ...getDefaultConfig(), workflowBudget: { maxConcurrentChildren: 0 } };
      warnDegradedTopLevelOptIns(raw, configSchema.parse(raw));
      expect(warning.mock.calls.some(call => String(call[0]).includes("invalid workflowBudget"))).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });
});
