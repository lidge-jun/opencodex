/** Explicit create/replace/delete for routing profiles; contextual validation stays server-owned. */
import { isValidPolicyId } from "../routing/profile";
import { printCatalogResult, runCatalogAction } from "./catalog-command-result";
import { readJsonInput, serializeManagementJson } from "./json-input";
import { CliUsageError, runtimeBaseUrl, runtimeRequest, takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage:
  ocx route policy create <id> --file <profile.json|-> [--json]
  ocx route policy update <id> --file <profile.json|-> --expected-revision <revision> [--json]
  ocx route policy remove <id> --yes [--json]`;
const ERRORS: Readonly<Record<string, string>> = {
  profile_exists: "Routing profile already exists. Use show and review an explicit update.",
  profile_revision_conflict: "Routing profile changed. Read show again and review the changes before updating with its revision.",
  unknown_profile: "Routing profile was not found on the selected target.",
  invalid_profile: "The target refused the profile. Check its candidates, alias and policy settings against the target configuration.",
  missing_profile_id: "A routing profile id is required.",
  invalid_profile_mode: "The target refused the routing profile operation.",
  alias_reference_conflict: "The alias change conflicts with existing model references. Resolve the conflicting mappings first.",
  invalid_shadow_call_target: "The alias change would create an invalid shadow-call target. Inspect its routing references first.",
};
const PROFILE_KEYS = ["alias", "candidates", "require", "optimize", "limits", "unknownEvidence", "compatibility"];
const REQUIRE_KEYS = ["minContextWindow", "minQuotaHeadroom", "tools", "imageInput", "structuredOutput", "reasoningEffort", "serviceTier", "localOnly", "remoteAllowed", "encryptedCodexTasks"];
const WEIGHT_KEYS = ["latency", "health", "cost", "quota"];
const UNKNOWN_KEYS = ["capability", "health", "quota", "cost"];
const COMPATIBILITY_KEYS = ["requiredSuites", "minStatus", "maxEvidenceAgeMs", "unknownEvidence", "degradedEvidence"];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function only(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every(key => keys.includes(key));
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function evidence(value: unknown): boolean { return value === "allow" || value === "penalize" || value === "exclude"; }
function optionalFields(value: Record<string, unknown>, validators: Record<string, (value: unknown) => boolean>): boolean {
  return Object.entries(validators).every(([key, accepts]) => !Object.hasOwn(value, key) || accepts(value[key]));
}

/** Shape/ownership only: do not invent a provider configuration to run contextual validators. */
function editableProfile(value: unknown): value is Record<string, unknown> {
  if (!only(value, PROFILE_KEYS) || !Array.isArray(value.candidates) || !value.candidates.length
    || !value.candidates.every(candidate => only(candidate, ["provider", "model"]) && text(candidate.provider) && text(candidate.model))) return false;
  if (Object.hasOwn(value, "alias") && typeof value.alias !== "string") return false;
  if (Object.hasOwn(value, "require")) {
    const required = value.require;
    if (!only(required, REQUIRE_KEYS) || !optionalFields(required, {
      minContextWindow: n => Number.isSafeInteger(n) && (n as number) > 0,
      minQuotaHeadroom: n => nonnegative(n) && n <= 1,
      reasoningEffort: n => typeof n === "string", serviceTier: n => typeof n === "string",
    })) return false;
    for (const key of ["tools", "imageInput", "structuredOutput", "localOnly", "remoteAllowed", "encryptedCodexTasks"]) {
      if (Object.hasOwn(required, key) && typeof required[key] !== "boolean") return false;
    }
  }
  if (Object.hasOwn(value, "optimize") && (!only(value.optimize, WEIGHT_KEYS) || !Object.values(value.optimize).every(nonnegative))) return false;
  if (Object.hasOwn(value, "limits") && (!only(value.limits, ["maxEstimatedCostUsd", "onUnknownCost"])
    || !optionalFields(value.limits, { maxEstimatedCostUsd: nonnegative, onUnknownCost: n => n === "allow" || n === "exclude" }))) return false;
  if (Object.hasOwn(value, "unknownEvidence") && (!only(value.unknownEvidence, UNKNOWN_KEYS) || !Object.values(value.unknownEvidence).every(evidence))) return false;
  if (Object.hasOwn(value, "compatibility")) {
    const compatibility = value.compatibility;
    if (!only(compatibility, COMPATIBILITY_KEYS) || !optionalFields(compatibility, {
      requiredSuites: n => Array.isArray(n) && n.every(suite => only(suite, ["suiteId", "evidenceLayer"])
        && text(suite.suiteId) && ["protocol_conformance", "live_route_compatibility"].includes(suite.evidenceLayer as string)),
      minStatus: n => n === "PROBED" || n === "VERIFIED",
      maxEvidenceAgeMs: n => Number.isSafeInteger(n) && (n as number) >= 0,
      unknownEvidence: evidence, degradedEvidence: evidence,
    })) return false;
  }
  return true;
}

function invalidResult(): never { throw new Error("Invalid routing profile result"); }

function projectProfile(value: unknown, id: string, model: unknown): Record<string, unknown> {
  if (!only(value, [...PROFILE_KEYS, "id", "model", "revision"]) || value.id !== id
    || !text(value.revision) || !text(model) || value.model !== model
    || (value.alias !== null && !text(value.alias))) invalidResult();
  const { id: _id, model: _model, revision: _revision, alias, ...editable } = value;
  const input = { ...editable, ...(alias === null ? {} : { alias }) };
  if (!editableProfile(input) || model !== (alias ?? `policy/${id}`)
    || !record(value.require) || !record(value.limits)
    || !record(value.optimize) || !WEIGHT_KEYS.every(key => Object.hasOwn(value.optimize as object, key))
    || !record(value.unknownEvidence) || !UNKNOWN_KEYS.every(key => Object.hasOwn(value.unknownEvidence as object, key))) invalidResult();
  if (value.compatibility !== undefined && (!record(value.compatibility)
    || !Array.isArray(value.compatibility.requiredSuites) || !evidence(value.compatibility.unknownEvidence)
    || !evidence(value.compatibility.degradedEvidence))) invalidResult();
  // Every nested field was admitted above; rebuild the envelope rather than echoing server metadata.
  return { id, model, revision: value.revision, alias, ...editable };
}

function printResult(value: unknown, id: string, remove: boolean, wantsJson: boolean): number {
  if (!only(value, remove ? ["success", "id", "catalogRefresh"] : ["success", "id", "model", "profile", "catalogRefresh"])
    || value.success !== true || value.id !== id) invalidResult();
  const data: Record<string, unknown> = { success: true, id };
  const lines = [remove ? `Removed routing profile: ${id}` : `Saved routing profile: ${id}`];
  if (!remove) {
    data.profile = projectProfile(value.profile, id, value.model);
    data.model = value.model;
    lines.push(`Model: ${value.model}`, `Revision: ${(data.profile as Record<string, unknown>).revision}`);
  }
  return printCatalogResult(data, value.catalogRefresh, wantsJson, lines);
}

export async function handleRoutePolicyWriteCommand(
  sub: "create" | "update" | "remove", argv: string[], deps: RuntimeApiDeps = {},
): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const id = args.shift();
    if (!id || !isValidPolicyId(id)) throw new CliUsageError("A valid exact routing profile id is required (letters, numbers, dot, underscore or hyphen; max 64).", USAGE);
    const wantsJson = takeFlag(args, "--json");
    const yes = takeFlag(args, "--yes");
    const file = takeOptionWithSyntax(args, "--file")?.value;
    const revision = takeOptionWithSyntax(args, "--expected-revision")?.value;
    if (args.length) throw new CliUsageError("Unknown, repeated or unexpected routing profile arguments.", USAGE);
    if (sub === "remove") {
      if (!yes || file !== undefined || revision !== undefined) throw new CliUsageError("Removal requires --yes and does not accept a file or revision.", USAGE);
    } else {
      if (yes || !file?.trim()) throw new CliUsageError("Creation and update require --file and do not accept --yes.", USAGE);
      if (sub === "update" ? !revision?.trim() : revision !== undefined) throw new CliUsageError("Update requires an explicit nonblank --expected-revision; create does not accept it.", USAGE);
    }
    let body: string | undefined;
    if (sub !== "remove") {
      const profile = await readJsonInput(file!, deps);
      if (!editableProfile(profile)) throw new CliUsageError("Profile file must contain only editable routing fields with valid nested types; omit id, model and revision.", USAGE);
      body = serializeManagementJson({ id, mode: sub, profile, ...(sub === "update" ? { expectedRevision: revision } : {}) });
    }
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const result = await runtimeRequest(sub === "remove" ? `/api/routing-profiles?id=${encodeURIComponent(id)}` : "/api/routing-profiles", {
      method: sub === "remove" ? "DELETE" : "PUT", redirect: "error",
      ...(body !== undefined ? { headers: { "content-type": "application/json" }, body } : {}),
    }, pinned);
    return printResult(result, id, sub === "remove", wantsJson);
  }, ERRORS);
}
