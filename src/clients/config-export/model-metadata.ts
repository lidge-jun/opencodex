// Shared client export model metadata.
import { SCHEMA_REQUIRED_OUTPUT_BUDGET } from "./constants";
import type { OpencodeCatalogModel, ExportModel, ExportClientId, ManagedContribution } from "./contracts";
import type { OcxConfig } from "../../types";
import { shouldInjectApiAuthHeader } from "../../codex/inject";


/**
 * Authoritative context window, or undefined. Never guesses: a missing, non-finite, or
 * non-positive value means the serializer omits every context-derived field.
 */
export function authoritativeContextWindow(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
    const integer = Math.floor(contextWindow);
    return integer > 0 ? integer : undefined;
  }
  return undefined;
}

/** Schema-required output budget for a known context window. */
export function outputBudgetFor(context: number): number {
  return Math.min(SCHEMA_REQUIRED_OUTPUT_BUDGET, context);
}

/**
 * Modalities a given client's schema will actually accept.
 *
 * Our internal vocabulary is `text | image | audio` (ALLOWED_INPUT_MODALITIES in
 * src/server/management/model-routes.ts). Pi and Gajae accept only
 * `text | image`, and both reject the WHOLE config file over one out-of-enum
 * value — Gajae reports `/providers/opencodex/models/N/input/2: Invalid option`
 * and falls back to its built-in list, Pi returns an empty model config. So a
 * single `audio` model takes every routed model down with it. That is not
 * hypothetical: zenmux/meta-muse-spark-1.1 advertises audio and did exactly
 * this. It is also the same defect the Codex catalog had with `video`, where
 * the app showed zero apps (tests/codex-integration/catalog-input-modality-enum.test.ts).
 *
 * UNKNOWN and INCOMPATIBLE are different inputs, and the Codex fix could
 * conflate them safely only because its enum is wider. A model with nothing
 * declared is unknown, and `text` is the honest floor — every routed model takes
 * prompts. A model declaring `["audio"]` and nothing else is incompatible with a
 * text|image client, and rewriting it to `["text"]` would advertise a capability
 * it does not have. That input is reachable three ways: `ocx models add
 * --modalities audio`, `/api/custom-models`, and provider discovery.
 *
 * So unknown falls back to text and incompatible returns null, which drops the
 * row. Omitting a model costs the user a line in a picker; fabricating `text`
 * costs them a model that fails at call time with no explanation.
 *
 * Deliberately NOT applied in `ExportModel` construction: the management and CLI
 * boundaries carry catalog modalities verbatim on purpose, and stripping `audio`
 * globally would destroy valid metadata before the destination is known.
 */
const CLIENT_INPUT_MODALITIES: Record<"pi" | "gajae", ReadonlySet<string>> = {
  pi: new Set(["text", "image"]),
  gajae: new Set(["text", "image"]),
};

/** `null` means the model cannot be represented for this client — drop the row. */
export function inputModalitiesForClient(
  client: "pi" | "gajae",
  modalities: readonly string[] | undefined,
): string[] | null {
  const declared = modalities ?? [];
  if (declared.length === 0) return ["text"];
  const accepted = CLIENT_INPUT_MODALITIES[client];
  const kept: string[] = [];
  for (const value of declared) {
    if (accepted.has(value) && !kept.includes(value)) kept.push(value);
  }
  return kept.length > 0 ? kept : null;
}

/**
 * Label shared by every client: `"<displayName|id> (<native|provider|routed>)"`. The
 * provider suffix is what makes two same-named models from different upstreams
 * distinguishable in a client's model picker.
 */
export function exportModelLabel(model: OpencodeCatalogModel): string {
  const providerLabel = model.native ? "native" : (model.provider ?? "routed");
  const id = model.id ?? model.namespaced;
  if (model.displayName && model.displayName.length > 0) {
    return `${model.displayName} (${providerLabel})`;
  }
  return `${id} (${providerLabel})`;
}

/**
 * Shared precondition for every serializer: drop duplicate `namespaced` (first wins,
 * native rows lead `/api/models`) and sort by `namespaced` so two calls with the same
 * models produce identical bytes. Stability matters because the GUI shows a diffable
 * preview and agents may checksum the payload.
 */
export function normalizeExportModels(models: readonly ExportModel[]): ExportModel[] {
  const seen = new Set<string>();
  const unique: ExportModel[] = [];
  for (const model of models) {
    if (seen.has(model.namespaced)) continue;
    seen.add(model.namespaced);
    unique.push(model);
  }
  return unique.sort((a, b) => (a.namespaced < b.namespaced ? -1 : a.namespaced > b.namespaced ? 1 : 0));
}

/** Extra headers a non-loopback bind needs, or nothing on loopback. */
export function proxyAdmissionHeaders(config: OcxConfig | undefined, envRef: string): Record<string, string> | undefined {
  return shouldInjectApiAuthHeader(config) ? { "x-opencodex-api-key": envRef } : undefined;
}

/** One fragment at `path`, built from this client's own document. */
export function singleFragment(clientId: ExportClientId, path: readonly string[], value: unknown): ManagedContribution {
  return { clientId, fragments: [{ path, value }] };
}
