import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  MANAGED_PATH_TEMPLATES,
  PLAN_CHANGE_LIMIT,
  PLAN_UNBOUND_FINGERPRINT,
  buildMutationPlan,
  canonicalSchemaPath,
  orderPlanChanges,
  planFingerprint,
  previewIntegration,
  type IntegrationPlanChange,
  type PlanInput,
  type PlanFingerprintInput,
} from "../../src/integrations/mutation-plan";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  type ExportContext,
  type ExportModel,
  type ManagedContribution,
} from "../../src/clients/config-export";
import type { OwnershipRecord } from "../../src/integrations/ownership";
import { fingerprint } from "../../src/integrations/ownership";
import type { JournalEntry } from "../../src/integrations/journal";
import type { OcxConfig } from "../../src/types";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, restoreIntegration } from "../../src/integrations/writer";
import { clinePendingPath } from "../../src/integrations/cline-io";
import { resolveIntegrationPaths } from "../../src/integrations/registry";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const FIXTURE_MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  { namespaced: "gpt-5.5", provider: "openai", id: "gpt-5.5", native: true, contextWindow: 400_000 },
];

const FIXTURE_CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function fixtureContext(): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", models: FIXTURE_MODELS, config: FIXTURE_CONFIG };
}

const CONFIG_PATH = "/home/example/.cline/config.json";

const RECORD: OwnershipRecord = {
  clientId: "cline",
  configPath: CONFIG_PATH,
  fileFingerprint: "0123456789abcdef",
  blockFingerprint: "fedcba9876543210",
  fragmentPaths: [["providers", "opencodex"]],
  appliedAt: "2026-01-01T00:00:00.000Z",
  opId: "op-base",
};

const CANARY = "canary-value-must-not-be-published";

const CONTRIBUTION: ManagedContribution = {
  clientId: "cline",
  fragments: [
    { path: ["settings", "providers", "opencodex"], value: { baseUrl: "http://127.0.0.1:10100", apiKey: CANARY } },
    { path: ["catalog", "providers", "opencodex"], value: { models: [CANARY] } },
  ],
};

const ENTRY: JournalEntry = {
  opId: "op-base",
  clientId: "cline",
  kind: "apply",
  at: "2026-01-01T00:00:00.000Z",
  configPath: CONFIG_PATH,
  snapshot: { kind: "stored", relPath: "snapshots/op-base.json" },
  resultFingerprint: "0123456789abcdef",
  resultAbsent: false,
  priorRecord: null,
};

const BASE: PlanFingerprintInput = {
  operation: "apply",
  clientId: "cline",
  configPath: CONFIG_PATH,
  detectDir: "/home/example/.cline",
  installKind: "dir",
  admissionBlocked: false,
  ineffectiveWrite: null,
  before: "{}",
  contribution: CONTRIBUTION,
  record: RECORD,
  models: [{ namespaced: "anthropic/claude", provider: "anthropic", id: "claude" }],
};

const RESTORE: NonNullable<PlanFingerprintInput["restore"]> = {
  opId: "op-base",
  entry: ENTRY,
  snapshotKind: "stored",
  snapshotText: "{\"a\":1}",
  confirmDrift: false,
  driftsFromResult: false,
};

const RESTORE_BASE: PlanFingerprintInput = { ...BASE, operation: "restore", restore: RESTORE };

describe("integration mutation plan projection", () => {
  test("a declared managed path is published as its template", () => {
    expect(canonicalSchemaPath("cline", ["settings", "providers", "opencodex"])).toBe("settings.providers.opencodex");
    expect(canonicalSchemaPath("raycast", ["providers", "[id=opencodex]"])).toBe("providers.[id=opencodex]");
  });

  test("a dynamic position never publishes the member it selected", () => {
    // Kimi writes one fragment per model, so this position holds a user's model alias. An
    // alphanumeric allowlist would have emitted it verbatim.
    const path = canonicalSchemaPath("kimi", ["models", "kimi-k2-private-alias"]);
    expect(path).toBe("models.*");
    expect(path).not.toContain("kimi-k2-private-alias");
  });

  test("a path outside the client's declared grammar is refused, not described", () => {
    // An ownership record accepts arbitrary strings, so a path is never published because a record
    // carries it. Depth, a foreign static segment and another client's shape all fail closed.
    expect(canonicalSchemaPath("kimi", ["models", "alias", "contextWindow"])).toBeNull();
    expect(canonicalSchemaPath("pi", ["providers", "someone-elses-provider"])).toBeNull();
    expect(canonicalSchemaPath("pi", ["settings", "providers", "opencodex"])).toBeNull();
    expect(canonicalSchemaPath("cline", ["..", "..", "etc"])).toBeNull();
    expect(canonicalSchemaPath("cline", [])).toBeNull();
  });

  test("every path a shipped client actually writes canonicalizes through its own templates", () => {
    // The declarations are a second copy of what the exporters do, so the only assertion worth
    // making is against real builder output. A template list that merely exists proves nothing.
    for (const clientId of EXPORT_CLIENT_IDS) {
      expect(MANAGED_PATH_TEMPLATES[clientId].length, clientId).toBeGreaterThan(0);
      const contribution = EXPORT_CLIENTS[clientId].buildContribution(fixtureContext());
      expect(contribution.fragments.length, clientId).toBeGreaterThan(0);
      for (const fragment of contribution.fragments) {
        const canonical = canonicalSchemaPath(clientId, fragment.path);
        expect(canonical, `${clientId}: ${fragment.path.join(".")}`).not.toBeNull();
        // A dynamic position must not carry its observed value into the published path.
        for (const segment of fragment.path) {
          if (!MANAGED_PATH_TEMPLATES[clientId].some(template => template.includes(segment))) {
            expect(canonical, `${clientId} leaked ${segment}`).not.toContain(segment);
          }
        }
      }
    }
  });

  test("changes are deduplicated and ordered by kind then path", () => {
    const input: IntegrationPlanChange[] = [
      { kind: "journal", path: "$journal" },
      { kind: "replace", path: "providers.b" },
      { kind: "add", path: "providers.z" },
      { kind: "replace", path: "providers.a" },
      { kind: "add", path: "providers.z" },
    ];
    expect(orderPlanChanges(input)).toEqual([
      { kind: "add", path: "providers.z" },
      { kind: "replace", path: "providers.a" },
      { kind: "replace", path: "providers.b" },
      { kind: "journal", path: "$journal" },
    ]);
  });

  test("the reported change list is capped and frozen", () => {
    const many: IntegrationPlanChange[] = Array.from({ length: PLAN_CHANGE_LIMIT + 5 }, (_unused, index) => ({
      kind: "add" as const,
      path: `providers.p${String(index).padStart(4, "0")}`,
    }));
    const ordered = orderPlanChanges(many);
    expect(ordered.length).toBe(PLAN_CHANGE_LIMIT);
    // Frozen because a caller that sorted this in place would be editing shared plan state.
    expect(() => (ordered as IntegrationPlanChange[]).push({ kind: "add", path: "providers.extra" })).toThrow();
  });
});

describe("integration plan fingerprint", () => {
  test("is stable for the same inputs and carries its version", () => {
    expect(planFingerprint(BASE)).toBe(planFingerprint({ ...BASE }));
    // Derived from the one exported value that carries the version, so a bump
    // cannot leave this case asserting the previous vocabulary.
    const version = PLAN_UNBOUND_FINGERPRINT.split(":")[0]!;
    expect(version).not.toBe("");
    expect(planFingerprint(BASE).startsWith(`${version}:`)).toBe(true);
  });

  test("every authority input changes it", () => {
    const variants: PlanFingerprintInput[] = [
      BASE,
      { ...BASE, operation: "overwrite" },
      { ...BASE, clientId: "opencode" },
      { ...BASE, profileId: 1 },
      { ...BASE, configPath: "/home/other/.cline/config.json" },
      { ...BASE, detectDir: "/home/other/.cline" },
      // The contribution is identical across an uninstall and across a change in admission
      // eligibility, so binding the path alone would keep a stale confirmation valid.
      { ...BASE, installKind: "missing" },
      { ...BASE, installKind: "file" },
      { ...BASE, admissionBlocked: true },
      // A client that creates its new provider store while a confirmation is
      // outstanding changes whether the write can reach it at all, and leaves
      // the file, the record and the contribution untouched while doing it.
      { ...BASE, ineffectiveWrite: "unestablished-schema\u0000/home/example/.client/store.json" },
      // The same location with a different reason is a different answer: a store
      // whose schema stops being one we recognise moves nothing on disk.
      { ...BASE, ineffectiveWrite: "owned-config-file\u0000/home/example/.client/store.json" },
      // Different bytes, and absent distinguished from empty: restoring over a missing file and
      // over an empty one are different operations.
      { ...BASE, before: "{ }" },
      { ...BASE, before: "" },
      { ...BASE, before: null },
      { ...BASE, contribution: null },
      {
        ...BASE,
        contribution: {
          clientId: "cline",
          fragments: [{ path: ["providers", "opencodex"], value: { baseUrl: "http://127.0.0.1:10101" } }],
        },
      },
      { ...BASE, record: null },
      // The contribution is derived from the model roster, so a changed roster changes what a
      // confirmed apply would write.
      { ...BASE, models: [{ namespaced: "anthropic/claude", provider: "anthropic", id: "claude-2" }] },
      { ...BASE, models: [] },
    ];
    expect(new Set(variants.map(planFingerprint)).size).toBe(variants.length);
  });

  test("restore binds the selected row and the bytes it would publish", () => {
    const variants: PlanFingerprintInput[] = [
      RESTORE_BASE,
      { ...RESTORE_BASE, restore: { ...RESTORE, opId: "op-other" } },
      { ...RESTORE_BASE, restore: { ...RESTORE, entry: { ...ENTRY, resultAbsent: true } } },
      { ...RESTORE_BASE, restore: { ...RESTORE, entry: { ...ENTRY, priorRecord: RECORD } } },
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotKind: "none" } },
      // Same row and same snapshot kind, different snapshot bytes. Binding only the operation id
      // would leave the bytes that actually land in the user's file outside the confirmation.
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotText: "{\"a\":2}" } },
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotText: null } },
      { ...RESTORE_BASE, restore: { ...RESTORE, confirmDrift: true } },
      { ...RESTORE_BASE, restore: { ...RESTORE, driftsFromResult: true } },
    ];
    expect(new Set(variants.map(planFingerprint)).size).toBe(variants.length);
  });
});

const PLAN_BASE: PlanInput = { ...BASE, classified: { state: "absent" }, parsed: {} };

/** A document that already holds a value where the settings fragment goes. */
const OCCUPIED = { settings: { providers: { opencodex: { baseUrl: "http://elsewhere" } } } };

describe("integration mutation plan", () => {
  test("an allowed apply names every managed place and the history it writes", () => {
    const plan = buildMutationPlan(PLAN_BASE);
    expect(plan.canApply).toBe(true);
    expect(plan.willChange).toBe(true);
    expect(plan.refusalReason).toBeUndefined();
    expect(plan.changes).toEqual([
      { kind: "add", path: "catalog.providers.opencodex" },
      { kind: "add", path: "settings.providers.opencodex" },
      { kind: "snapshot", path: "$snapshot" },
      { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ]);
  });

  test("an occupied place is a replacement whether or not we own it", () => {
    // Deciding from our own record would call an overwrite of somebody else's key an addition,
    // which is the one situation overwrite exists for.
    const plan = buildMutationPlan({
      ...PLAN_BASE,
      operation: "overwrite",
      classified: { state: "conflict", reason: "unowned-key" },
      record: null,
      parsed: OCCUPIED,
    });
    expect(plan.changes).toContainEqual({ kind: "replace", path: "settings.providers.opencodex" });
    expect(plan.changes).toContainEqual({ kind: "add", path: "catalog.providers.opencodex" });
  });

  test("no configured value reaches the plan", () => {
    const plan = buildMutationPlan(PLAN_BASE);
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    expect(JSON.stringify(plan)).not.toContain(CONFIG_PATH);
  });

  test("apply refuses in the writer's order: installation, admission, conflict, then unsafe", () => {
    const conflicted: PlanInput = { ...PLAN_BASE, classified: { state: "conflict", reason: "foreign-edit" } };
    // Installation outranks a conflict the file would otherwise report.
    expect(buildMutationPlan({ ...conflicted, installKind: "missing" }).refusalReason).toBe("not_installed");
    expect(buildMutationPlan({ ...conflicted, admissionBlocked: true }).refusalReason).toBe("non_loopback");
    expect(buildMutationPlan({ ...conflicted, ineffectiveWrite: "owned-config-file\u0000/store.json" }).refusalReason)
      .toBe("superseded_store");
    // And a conflict outranks the classifier's unsafe, which apply reports last.
    expect(buildMutationPlan(conflicted).refusalReason).toBe("conflict");
    expect(buildMutationPlan({ ...PLAN_BASE, classified: { state: "unsafe", reason: "blocked-container" } }).refusalReason)
      .toBe("unsafe");
    const refused = buildMutationPlan({ ...PLAN_BASE, installKind: "missing" });
    expect(refused.canApply).toBe(false);
    expect(refused.changes).toEqual([]);
  });

  test("disable asks its own questions and never asks about installation", () => {
    const disable: PlanInput = { ...PLAN_BASE, operation: "disable", classified: { state: "current" } };
    // Removing what we wrote from a file that still exists is meaningful whether or not the
    // client is installed now, and it emits nothing admission policy could object to.
    expect(buildMutationPlan({ ...disable, installKind: "missing" }).canApply).toBe(true);
    expect(buildMutationPlan({ ...disable, admissionBlocked: true }).canApply).toBe(true);
    // Removing bytes this project wrote to this file stays possible after the
    // client stops reading it; refusing would strand the block forever.
    expect(buildMutationPlan({ ...disable, ineffectiveWrite: "owned-config-file\u0000/store.json" }).canApply).toBe(true);
    expect(buildMutationPlan({ ...disable, classified: { state: "conflict", reason: "foreign-edit" } }).refusalReason)
      .toBe("conflict");
  });

  test("an operation that would write nothing says so and names no places", () => {
    // The writer succeeds without writing in both of these, so reporting a snapshot and a journal
    // row would describe consequences that never happen.
    const applied = buildMutationPlan({ ...PLAN_BASE, classified: { state: "current" } });
    expect(applied.canApply).toBe(true);
    expect(applied.willChange).toBe(false);
    expect(applied.changes).toEqual([]);

    const disabled = buildMutationPlan({ ...PLAN_BASE, operation: "disable", classified: { state: "absent" } });
    expect(disabled.canApply).toBe(true);
    expect(disabled.willChange).toBe(false);
    expect(disabled.changes).toEqual([]);
  });

  test("overwrite is the operation allowed through a conflict", () => {
    const conflicted: PlanInput = { ...PLAN_BASE, classified: { state: "conflict", reason: "foreign-edit" } };
    expect(buildMutationPlan(conflicted).refusalReason).toBe("conflict");
    expect(buildMutationPlan({ ...conflicted, operation: "overwrite" }).canApply).toBe(true);
    expect(buildMutationPlan(conflicted).foreignEdit).toBe("foreign-edit");
  });

  test("restore reports an expired backup and unconfirmed drift", () => {
    const plan: PlanInput = { ...RESTORE_BASE, classified: { state: "current" }, parsed: {} };
    expect(buildMutationPlan({ ...plan, restore: { ...RESTORE, snapshotKind: "expired" } }).refusalReason)
      .toBe("snapshot_expired");
    const drifted = buildMutationPlan({ ...plan, restore: { ...RESTORE, driftsFromResult: true } });
    expect(drifted.refusalReason).toBe("drift_requires_confirm");
    expect(drifted.foreignEdit).toBe("drift");
    expect(buildMutationPlan({ ...plan, restore: { ...RESTORE, driftsFromResult: true, confirmDrift: true } }).canApply).toBe(true);
  });

  test("a file that was recorded and is now gone has drifted, it is not simply absent", () => {
    // Calling it absent would describe a missing file as an ordinary undo, while the writer
    // refuses it pending confirmation. Absence is only honest when the row recorded absence too.
    const vanished = buildMutationPlan({
      ...RESTORE_BASE,
      classified: { state: "conflict" },
      parsed: {},
      before: null,
      restore: { ...RESTORE, driftsFromResult: true },
    });
    expect(vanished.state).toBe("conflict");
    expect(vanished.refusalReason).toBe("drift_requires_confirm");

    const recordedAbsent = buildMutationPlan({
      ...RESTORE_BASE,
      classified: { state: "absent" },
      parsed: {},
      before: null,
      restore: { ...RESTORE, driftsFromResult: false },
    });
    expect(recordedAbsent.state).toBe("absent");
    expect(recordedAbsent.canApply).toBe(true);
  });
});

/** Every file under a directory with its bytes, so "nothing changed" is a comparison and not a claim. */
function treeSnapshot(root: string): Record<string, string> {
  const seen: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else seen[relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return seen;
}

describe("integration preview writes nothing", () => {
  test("planning an apply leaves the client file and the whole store untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-preview-home-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-preview-store-"));
    try {
      const env = {} as NodeJS.ProcessEnv;
      const { configPath, detectDir } = resolveIntegrationPaths("opencode", env, home);
      // Fail loudly rather than reading somebody's real configuration: every client resolves
      // through the home argument, and a client that stopped doing so must not be read here.
      expect(configPath.startsWith(home), configPath).toBe(true);
      mkdirSync(detectDir, { recursive: true });
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, "{}\n");

      const store = createIntegrationStateStore(storeRoot);
      // Maintenance a mutation would retry on its way through. A preview must leave it pending.
      store.markPruneFailure("opencode", "seeded pending prune");
      const homeBefore = treeSnapshot(home);
      const storeBefore = treeSnapshot(storeRoot);

      const plan = previewIntegration(
        { clientId: "opencode", models: FIXTURE_MODELS, config: FIXTURE_CONFIG, port: 10100, env, home, store },
        { operation: "apply" },
      );

      expect(plan.canApply).toBe(true);
      expect(plan.changes.some(change => change.kind === "add")).toBe(true);
      expect(plan.changes).toContainEqual({ kind: "journal", path: "$journal" });

      // The whole promise of the feature, checked against the filesystem rather than asserted.
      // The entire home rather than the target alone: a writer lock or a marker sibling would
      // appear next to the file, not inside it, and that is exactly what must not happen here.
      expect(treeSnapshot(home)).toEqual(homeBefore);
      expect(treeSnapshot(storeRoot)).toEqual(storeBefore);
      // Still pending, so the read path ran no maintenance.
      expect(Object.keys(store.readMaintenance().pruneFailures)).toContain("opencode");

      // A plan describes places, never contents or locations.
      const serialized = JSON.stringify(plan);
      expect(serialized).not.toContain(home);
      expect(serialized).not.toContain("127.0.0.1");
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });

  test("a pending client transaction is left exactly as found", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-preview-cline-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-preview-cline-store-"));
    try {
      const env = {} as NodeJS.ProcessEnv;
      const { configPath, detectDir } = resolveIntegrationPaths("cline", env, home);
      expect(configPath.startsWith(home), configPath).toBe(true);
      mkdirSync(detectDir, { recursive: true });
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, "{}\n");

      const store = createIntegrationStateStore(storeRoot);
      const markerPath = clinePendingPath(store, configPath);
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, "{\"pending\":\"left over from an interrupted mutation\"}\n");

      const homeBefore = treeSnapshot(home);
      const storeBefore = treeSnapshot(storeRoot);

      const plan = previewIntegration(
        { clientId: "cline", models: FIXTURE_MODELS, config: FIXTURE_CONFIG, port: 10100, env, home, store },
        { operation: "apply" },
      );

      // Recovery is a mutation. A preview reports what it found and repairs nothing, so the
      // marker and its siblings survive byte for byte whatever the plan concluded.
      expect(plan.version).toBe(1);
      expect(treeSnapshot(home)).toEqual(homeBefore);
      expect(treeSnapshot(storeRoot)).toEqual(storeBefore);
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });
});

describe("planning an undo reads the writer's specification", () => {
  function seedRestore(home: string, storeRoot: string, targetText: string, recordedPath?: string) {
    const store = createIntegrationStateStore(storeRoot);
    const env = {} as NodeJS.ProcessEnv;
    const { configPath, detectDir } = resolveIntegrationPaths("opencode", env, home);
    expect(configPath.startsWith(home), configPath).toBe(true);
    mkdirSync(detectDir, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, targetText);
    const opId = "op-seeded";
    const snapshot = store.captureSnapshot("opencode", opId, "{}\n");
    store.appendJournal({
      opId,
      clientId: "opencode",
      kind: "apply",
      at: "2026-01-01T00:00:00.000Z",
      configPath: recordedPath ?? configPath,
      snapshot,
      resultFingerprint: fingerprint(targetText),
      resultAbsent: false,
      priorRecord: null,
    } satisfies JournalEntry);
    return { store, env, opId };
  }

  test("a target that cannot be parsed is exactly the one worth restoring", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-restore-parse-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-restore-parse-store-"));
    try {
      // The writer's undo reads bytes and never parses, so refusing here would deny an operator
      // the backup at the moment the file is in the state that most needs one.
      const { store, env, opId } = seedRestore(home, storeRoot, "{ this is not valid json");
      const plan = previewIntegration(
        { clientId: "opencode", models: FIXTURE_MODELS, config: FIXTURE_CONFIG, port: 10100, env, home, store },
        { operation: "restore", opId },
      );
      expect(plan.refusalReason).toBeUndefined();
      expect(plan.canApply).toBe(true);
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });

  test("a row recorded against another location is refused rather than planned", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-restore-path-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-restore-path-store-"));
    try {
      // Path equality is the single thing the writer's undo exists to enforce: a row recorded for
      // one home must never rewrite a file in another.
      const { store, env, opId } = seedRestore(home, storeRoot, "{}\n", join(home, "elsewhere", "opencode.json"));
      const plan = previewIntegration(
        { clientId: "opencode", models: FIXTURE_MODELS, config: FIXTURE_CONFIG, port: 10100, env, home, store },
        { operation: "restore", opId },
      );
      expect(plan.canApply).toBe(false);
      expect(plan.refusalReason).toBe("conflict");
      expect(plan.changes).toEqual([]);
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });
});

const MANAGED_PATHS = [["settings", "providers", "opencodex"]];

describe("integration mutation plan: what an undo would change", () => {
  const owned = { ...RECORD, fragmentPaths: MANAGED_PATHS };

  test("undoing an initial apply takes the managed place back out", () => {
    // There was no prior record, because nothing was ours before that apply. Reading only the
    // prior record therefore described this undo as touching no managed place at all, while the
    // undo removes the block it added.
    const plan = buildMutationPlan({
      ...PLAN_BASE,
      operation: "restore",
      classified: { state: "current" },
      restore: { ...RESTORE, entry: { ...ENTRY, priorRecord: null } },
      record: owned,
      parsed: OCCUPIED,
    });

    expect(plan.changes).toContainEqual({ kind: "remove", path: "settings.providers.opencodex" });
    expect(plan.changes.some(change => change.kind === "replace")).toBe(false);
  });

  test("undoing a disable adds back a place the document does not have", () => {
    // The disable removed it, so the document has nothing there now. Calling that a replacement
    // described a mutation of something that is not in the file.
    const plan = buildMutationPlan({
      ...PLAN_BASE,
      operation: "restore",
      classified: { state: "absent" },
      restore: { ...RESTORE, entry: { ...ENTRY, kind: "disable", priorRecord: owned } },
      record: null,
      parsed: {},
    });

    expect(plan.changes).toContainEqual({ kind: "add", path: "settings.providers.opencodex" });
    expect(plan.changes.some(change => change.kind === "replace")).toBe(false);
  });

  test("a place that is ours on both sides is replaced, and none of this publishes a value", () => {
    const plan = buildMutationPlan({
      ...PLAN_BASE,
      operation: "restore",
      classified: { state: "current" },
      restore: { ...RESTORE, entry: { ...ENTRY, priorRecord: owned } },
      record: owned,
      parsed: OCCUPIED,
    });

    expect(plan.changes).toContainEqual({ kind: "replace", path: "settings.providers.opencodex" });
    expect(plan.changes.some(change => change.kind === "remove" || change.kind === "add")).toBe(false);
    // The plan names places, never what is in them or where the file lives.
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    expect(JSON.stringify(plan)).not.toContain(CONFIG_PATH);
  });
});

describe("planning an undo of work that actually happened", () => {
  function realApply(home: string, storeRoot: string) {
    const store = createIntegrationStateStore(storeRoot);
    const env = {} as NodeJS.ProcessEnv;
    const { configPath, detectDir } = resolveIntegrationPaths("opencode", env, home);
    mkdirSync(detectDir, { recursive: true });
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{}\n");
    const input = { clientId: "opencode" as const, models: FIXTURE_MODELS, config: FIXTURE_CONFIG, port: 10100, env, home, store };
    const applied = applyIntegration(input);
    if (!applied.ok || !applied.opId) throw new Error("fixture apply failed");
    return { input, configPath, applyOpId: applied.opId };
  }

  test("undoing a real apply reports taking the managed places back out", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-undo-apply-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-undo-apply-store-"));
    try {
      const { input, configPath, applyOpId } = realApply(home, storeRoot);
      expect(readFileSync(configPath, "utf8")).toContain("opencodex");

      // Every input this classification reads comes from the apply that just happened: the
      // ownership record it wrote and the document it produced, not values a builder supplied.
      const plan = previewIntegration(input, { operation: "restore", opId: applyOpId });

      expect(plan.canApply).toBe(true);
      expect(plan.changes.some(change => change.kind === "remove")).toBe(true);
      expect(plan.changes.some(change => change.kind === "replace")).toBe(false);
      expect(plan.changes.some(change => change.kind === "add")).toBe(false);

      // And the undo does what the plan said: the managed block is gone from the file.
      const restored = restoreIntegration({ ...input, opId: applyOpId });
      expect(restored.ok).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe("{}\n");
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });

  test("undoing a real disable reports adding the managed places back", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-undo-disable-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-undo-disable-store-"));
    try {
      const { input, configPath } = realApply(home, storeRoot);
      const disabled = disableIntegration(input);
      if (!disabled.ok || !disabled.opId) throw new Error("fixture disable failed");
      // The disable took the block out, so the document does not hold those places now.
      expect(readFileSync(configPath, "utf8")).not.toContain("opencodex");

      const plan = previewIntegration(input, { operation: "restore", opId: disabled.opId });

      expect(plan.canApply).toBe(true);
      expect(plan.changes.some(change => change.kind === "add")).toBe(true);
      expect(plan.changes.some(change => change.kind === "replace")).toBe(false);

      // And the undo does what the plan said: the managed block is back in the file.
      const restored = restoreIntegration({ ...input, opId: disabled.opId });
      expect(restored.ok).toBe(true);
      expect(readFileSync(configPath, "utf8")).toContain("opencodex");
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });

  test("a document that cannot be read leaves every place a replacement and refuses nothing", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-undo-unreadable-"));
    const storeRoot = mkdtempSync(join(tmpdir(), "ocx-undo-unreadable-store-"));
    try {
      const { input, configPath } = realApply(home, storeRoot);
      const disabled = disableIntegration(input);
      if (!disabled.ok || !disabled.opId) throw new Error("fixture disable failed");
      // Restore eligibility is a byte comparison and stays one: the document is descriptive here,
      // so an unparseable file still plans, and the places it cannot speak for are replacements.
      writeFileSync(configPath, "{ this is not valid json");

      const plan = previewIntegration(input, { operation: "restore", opId: disabled.opId, confirmDrift: true });

      expect(plan.refusalReason).toBeUndefined();
      expect(plan.canApply).toBe(true);
      // The same undo reported additions when the document was readable and empty of them. With
      // nothing readable to ask, it says replacement rather than inventing an answer.
      expect(plan.changes.some(change => change.kind === "replace")).toBe(true);
      expect(plan.changes.some(change => change.kind === "add")).toBe(false);
    } finally {
      removeTreeWithRetry(home);
      removeTreeWithRetry(storeRoot);
    }
  });
});
