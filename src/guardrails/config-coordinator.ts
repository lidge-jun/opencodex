import {
  adoptPersistedGuardrailsIntoLiveConfig,
  deleteConfigTopLevelKey,
  mutatePersistedConfig,
  validateConfigCandidate,
  withConfigMutationLockSync,
  type PersistedConfigMutationOutcome,
} from "../config";
import type { OcxConfig, OcxGuardrailsConfig, OcxGuardrailsCustomRule } from "../types";
import {
  applyGuardrailsSettingsPatch,
  guardrailsConfigEqual,
  parseGuardrailsConfig,
  type GuardrailsSettingsPatch,
} from "./config-schema";
import {
  compileGuardrailsRuntimeSnapshot,
  disposeGuardrailsRuntimeSnapshot,
  guardrailsPolicyRevision,
  publishGuardrailsRuntimeSnapshot,
  type GuardrailsRuntimeSnapshot,
} from "./runtime";
import { validateGuardrailsCustomRulesCompatibility } from "./registry";

export type GuardrailsConfigMutationOutcome = PersistedConfigMutationOutcome<OcxGuardrailsConfig | undefined>;
type PreparedGuardrailsConfig = { config: OcxGuardrailsConfig | undefined; snapshot: GuardrailsRuntimeSnapshot | undefined };

export type GuardrailsCustomRuleMutation =
  | { kind: "create"; rule: OcxGuardrailsCustomRule }
  | { kind: "replace"; ruleId: string; rule: OcxGuardrailsCustomRule }
  | { kind: "delete"; ruleId: string };

export class GuardrailsCustomRuleMutationError extends Error {
  constructor(readonly reason: "duplicate" | "not_found") {
    super(reason === "duplicate"
      ? "a Guardrails custom rule with this ruleId already exists"
      : "Guardrails custom rule was not found");
  }
}

export class GuardrailsConfigRevisionConflictError extends Error {
  constructor(readonly currentRevision: string) {
    super("Guardrails settings changed since they were loaded");
  }
}

function applyCustomRuleMutation(
  previous: OcxGuardrailsConfig | undefined,
  mutation: GuardrailsCustomRuleMutation,
): GuardrailsSettingsPatch {
  const current = previous?.customRules ?? [];
  switch (mutation.kind) {
    case "create":
      if (current.some(rule => rule.ruleId === mutation.rule.ruleId)) {
        throw new GuardrailsCustomRuleMutationError("duplicate");
      }
      return { customRules: [...current, mutation.rule] };
    case "replace": {
      const index = current.findIndex(rule => rule.ruleId === mutation.ruleId);
      if (index < 0) throw new GuardrailsCustomRuleMutationError("not_found");
      const customRules = [...current];
      customRules[index] = mutation.rule;
      return { customRules };
    }
    case "delete":
      if (!current.some(rule => rule.ruleId === mutation.ruleId)) {
        throw new GuardrailsCustomRuleMutationError("not_found");
      }
      return { customRules: current.filter(rule => rule.ruleId !== mutation.ruleId) };
  }
}

function mutateGuardrailsConfig(
  liveConfig: OcxConfig,
  expectedRevision: string,
  resolvePatch: (previous: OcxGuardrailsConfig | undefined) => GuardrailsSettingsPatch,
): GuardrailsConfigMutationOutcome {
  return withConfigMutationLockSync(() => {
    const preparedSnapshots = new Set<GuardrailsRuntimeSnapshot>();
    let selected: GuardrailsRuntimeSnapshot | undefined;
    try {
      const outcome = mutatePersistedConfig<PreparedGuardrailsConfig>(
        config => {
          const previous = config.guardrails;
          const currentRevision = guardrailsPolicyRevision(previous ?? {});
          if (currentRevision !== expectedRevision) {
            throw new GuardrailsConfigRevisionConflictError(currentRevision);
          }
          const requested = applyGuardrailsSettingsPatch(previous, resolvePatch(previous));
          let next: OcxGuardrailsConfig | undefined;
          if (requested !== undefined) {
            const parsed = parseGuardrailsConfig(requested);
            if (!parsed.ok) throw new Error(`Guardrails settings rejected: ${parsed.error}`);
            next = parsed.config;
            config.guardrails = next;
          } else {
            deleteConfigTopLevelKey(config, "guardrails");
          }
          const fullConfig = validateConfigCandidate(config);
          if (!fullConfig.ok) throw new Error(`Guardrails settings rejected: ${fullConfig.error}`);
          if (next?.enabled !== true && next?.customRules) {
            validateGuardrailsCustomRulesCompatibility(next.customRules);
          }
          const snapshot = next?.enabled === true ? compileGuardrailsRuntimeSnapshot(next) : undefined;
          if (snapshot) preparedSnapshots.add(snapshot);
          return {
            changed: !guardrailsConfigEqual(previous, next),
            value: { config: next, snapshot },
          };
        },
        // A first UI save must be able to create config.json. The initializer is used only
        // while the shared lock confirms that no file exists, and a concurrently created file
        // is rebased before commit by mutatePersistedConfig.
        { initializeMissingConfig: () => liveConfig },
      );
      if (outcome.status === "unavailable") return { status: "unavailable", reason: outcome.reason };
      selected = outcome.value.snapshot;
      adoptPersistedGuardrailsIntoLiveConfig(liveConfig, outcome.value.config);
      publishGuardrailsRuntimeSnapshot(liveConfig, selected);
      return { status: outcome.status, value: outcome.value.config };
    } finally {
      for (const snapshot of preparedSnapshots) {
        if (snapshot !== selected) disposeGuardrailsRuntimeSnapshot(snapshot);
      }
    }
  });
}

/**
 * Commit only `guardrails` against the newest disk generation, then publish the
 * committed subtree into the live config while the shared mutation lock remains held.
 */
export function mutateAndAdoptGuardrailsConfig(
  liveConfig: OcxConfig,
  patch: GuardrailsSettingsPatch,
  expectedRevision: string,
): GuardrailsConfigMutationOutcome {
  return mutateGuardrailsConfig(liveConfig, expectedRevision, () => patch);
}

/** Apply a single custom-rule operation against the newest persisted config under one lock. */
export function mutateAndAdoptGuardrailsCustomRule(
  liveConfig: OcxConfig,
  mutation: GuardrailsCustomRuleMutation,
  expectedRevision: string,
): GuardrailsConfigMutationOutcome {
  return mutateGuardrailsConfig(
    liveConfig,
    expectedRevision,
    previous => applyCustomRuleMutation(previous, mutation),
  );
}
