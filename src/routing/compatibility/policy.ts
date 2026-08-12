import type { CompatibilityVerdict } from "../../lab/constants";
import type { NormalizedRoutingProfileCompatibility } from "../profile";
import type {
  CandidateCompatibilityEvidence,
  CompatibilityEvaluationOutcome,
} from "./types";
import { COMPATIBILITY_UNKNOWN_PENALTY_SCORE, MAX_TRACE_COMPATIBILITY_SUITES } from "./types";
import type { RouteCompatibilityEvidence } from "../trace";

function positiveThresholdMet(
  verdict: CompatibilityVerdict,
  minStatus: "PROBED" | "VERIFIED" | undefined,
): boolean {
  if (!minStatus) return true;
  if (minStatus === "PROBED") return verdict === "PROBED" || verdict === "VERIFIED";
  return verdict === "VERIFIED";
}

function effectiveMaxAgeMs(
  catalogMaxAgeMs: number | null,
  profileMaxAgeMs: number | undefined,
): number | null {
  if (catalogMaxAgeMs === null) return profileMaxAgeMs ?? null;
  if (profileMaxAgeMs === undefined) return catalogMaxAgeMs;
  return Math.min(catalogMaxAgeMs, profileMaxAgeMs);
}

function mergePenalty(current: number | null, next: number | null): number | null {
  if (current === null) return next;
  if (next === null) return current;
  return Math.min(current, next);
}

function applyUnknownPolicy(
  policy: NormalizedRoutingProfileCompatibility["unknownEvidence"],
  code: string,
  detail: string,
): Pick<CompatibilityEvaluationOutcome, "exclusions" | "penaltyScore"> {
  if (policy === "exclude") {
    return { exclusions: [{ code, detail }], penaltyScore: null };
  }
  if (policy === "penalize") {
    return { exclusions: [], penaltyScore: COMPATIBILITY_UNKNOWN_PENALTY_SCORE };
  }
  return { exclusions: [], penaltyScore: null };
}

export function evaluateCompatibilityForCandidate(
  policy: NormalizedRoutingProfileCompatibility | undefined,
  evidence: CandidateCompatibilityEvidence | undefined,
  now = Date.now(),
): CompatibilityEvaluationOutcome & { trace?: RouteCompatibilityEvidence } {
  const outcome: CompatibilityEvaluationOutcome = {
    exclusions: [],
    penaltyScore: null,
    suiteTraces: [],
    traceTruncated: false,
  };
  if (!policy || policy.requiredSuites.length === 0) return outcome;

  const pushTrace = (entry: CompatibilityEvaluationOutcome["suiteTraces"][number]): void => {
    if (outcome.suiteTraces.length < MAX_TRACE_COMPATIBILITY_SUITES) {
      outcome.suiteTraces.push(entry);
    } else {
      outcome.traceTruncated = true;
    }
  };

  let penaltyScore: number | null = null;
  for (const requirement of policy.requiredSuites) {
    const subjectId = evidence?.subjectIds[requirement.evidenceLayer];
    const row = evidence?.suites.find(suite =>
      suite.subjectId === subjectId
      && suite.suiteId === requirement.suiteId
      && suite.evidenceLayer === requirement.evidenceLayer);
    const maxAgeMs = row
      ? effectiveMaxAgeMs(row.maxAgeMs, policy.maxEvidenceAgeMs)
      : policy.maxEvidenceAgeMs ?? null;
    const ageMs = row ? now - row.asOf : Number.POSITIVE_INFINITY;
    const fresh = row ? ageMs >= 0 && (maxAgeMs === null || ageMs <= maxAgeMs) : false;
    const verdict = row?.verdict;

    const trace = {
      suiteId: requirement.suiteId,
      evidenceLayer: requirement.evidenceLayer,
      ...(subjectId ? { subjectIdPrefix: subjectId.slice(0, 16) } : {}),
      ...(verdict ? { verdict } : {}),
      ...(policy.minStatus ? { minStatus: policy.minStatus } : {}),
      fresh,
      unknownPolicy: policy.unknownEvidence,
      degradedPolicy: policy.degradedEvidence,
      outcome: "unknown" as const,
    };

    if (!subjectId) {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      pushTrace({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore !== null ? "penalized" : "unknown",
        reason: "subject-unresolved",
      });
      continue;
    }

    if (!evidence?.projectionAvailable) {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      pushTrace({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore !== null ? "penalized" : "unknown",
        reason: "projection-unavailable",
      });
      continue;
    }

    if (!row || !fresh) {
      const applied = applyUnknownPolicy(
        policy.unknownEvidence,
        row && !fresh ? "compatibility-stale" : "compatibility-unknown",
        requirement.suiteId,
      );
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      pushTrace({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore !== null ? "penalized" : "unknown",
        reason: !row ? "missing-evidence" : "stale-evidence",
      });
      continue;
    }

    if (verdict === "UNSUPPORTED") {
      outcome.exclusions.push({ code: "compatibility-unsupported", detail: requirement.suiteId });
      pushTrace({ ...trace, outcome: "excluded", reason: "unsupported" });
      continue;
    }

    if (verdict === "DEGRADED") {
      if (policy.degradedEvidence === "exclude") {
        outcome.exclusions.push({ code: "compatibility-degraded", detail: requirement.suiteId });
        pushTrace({ ...trace, outcome: "excluded", reason: "degraded" });
      } else if (policy.degradedEvidence === "penalize") {
        penaltyScore = mergePenalty(penaltyScore, COMPATIBILITY_UNKNOWN_PENALTY_SCORE);
        pushTrace({ ...trace, outcome: "penalized", reason: "degraded" });
      } else {
        pushTrace({ ...trace, outcome: "satisfied", reason: "degraded-allowed" });
      }
      continue;
    }

    if (verdict === "UNKNOWN" || verdict === "CLAIMED" || verdict === "BLOCKED") {
      const applied = applyUnknownPolicy(policy.unknownEvidence, "compatibility-unknown", requirement.suiteId);
      outcome.exclusions.push(...applied.exclusions);
      penaltyScore = mergePenalty(penaltyScore, applied.penaltyScore);
      pushTrace({
        ...trace,
        outcome: applied.exclusions.length ? "excluded" : applied.penaltyScore !== null ? "penalized" : "unknown",
        reason: verdict.toLowerCase(),
      });
      continue;
    }

    if (!positiveThresholdMet(verdict!, policy.minStatus)) {
      outcome.exclusions.push({ code: "compatibility-insufficient", detail: requirement.suiteId });
      pushTrace({ ...trace, outcome: "excluded", reason: "below-min-status" });
      continue;
    }

    pushTrace({ ...trace, outcome: "satisfied", reason: "threshold-met" });
  }

  outcome.penaltyScore = penaltyScore;
  const trace: RouteCompatibilityEvidence = {
    suites: outcome.suiteTraces,
    ...(outcome.traceTruncated ? { truncated: true } : {}),
  };
  return { ...outcome, trace };
}
