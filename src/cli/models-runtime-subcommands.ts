/**
 * The `ocx models` subcommands that live in `models-runtime` and talk to the
 * management API, rather than editing `config.json` directly.
 *
 * This list is shared rather than duplicated on purpose. `handleModels` in
 * `models.ts` decides which names to hand to the runtime module, and
 * `handleModelsRuntimeCommand` decides which names it answers. When those two
 * lists were written out separately, `new-policy` and `new-arrivals` were
 * implemented and documented but never routed, so both failed with
 * "Unexpected argument(s)" (#3094).
 *
 * It lives in its own leaf module so `models.ts` can read the set without
 * statically importing `models-runtime` — that import is deliberately dynamic
 * to keep the management-API client off the `ocx models add` path.
 */
export const MODELS_RUNTIME_SUBCOMMANDS = [
  "live",
  "edit",
  "enable",
  "disable",
  "provider",
  "selected",
  "preset",
  "new-policy",
  "new-arrivals",
  "context",
  "shadow",
] as const;

export type ModelsRuntimeSubcommand = (typeof MODELS_RUNTIME_SUBCOMMANDS)[number];

export function isModelsRuntimeSubcommand(value: string | undefined): value is ModelsRuntimeSubcommand {
  return MODELS_RUNTIME_SUBCOMMANDS.includes(value as ModelsRuntimeSubcommand);
}
