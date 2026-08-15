/**
 * `ocx lab` — Compatibility Lab inspection and explicit CL-08 automation controls.
 *
 * Read commands use the local SQLite projection. Automation mutations and manual runs are
 * explicit operator actions; read commands never start probes or scheduler ticks.
 */
import { getConfigDir, readConfigDiagnostics } from "../config";
import {
  ARTIFACT_CLASSES,
  EVIDENCE_LAYERS,
  EVENT_KINDS,
  EXECUTION_MODES,
  OUTCOMES,
  VERDICTS,
  type ArtifactClass,
  type CompatibilityVerdict,
  type EvidenceLayer,
  type ExecutionMode,
  type LabEventKind,
  type ObservationOutcome,
} from "../lab/constants";
import {
  InvalidCursorError,
  LabProjectionIncompatibleError,
  LabProjectionUnavailableError,
  queryLabArtifactByDigest,
  queryLabArtifacts,
  queryLabCatalogEntries,
  queryLabEventById,
  queryLabEvents,
  queryLabObservations,
  queryLabStatus,
  queryLabSubjectById,
  queryLabSubjects,
  queryLabVerdicts,
  queryPassiveProductionSignals,
  type PassiveProductionQueryResultV1,
} from "../lab/query";
import { isLabRouteSubjectId } from "../usage/log";
import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  takeFlag,
  takeIntegerOption,
  takeOption,
} from "./runtime-api";
import {
  buildLabAutomationStatus,
  enqueueManualLabRun,
  reconcileLabAutomationQueue,
  setLabAutomationDispatchDeps,
  startLabAutomationScheduler,
  stopLabAutomationScheduler,
} from "../lab/automation/orchestrator";
import { loadLabAutomationState } from "../lab/automation/persistence";
import {
  loadLabAutomationConfig,
  saveLabAutomationPolicyConfig,
} from "../lab/automation/config-persistence";
import { planManualLabRun } from "../lab/automation/planner";
import { listLabAutomationRuns } from "../lab/automation/runs-query";
import { LabAutomationError, type LabAutomationLayer } from "../lab/automation/types";
import { createProductionLabRouteExecutor } from "../lib/lab-live-route-production";
import {
  exportLocalPublicEvidence,
  importCommunityEvidenceFile,
  listCommunityEvidenceContext,
  previewLocalPublicEvidence,
  verifyPublicEvidenceFile,
  type PublicVerificationSummaryV1,
} from "../lab/public";

const USAGE = `Usage:
  ocx lab status [--json]
  ocx lab production-signals --subject <id> [--limit <n>] [--json]
  ocx lab verdicts [--subject <id>] [--layer <layer>] [--suite <id>] [--verdict <v>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subjects [--kind <kind>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subject <subjectId> [--json]
  ocx lab observations [--subject <id>] [--layer <layer>] [--suite <id>] [--scenario <id>] [--outcome <o>] [--execution-mode <m>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab events [--event-kind <k>] [--subject <id>] [--from <ms>] [--to <ms>] [--excluded <true|false>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab event <eventId> [--json]
  ocx lab artifacts [--status <s>] [--artifact-class <c>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab artifact <digest> [--json]
  ocx lab catalog [--layer <layer>] [--suite <id>] [--json]
  ocx lab public preview --event <eventId> [--event <eventId> ...] [--json]
  ocx lab public export --event <eventId> [--event <eventId> ...] [--json]
  ocx lab public verify --file <bundle.json> [--json]
  ocx lab public import --file <bundle.json> [--json]
  ocx lab public community [--json]
  ocx lab automation status [--json]
  ocx lab automation enable [--protocol] [--live] [--json]
  ocx lab automation disable [--json]
  ocx lab automation runs [--limit <n>] [--cursor <c>] [--json]
  ocx lab run --layer <layer> --scenario <id> [--provider <name>] [--model <id>] [--json]`;

const ARTIFACT_STATUSES = ["present", "corrupt", "purged_unavailable"] as const;
type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export interface LabCliDeps {
  configDir?: string;
}

class LabStateError extends RuntimeApiError {
  constructor(message: string) {
    super(message, 503, null);
    this.name = "LabStateError";
  }
}

function labErrorMessage(err: unknown): string {
  if (err instanceof LabProjectionUnavailableError) return "lab projection is not available";
  if (err instanceof LabProjectionIncompatibleError) return "lab projection schema or spec version is incompatible";
  if (err instanceof InvalidCursorError) return "invalid cursor";
  if (err instanceof LabAutomationError && err.code === "invalid_cursor") return "invalid cursor";
  return "lab read failed";
}

function takeEnumOption<T extends string>(
  args: string[],
  flag: string,
  values: readonly T[],
  message: string,
): T | undefined {
  const raw = takeOption(args, flag);
  if (raw === undefined) return undefined;
  if (!(values as readonly string[]).includes(raw)) {
    throw new CliUsageError(message, USAGE);
  }
  return raw as T;
}

function assertRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && to !== undefined && from > to) {
    throw new CliUsageError("--from must not be greater than --to", USAGE);
  }
}

function appendPaginationHint(
  lines: string[],
  page: { hasMore: boolean; nextCursor?: string | null },
): void {
  if (page.hasMore) lines.push(`(more available; pass --cursor ${page.nextCursor ?? ""})`);
}

function statusSummary(status: ReturnType<typeof queryLabStatus>): string[] {
  if (!status.projectionAvailable) {
    if (status.projectionIncompatible) return ["Lab projection: incompatible"];
    return ["Lab projection: unavailable"];
  }
  return [
    "Lab projection: available",
    `SQLite schema: ${status.sqliteSchemaVersion}`,
    `Projection spec: ${status.projectionSpecVersion}`,
    `Built at: ${status.builtAtMs}`,
    `Events: ${status.eventCount} | Subjects: ${status.subjectCount} | Observations: ${status.observationCount}`,
    `Claims: ${status.claimCount} | Verdicts: ${status.verdictCount} | Artifacts: ${status.artifactCount}`,
    `Corruption rows: ${status.corruptionCount}`,
  ];
}

function verdictLines(page: ReturnType<typeof queryLabVerdicts>): string[] {
  const lines = page.items.map((v) =>
    `${v.verdict} ${v.evidenceLayer} ${v.suiteId} subject=${v.subjectId} asOf=${v.asOf}`,
  );
  appendPaginationHint(lines, page);
  return lines.length > 0 ? lines : ["No verdicts"];
}

function subjectListLines(page: ReturnType<typeof queryLabSubjects>): string[] {
  const lines = page.items.map((s) => `${s.subjectId} (${s.subjectKind})`);
  appendPaginationHint(lines, page);
  return lines.length > 0 ? lines : ["No subjects"];
}

function observationLines(page: ReturnType<typeof queryLabObservations>): string[] {
  const lines = page.items.map((o) =>
    `${o.outcome} ${o.evidenceLayer} ${o.scenarioId} event=${o.eventId} completed=${o.completedAt}`,
  );
  appendPaginationHint(lines, page);
  return lines.length > 0 ? lines : ["No observations"];
}

function eventListLines(page: ReturnType<typeof queryLabEvents>): string[] {
  const lines = page.items.map((e) =>
    `${e.eventKind} ${e.eventId} recorded=${e.recordedAt}${e.excluded ? " excluded" : ""}`,
  );
  appendPaginationHint(lines, page);
  return lines.length > 0 ? lines : ["No events"];
}

function artifactLines(page: ReturnType<typeof queryLabArtifacts>): string[] {
  const lines = page.items.map((a) => `${a.status} ${a.digest} class=${a.artifactClass ?? "unknown"}`);
  appendPaginationHint(lines, page);
  return lines.length > 0 ? lines : ["No artifacts"];
}

function catalogLines(scenarios: ReturnType<typeof queryLabCatalogEntries>): string[] {
  const lines = scenarios.map((s) =>
    `${s.evidenceLayer} ${s.suiteId} ${s.scenarioId} digest=${s.scenarioManifestDigest.slice(0, 12)}…`,
  );
  return lines.length > 0 ? lines : ["No catalog scenarios"];
}

function passiveProductionLines(result: PassiveProductionQueryResultV1): string[] {
  const summary = result.summary;
  return [
    "Observed production traffic (not Lab verification)",
    `Attempts: ${summary.recentProductionAttempts} | Successes: ${summary.recentSuccessfulAttempts} | Route errors: ${summary.recentRouteErrorSignals}`,
    ...(summary.lastObservedProductionAttempt !== undefined
      ? [`Last observed: ${summary.lastObservedProductionAttempt}`]
      : []),
  ];
}

function automationStatusLines(status: ReturnType<typeof buildLabAutomationStatus>): string[] {
  return [
    `Automation enabled: ${status.policy.enabled}`,
    `Scheduler intent: ${status.policy.enabled ? "enabled" : "disabled"}`,
    `Layers: protocol=${status.policy.layers.protocolConformance} live=${status.policy.layers.liveRouteCompatibility} task=${status.policy.layers.taskEffectiveness}`,
    `Queued: ${status.counters.queued} | Running: ${status.counters.running}`,
    `Run budget remaining: ${status.counters.remainingRunBudget} | Live request budget: ${status.counters.remainingLiveRequestBudget}`,
  ];
}

function automationCliStatus(status: ReturnType<typeof buildLabAutomationStatus>) {
  const { schedulerRunning: _processLocalSchedulerState, ...stable } = status;
  return { ...stable, schedulerIntentEnabled: status.policy.enabled };
}

function runListLines(page: ReturnType<typeof listLabAutomationRuns>): string[] {
  const lines = page.items.map((row) =>
    `${row.runId} ${row.state} ${row.evidenceLayer} ${row.scenarioId} trigger=${row.trigger}`,
  );
  return lines.length > 0 ? lines : ["No automation runs"];
}

function takeRepeatedOptions(args: string[], flag: string): string[] {
  const values: string[] = [];
  while (true) {
    const index = args.indexOf(flag);
    if (index < 0) break;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CliUsageError(`${flag} requires a value`, USAGE);
    }
    values.push(value);
    args.splice(index, 2);
  }
  return values;
}

function publicPreviewLines(result: ReturnType<typeof previewLocalPublicEvidence>): string[] {
  return [
    `Public evidence preview: ${result.bundle.records.length} exportable record(s)`,
    `Excluded: ${result.excluded.length}`,
    "Unsigned local preview; no publisher key or remote publish is created.",
  ];
}

function publicExportLines(result: ReturnType<typeof exportLocalPublicEvidence>): string[] {
  return [
    "Public evidence exported locally",
    `Bundle: ${result.bundle.bundleId}`,
    `Publisher: ${result.bundle.publisher.keyId}`,
    `Path: ${result.stored.path}`,
    `Excluded: ${result.excluded.length}`,
    "No remote publish occurred.",
  ];
}

function publicVerificationLines(result: PublicVerificationSummaryV1): string[] {
  if (result.status !== "cryptographically_valid") {
    return [
      `Public evidence verification: ${result.status}`,
      "Not locally verified.",
    ];
  }
  return [
    "Public evidence verification: cryptographically valid",
    `Bundle: ${result.bundleId}`,
    `Publisher: ${result.publisherKeyId}`,
    "Not locally verified. Signature validity proves integrity/continuity only.",
  ];
}

function handlePublicLabCommand(
  argv: string[],
  wantsJson: boolean,
  configDir: string,
): void {
  const [action, ...restInput] = argv;
  const rest = [...restInput];
  switch (action) {
    case "preview": {
      const eventIds = takeRepeatedOptions(rest, "--event");
      rejectArgs(rest, USAGE);
      const result = previewLocalPublicEvidence({ eventIds }, configDir);
      printData(result, wantsJson, publicPreviewLines(result));
      return;
    }
    case "export": {
      const eventIds = takeRepeatedOptions(rest, "--event");
      rejectArgs(rest, USAGE);
      const result = exportLocalPublicEvidence({ eventIds }, configDir);
      printData(result, wantsJson, publicExportLines(result));
      return;
    }
    case "verify": {
      const path = takeOption(rest, "--file");
      if (!path) throw new CliUsageError("public verify requires --file", USAGE);
      rejectArgs(rest, USAGE);
      const result = verifyPublicEvidenceFile(path);
      printData(result, wantsJson, publicVerificationLines(result));
      if (result.status !== "cryptographically_valid") {
        throw new RuntimeApiError(`public evidence verification failed: ${result.status}`, 422, result);
      }
      return;
    }
    case "import": {
      const path = takeOption(rest, "--file");
      if (!path) throw new CliUsageError("public import requires --file", USAGE);
      rejectArgs(rest, USAGE);
      const result = importCommunityEvidenceFile(path, configDir);
      printData(result, wantsJson, [
        `Community evidence imported: ${result.bundleId}`,
        `Publisher: ${result.publisherKeyId}`,
        "Trust: community_untrusted_v1; not locally verified.",
      ]);
      return;
    }
    case "community": {
      rejectArgs(rest, USAGE);
      const result = listCommunityEvidenceContext(configDir);
      const lines = result.evidence.length > 0
        ? result.evidence.map((row) =>
          `${row.bundleId} publisher=${row.publisherKeyId} active=${row.activeRecordCount} revoked=${row.revokedRecordCount}`,
        )
        : ["No community evidence"];
      printData(result, wantsJson, [
        "Community evidence (untrusted, read-only context; not locally verified)",
        ...lines,
      ]);
      return;
    }
    default:
      throw new CliUsageError("unknown public subcommand", USAGE);
  }
}

export async function handleLabCommand(argv: string[], deps: LabCliDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const configDir = deps.configDir ?? getConfigDir();
    const argvCopy = [...argv];
    const wantsJson = takeFlag(argvCopy, "--json");
    const [sub = "status", ...rest] = argvCopy;

    try {
      switch (sub) {
        case "public": {
          handlePublicLabCommand(rest, wantsJson, configDir);
          return;
        }
        case "status": {
          rejectArgs(rest, USAGE);
          const status = queryLabStatus(configDir);
          printData(status, wantsJson, statusSummary(status));
          return;
        }
        case "production-signals": {
          const subjectId = takeOption(rest, "--subject");
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          rejectArgs(rest, USAGE);
          if (!subjectId) throw new CliUsageError("--subject is required", USAGE);
          if (!isLabRouteSubjectId(subjectId)) {
            throw new CliUsageError("--subject must be an exact Lab route subject id", USAGE);
          }
          const result = queryPassiveProductionSignals(subjectId, limit, configDir);
          printData(result, wantsJson, passiveProductionLines(result));
          return;
        }
        case "verdicts": {
          const subjectId = takeOption(rest, "--subject");
          const layer = takeEnumOption<EvidenceLayer>(
            rest,
            "--layer",
            EVIDENCE_LAYERS,
            "--layer must be a supported evidence layer",
          );
          const suiteId = takeOption(rest, "--suite");
          const verdict = takeEnumOption<CompatibilityVerdict>(
            rest,
            "--verdict",
            VERDICTS,
            "--verdict must be a supported compatibility verdict",
          );
          const from = takeIntegerOption(rest, "--from", { min: 0 });
          const to = takeIntegerOption(rest, "--to", { min: 0 });
          assertRange(from, to);
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabVerdicts({ subjectId, layer, suiteId, verdict, from, to }, cursor, limit, configDir);
          printData(page, wantsJson, verdictLines(page));
          return;
        }
        case "subjects": {
          const kind = takeOption(rest, "--kind");
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabSubjects(kind, cursor, limit, configDir);
          printData(page, wantsJson, subjectListLines(page));
          return;
        }
        case "subject": {
          const subjectId = rest[0];
          if (!subjectId) throw new CliUsageError("subject id required", USAGE);
          rest.splice(0, 1);
          rejectArgs(rest, USAGE);
          const subject = queryLabSubjectById(subjectId, configDir);
          if (!subject) throw new CliUsageError("unknown subject", USAGE);
          printData({ subject }, wantsJson, [`Subject ${subjectId}`]);
          return;
        }
        case "observations": {
          const subjectId = takeOption(rest, "--subject");
          const layer = takeEnumOption<EvidenceLayer>(rest, "--layer", EVIDENCE_LAYERS, "--layer must be a supported evidence layer");
          const suiteId = takeOption(rest, "--suite");
          const scenarioId = takeOption(rest, "--scenario");
          const outcome = takeEnumOption<ObservationOutcome>(rest, "--outcome", OUTCOMES, "--outcome must be a supported observation outcome");
          const executionMode = takeEnumOption<ExecutionMode>(rest, "--execution-mode", EXECUTION_MODES, "--execution-mode must be a supported execution mode");
          const from = takeIntegerOption(rest, "--from", { min: 0 });
          const to = takeIntegerOption(rest, "--to", { min: 0 });
          assertRange(from, to);
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabObservations({ subjectId, layer, suiteId, scenarioId, outcome, executionMode, from, to }, cursor, limit, configDir);
          printData(page, wantsJson, observationLines(page));
          return;
        }
        case "events": {
          const eventKind = takeEnumOption<LabEventKind>(rest, "--event-kind", EVENT_KINDS, "--event-kind must be a supported lab event kind");
          const subjectId = takeOption(rest, "--subject");
          const from = takeIntegerOption(rest, "--from", { min: 0 });
          const to = takeIntegerOption(rest, "--to", { min: 0 });
          assertRange(from, to);
          const excludedRaw = takeOption(rest, "--excluded");
          if (excludedRaw !== undefined && excludedRaw !== "true" && excludedRaw !== "false") {
            throw new CliUsageError("--excluded must be true or false", USAGE);
          }
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabEvents({
            eventKind,
            subjectId,
            from,
            to,
            excluded: excludedRaw === "true" ? true : excludedRaw === "false" ? false : undefined,
          }, cursor, limit, configDir);
          printData(page, wantsJson, eventListLines(page));
          return;
        }
        case "event": {
          const eventId = rest[0];
          if (!eventId) throw new CliUsageError("event id required", USAGE);
          rest.splice(0, 1);
          rejectArgs(rest, USAGE);
          const event = queryLabEventById(eventId, configDir);
          if (!event) throw new CliUsageError("unknown event", USAGE);
          printData({ event }, wantsJson, [`Event ${eventId}`]);
          return;
        }
        case "artifacts": {
          const status = takeEnumOption<ArtifactStatus>(rest, "--status", ARTIFACT_STATUSES, "--status must be present, corrupt, or purged_unavailable");
          const artifactClass = takeEnumOption<ArtifactClass>(rest, "--artifact-class", ARTIFACT_CLASSES, "--artifact-class must be a supported artifact class");
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabArtifacts({ status, artifactClass }, cursor, limit, configDir);
          printData(page, wantsJson, artifactLines(page));
          return;
        }
        case "artifact": {
          const digest = rest[0];
          if (!digest) throw new CliUsageError("artifact digest required", USAGE);
          rest.splice(0, 1);
          rejectArgs(rest, USAGE);
          const artifact = queryLabArtifactByDigest(digest, configDir);
          if (!artifact) throw new CliUsageError("unknown artifact", USAGE);
          printData({ artifact }, wantsJson, [`Artifact ${digest}`]);
          return;
        }
        case "catalog": {
          const layer = takeEnumOption<EvidenceLayer>(rest, "--layer", EVIDENCE_LAYERS, "--layer must be a supported evidence layer");
          const suiteId = takeOption(rest, "--suite");
          rejectArgs(rest, USAGE);
          const scenarios = queryLabCatalogEntries({ layer, suiteId });
          printData({ scenarios }, wantsJson, catalogLines(scenarios));
          return;
        }
        case "automation": {
          const [automationSub = "status", ...automationRest] = rest;
          switch (automationSub) {
            case "status": {
              rejectArgs(automationRest, USAGE);
              const status = buildLabAutomationStatus(configDir);
              printData(automationCliStatus(status), wantsJson, automationStatusLines(status));
              return;
            }
            case "enable": {
              const enableProtocol = takeFlag(automationRest, "--protocol");
              const enableLive = takeFlag(automationRest, "--live");
              rejectArgs(automationRest, USAGE);
              const selectionExplicit = enableProtocol || enableLive;
              const current = loadLabAutomationConfig(configDir).policy;
              const policy = {
                ...current,
                enabled: true,
                layers: {
                  protocolConformance: selectionExplicit ? enableProtocol : current.layers.protocolConformance,
                  liveRouteCompatibility: selectionExplicit ? enableLive : current.layers.liveRouteCompatibility,
                  taskEffectiveness: false,
                },
                taskEffectivenessBackgroundEnabled: false,
              };
              saveLabAutomationPolicyConfig(policy, configDir);
              reconcileLabAutomationQueue(configDir);
              startLabAutomationScheduler(configDir);
              const status = buildLabAutomationStatus(configDir);
              printData(automationCliStatus(status), wantsJson, automationStatusLines(status));
              return;
            }
            case "disable": {
              rejectArgs(automationRest, USAGE);
              const policy = { ...loadLabAutomationConfig(configDir).policy, enabled: false };
              saveLabAutomationPolicyConfig(policy, configDir);
              reconcileLabAutomationQueue(configDir);
              stopLabAutomationScheduler(configDir);
              const status = buildLabAutomationStatus(configDir);
              printData(automationCliStatus(status), wantsJson, automationStatusLines(status));
              return;
            }
            case "runs": {
              const limit = takeIntegerOption(automationRest, "--limit", { min: 1 });
              const cursor = takeOption(automationRest, "--cursor");
              rejectArgs(automationRest, USAGE);
              const page = listLabAutomationRuns(loadLabAutomationState(configDir), limit ?? 50, cursor);
              printData(page, wantsJson, runListLines(page));
              return;
            }
            default:
              throw new CliUsageError(`unknown automation subcommand: ${automationSub}`, USAGE);
          }
        }
        case "run": {
          const layer = takeEnumOption<LabAutomationLayer>(
            rest,
            "--layer",
            ["protocol_conformance", "live_route_compatibility", "task_effectiveness"] as const,
            "--layer must be protocol_conformance, live_route_compatibility, or task_effectiveness",
          );
          const scenarioId = takeOption(rest, "--scenario");
          const providerName = takeOption(rest, "--provider");
          const modelId = takeOption(rest, "--model");
          rejectArgs(rest, USAGE);
          if (!layer || !scenarioId) throw new CliUsageError("--layer and --scenario are required", USAGE);
          const configSnapshot = readConfigDiagnostics().config;
          if (layer === "live_route_compatibility") {
            const loadConfig = () => configSnapshot;
            setLabAutomationDispatchDeps({
              configDir,
              loadConfig,
              routeExecutor: createProductionLabRouteExecutor({ configDir, loadConfig }),
            });
          }
          const planned = planManualLabRun({
            evidenceLayer: layer,
            scenarioId,
            providerName,
            modelId,
            config: configSnapshot,
            configDir,
          });
          const record = await enqueueManualLabRun(planned, configDir);
          if (!record) throw new CliUsageError("manual run enqueue failed", USAGE);
          printData({ run: record }, wantsJson, [`Manual run ${record.runId} -> ${record.state}`]);
          return;
        }
        default:
          throw new CliUsageError(`unknown lab subcommand: ${sub}`, USAGE);
      }
    } catch (err) {
      if (err instanceof CliUsageError || err instanceof RuntimeApiError) throw err;
      if (err instanceof LabProjectionUnavailableError || err instanceof LabProjectionIncompatibleError) {
        throw new LabStateError(labErrorMessage(err));
      }
      throw new CliUsageError(labErrorMessage(err), USAGE);
    }
  });
}

export const LAB_USAGE = USAGE;