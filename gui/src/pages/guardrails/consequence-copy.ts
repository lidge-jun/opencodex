import type { ConsequenceCopy } from "../integrations/ConsequenceDialog";

export type GuardrailsConsequenceKind =
  | "disable"
  | "detect"
  | "passthrough"
  | "disableRule"
  | "disableCategory"
  | "limitProvider"
  | "bulkDisable"
  | "deleteRule"
  | "replaceImport"
  | "replaceImportWeakening";

export const GUARDRAILS_CONSEQUENCE_COPY: Record<
  GuardrailsConsequenceKind,
  ConsequenceCopy
> = {
  disable: {
    titleKey: "guardrails.dialog.disable.title",
    changesKey: "guardrails.dialog.disable.changes",
    breakageKey: "guardrails.dialog.disable.breakage",
    undoKey: "guardrails.dialog.disable.undo",
    confirmKey: "guardrails.dialog.disable.confirm",
  },
  detect: {
    titleKey: "guardrails.dialog.detect.title",
    changesKey: "guardrails.dialog.detect.changes",
    breakageKey: "guardrails.dialog.detect.breakage",
    undoKey: "guardrails.dialog.detect.undo",
    confirmKey: "guardrails.dialog.detect.confirm",
  },
  passthrough: {
    titleKey: "guardrails.dialog.passthrough.title",
    changesKey: "guardrails.dialog.passthrough.changes",
    breakageKey: "guardrails.dialog.passthrough.breakage",
    undoKey: "guardrails.dialog.passthrough.undo",
    confirmKey: "guardrails.dialog.passthrough.confirm",
  },
  disableRule: {
    titleKey: "guardrails.dialog.ruleDisable.title",
    changesKey: "guardrails.dialog.ruleDisable.changes",
    breakageKey: "guardrails.dialog.ruleDisable.breakage",
    undoKey: "guardrails.dialog.ruleDisable.undo",
    confirmKey: "guardrails.dialog.ruleDisable.confirm",
  },
  disableCategory: {
    titleKey: "guardrails.dialog.categoryDisable.title",
    changesKey: "guardrails.dialog.categoryDisable.changes",
    breakageKey: "guardrails.dialog.categoryDisable.breakage",
    undoKey: "guardrails.dialog.categoryDisable.undo",
    confirmKey: "guardrails.dialog.categoryDisable.confirm",
  },
  limitProvider: {
    titleKey: "guardrails.dialog.providerScope.title",
    changesKey: "guardrails.dialog.providerScope.changes",
    breakageKey: "guardrails.dialog.providerScope.breakage",
    undoKey: "guardrails.dialog.providerScope.undo",
    confirmKey: "guardrails.dialog.providerScope.confirm",
  },
  bulkDisable: {
    titleKey: "guardrails.dialog.bulkDisable.title",
    changesKey: "guardrails.dialog.bulkDisable.changes",
    breakageKey: "guardrails.dialog.bulkDisable.breakage",
    undoKey: "guardrails.dialog.bulkDisable.undo",
    confirmKey: "guardrails.dialog.bulkDisable.confirm",
  },
  deleteRule: {
    titleKey: "guardrails.dialog.delete.title",
    changesKey: "guardrails.dialog.delete.changes",
    breakageKey: "guardrails.dialog.delete.breakage",
    undoKey: "guardrails.dialog.delete.undo",
    confirmKey: "guardrails.dialog.delete.confirm",
  },
  replaceImport: {
    titleKey: "guardrails.dialog.import.title",
    changesKey: "guardrails.dialog.import.changes",
    breakageKey: "guardrails.dialog.import.breakage",
    undoKey: "guardrails.dialog.import.undo",
    confirmKey: "guardrails.dialog.import.confirm",
  },
  replaceImportWeakening: {
    titleKey: "guardrails.dialog.importWeakening.title",
    changesKey: "guardrails.dialog.importWeakening.changes",
    breakageKey: "guardrails.dialog.importWeakening.breakage",
    undoKey: "guardrails.dialog.importWeakening.undo",
    confirmKey: "guardrails.dialog.importWeakening.confirm",
  },
};
