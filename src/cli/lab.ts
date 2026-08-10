/**
 * `ocx lab` — read-only Compatibility Lab inspection (CL-04).
 *
 * Local SQLite projection reads; no daemon, network, probes, or rebuilds.
 */
import { getConfigDir } from "../config";
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
} from "../lab/query";
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

const USAGE = `Usage:
  ocx lab status [--json]
  ocx lab verdicts [--subject <id>] [--layer <layer>] [--suite <id>] [--verdict <v>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subjects [--kind <kind>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab subject <subjectId> [--json]
  ocx lab observations [--subject <id>] [--layer <layer>] [--suite <id>] [--scenario <id>] [--outcome <o>] [--execution-mode <m>] [--from <ms>] [--to <ms>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab events [--event-kind <k>] [--subject <id>] [--from <ms>] [--to <ms>] [--excluded <true|false>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab event <eventId> [--json]
  ocx lab artifacts [--status <s>] [--artifact-class <c>] [--limit <n>] [--cursor <c>] [--json]
  ocx lab artifact <digest> [--json]
  ocx lab catalog [--layer <layer>] [--suite <id>] [--json]`;

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

export async function handleLabCommand(argv: string[], deps: LabCliDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const configDir = deps.configDir ?? getConfigDir();
    const argvCopy = [...argv];
    const wantsJson = takeFlag(argvCopy, "--json");
    const [sub = "status", ...rest] = argvCopy;

    try {
      switch (sub) {
        case "status": {
          rejectArgs(rest, USAGE);
          const status = queryLabStatus(configDir);
          printData(status, wantsJson, statusSummary(status));
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
          const page = queryLabVerdicts({
            subjectId,
            layer,
            suiteId,
            verdict,
            from,
            to,
          }, cursor, limit, configDir);
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
          const layer = takeEnumOption<EvidenceLayer>(
            rest,
            "--layer",
            EVIDENCE_LAYERS,
            "--layer must be a supported evidence layer",
          );
          const suiteId = takeOption(rest, "--suite");
          const scenarioId = takeOption(rest, "--scenario");
          const outcome = takeEnumOption<ObservationOutcome>(
            rest,
            "--outcome",
            OUTCOMES,
            "--outcome must be a supported observation outcome",
          );
          const executionMode = takeEnumOption<ExecutionMode>(
            rest,
            "--execution-mode",
            EXECUTION_MODES,
            "--execution-mode must be a supported execution mode",
          );
          const from = takeIntegerOption(rest, "--from", { min: 0 });
          const to = takeIntegerOption(rest, "--to", { min: 0 });
          assertRange(from, to);
          const limit = takeIntegerOption(rest, "--limit", { min: 1 });
          const cursor = takeOption(rest, "--cursor");
          rejectArgs(rest, USAGE);
          const page = queryLabObservations({
            subjectId,
            layer,
            suiteId,
            scenarioId,
            outcome,
            executionMode,
            from,
            to,
          }, cursor, limit, configDir);
          printData(page, wantsJson, observationLines(page));
          return;
        }
        case "events": {
          const eventKind = takeEnumOption<LabEventKind>(
            rest,
            "--event-kind",
            EVENT_KINDS,
            "--event-kind must be a supported lab event kind",
          );
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
          const status = takeEnumOption<ArtifactStatus>(
            rest,
            "--status",
            ARTIFACT_STATUSES,
            "--status must be present, corrupt, or purged_unavailable",
          );
          const artifactClass = takeEnumOption<ArtifactClass>(
            rest,
            "--artifact-class",
            ARTIFACT_CLASSES,
            "--artifact-class must be a supported artifact class",
          );
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
          const layer = takeEnumOption<EvidenceLayer>(
            rest,
            "--layer",
            EVIDENCE_LAYERS,
            "--layer must be a supported evidence layer",
          );
          const suiteId = takeOption(rest, "--suite");
          rejectArgs(rest, USAGE);
          const scenarios = queryLabCatalogEntries({ layer, suiteId });
          printData({ scenarios }, wantsJson, catalogLines(scenarios));
          return;
        }
        default:
          throw new CliUsageError(`unknown lab subcommand: ${sub}`, USAGE);
      }
    } catch (err) {
      if (err instanceof CliUsageError) throw err;
      if (err instanceof LabProjectionUnavailableError || err instanceof LabProjectionIncompatibleError) {
        throw new LabStateError(labErrorMessage(err));
      }
      throw new CliUsageError(labErrorMessage(err), USAGE);
    }
  });
}

export const LAB_USAGE = USAGE;
