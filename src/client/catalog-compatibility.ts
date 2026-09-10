/**
 * #4207: a connected client reported `connected` with a present, freshly synced catalog while
 * its installed Codex CLI exited before making a request, because the hub's catalog contained a
 * reasoning level that CLI does not know:
 *
 *   failed to parse model_catalog_json ... unknown variant `max`,
 *   expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
 *
 * The connection state answered a different question from the one the operator was asking. It
 * proved the hub was reachable and the credential worked; it never proved the selected local
 * runtime could consume what was downloaded. This module supplies the missing half, and the
 * connect path fails closed on it: an incompatible catalog is refused before it is written, so
 * the previous known-good file survives and no success is reported.
 *
 * What it deliberately does not do: rewrite the hub's catalog into a locally compatible
 * projection (the client would then silently disagree with hub truth) and terminate running
 * Codex processes. Both are ruled out by the issue.
 */
import { catalogEffortCompatibility, codexSupportedReasoningEfforts } from "../codex/catalog/effort";
import type { RawEntry } from "../codex/catalog/parsing";

export type ClientCatalogCompatibility =
  | { kind: "compatible" }
  /** The runtime ladder could not be observed, so incompatibility cannot be established. */
  | { kind: "unverified"; reason: string }
  | {
    kind: "incompatible";
    unsupportedEfforts: readonly string[];
    affectedModels: readonly string[];
  };

export interface CatalogCompatibilityDeps {
  /** Injected in tests; defaults to observing the selected local Codex runtime. */
  supportedEfforts?: () => ReadonlySet<string> | null;
}

/** State of the materialized client catalog file, as `ocx connect status` already reports it. */
export type ClientCatalogFileState = "present" | "missing" | "unsafe";

/**
 * Whether the selected local Codex runtime can consume the catalog that is *already on disk* —
 * a different question from the write-time gate, and the one #4207 was actually asking.
 *
 * The gate runs once, on bytes about to be written. It cannot speak for a file that predates it,
 * for a file written while the ladder was {@link ClientCatalogCompatibility} `unverified`, or for
 * a runtime that was swapped after the write. Those are exactly the states that kept reporting
 * `connected` while `codex exec` died on `unknown variant \`max\``.
 *
 * Only `ready` means ready. `unverified` is not `incompatible`: a client machine may legitimately
 * have no observable Codex CLI, and calling that an incompatibility would condemn a working
 * install on absent evidence — the same mistake the write-time gate refuses to make.
 */
export type ClientCatalogReadiness =
  | { kind: "ready" }
  | { kind: "unverified"; reason: string }
  | {
    kind: "incompatible";
    reason: string;
    unsupportedEfforts: readonly string[];
    affectedModels: readonly string[];
  };

function parseModels(body: string): RawEntry[] | null {
  try {
    const parsed = JSON.parse(body) as { models?: unknown };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Array.isArray(parsed.models) ? parsed.models as RawEntry[] : [];
  } catch {
    return null;
  }
}

/**
 * Assess a downloaded catalog against the reasoning efforts the selected local Codex runtime
 * accepts. Unreadable bytes are reported as unverified rather than incompatible: the hub
 * client already rejects a malformed body, and inventing a second cause for it here would
 * repeat the mistake #4169 was filed for.
 */
export function assessClientCatalogCompatibility(
  body: string,
  deps: CatalogCompatibilityDeps = {},
): ClientCatalogCompatibility {
  const models = parseModels(body);
  if (!models) return { kind: "unverified", reason: "the downloaded catalog could not be read" };
  const supported = (deps.supportedEfforts ?? (() => codexSupportedReasoningEfforts()))();
  if (!supported) {
    return {
      kind: "unverified",
      reason: "the selected local Codex runtime did not report the reasoning levels it supports",
    };
  }
  const result = catalogEffortCompatibility(models, supported);
  if (result.compatible) return { kind: "compatible" };
  return {
    kind: "incompatible",
    unsupportedEfforts: result.unsupportedEfforts,
    affectedModels: result.affectedModels,
  };
}

/**
 * Raised instead of writing an incompatible catalog. It names both remedies the issue asks
 * for, because the operator cannot act on "incompatible" alone, and it never suggests editing
 * the hub.
 */
export class ClientCatalogIncompatibleError extends Error {
  readonly unsupportedEfforts: readonly string[];
  readonly affectedModels: readonly string[];

  constructor(unsupportedEfforts: readonly string[], affectedModels: readonly string[]) {
    const efforts = unsupportedEfforts.join(", ");
    const models = affectedModels.length > 3
      ? `${affectedModels.slice(0, 3).join(", ")} and ${affectedModels.length - 3} more`
      : affectedModels.join(", ");
    super(
      `catalog_incompatible: the hub catalog uses reasoning ${unsupportedEfforts.length === 1 ? "level" : "levels"} `
      + `${efforts}, which the selected local Codex CLI rejects${models ? ` (${models})` : ""}. `
      + "The previous catalog was kept and nothing was changed. Upgrade the Codex CLI to a "
      + "version that supports those levels, or point CODEX_CLI_PATH at one that does and run "
      + "`ocx sync`, then retry. `ocx doctor` reports which runtime is selected.",
    );
    this.name = "ClientCatalogIncompatibleError";
    this.unsupportedEfforts = unsupportedEfforts;
    this.affectedModels = affectedModels;
  }
}

/** Fail closed: refuse an incompatible catalog before anything is written. */
export function assertClientCatalogCompatible(body: string, deps: CatalogCompatibilityDeps = {}): void {
  const assessment = assessClientCatalogCompatibility(body, deps);
  if (assessment.kind !== "incompatible") return;
  throw new ClientCatalogIncompatibleError(assessment.unsupportedEfforts, assessment.affectedModels);
}

/**
 * Why an already-installed incompatible catalog does not reuse the refusal message above:
 * nothing was kept back. The unusable bytes are the ones Codex will read on its next launch,
 * so "the previous catalog was kept" would be false. The two remedies are the same, because
 * the operator's options do not depend on when the file arrived.
 */
function installedCatalogRejectionReason(
  unsupportedEfforts: readonly string[],
  affectedModels: readonly string[],
): string {
  const models = affectedModels.length > 3
    ? `${affectedModels.slice(0, 3).join(", ")} and ${affectedModels.length - 3} more`
    : affectedModels.join(", ");
  return `the installed catalog uses reasoning ${unsupportedEfforts.length === 1 ? "level" : "levels"} `
    + `${unsupportedEfforts.join(", ")}, which the selected local Codex CLI rejects`
    + `${models ? ` (${models})` : ""}. Codex exits before its first request until the CLI is `
    + "upgraded to a version that supports those levels, or CODEX_CLI_PATH points at one that "
    + "does and `ocx sync` is run. `ocx doctor` reports which runtime is selected.";
}

/**
 * Assess the catalog this machine has already installed, so a surface can stop calling a
 * connection ready when the local runtime cannot launch against it.
 *
 * `body` is the file's bytes, or `null` when they could not be read; `file` is the state the
 * caller already established by stat. Neither non-present file state is an incompatibility: an
 * absent or non-regular catalog is a different fault, and this function only ever claims an
 * incompatibility it has proven.
 */
export function inspectClientCatalogReadiness(
  file: ClientCatalogFileState,
  body: string | null,
  deps: CatalogCompatibilityDeps = {},
): ClientCatalogReadiness {
  if (file === "missing") {
    return { kind: "unverified", reason: "no catalog is installed for the local Codex CLI to read" };
  }
  if (file === "unsafe") {
    return { kind: "unverified", reason: "the catalog path is not a regular file, so its bytes were not read" };
  }
  if (body === null) return { kind: "unverified", reason: "the installed catalog could not be read" };
  const assessment = assessClientCatalogCompatibility(body, deps);
  if (assessment.kind === "compatible") return { kind: "ready" };
  if (assessment.kind === "unverified") {
    // assessClientCatalogCompatibility words its parse failure for bytes that have just been
    // downloaded. These bytes are already installed, so blaming a download would send the
    // operator to the wrong place; name the file that is actually unusable.
    return parseModels(body) === null
      ? { kind: "unverified", reason: "the installed catalog is not readable JSON, so the local Codex CLI cannot parse it either" }
      : assessment;
  }
  return {
    kind: "incompatible",
    reason: installedCatalogRejectionReason(assessment.unsupportedEfforts, assessment.affectedModels),
    unsupportedEfforts: assessment.unsupportedEfforts,
    affectedModels: assessment.affectedModels,
  };
}
