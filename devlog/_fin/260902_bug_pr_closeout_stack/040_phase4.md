# 040 — Phase 4: #3094 — ocx models new-policy / new-arrivals are unreachable

## Defect

`src/cli/models-runtime.ts:332-333` implements both subcommands:

    else if (sub === "new-policy") action = () => newPolicy(argv, deps);
    else if (sub === "new-arrivals") action = () => newArrivals(argv, deps);

and `src/cli/models-runtime.ts:27-28` lists them in USAGE. But `handleModels` in
`src/cli/models.ts:448` routes only a hardcoded list to the runtime module:

    if (["live", "edit", "enable", "disable", "provider", "selected", "preset", "context", "shadow"].includes(subcommand ?? "")) {

Neither name is in it, so both fall through to `handleConfiguredModels`, which rejects the
argument: `Unexpected argument(s): new-policy, status`, exit 1.
`docs-site/src/content/docs/guides/model-routing.md:88-89` documents both commands.

## Root cause, not just symptom

Two lists name the same set and only one was updated. The fix removes the duplication:
the runtime module owns its subcommand set and `handleModels` consumes it.

## MODIFY map

**`src/cli/models-runtime.ts`** — export the set the dispatcher already encodes:

    export const MODELS_RUNTIME_SUBCOMMANDS = [
      "live", "edit", "enable", "disable", "provider", "selected", "preset",
      "new-policy", "new-arrivals", "context", "shadow",
    ] as const;

and drive `handleModelsRuntimeCommand`'s guard from it, keeping the existing per-name
action mapping.

**`src/cli/models.ts`** — replace the literal array with the imported set. The import must
stay lazy if the current dynamic `await import("./models-runtime")` exists to keep the CLI
startup path light; if so, import the constant from a leaf module rather than pulling the
whole runtime eagerly.

## TESTS

**NEW `tests/cli-models-runtime-dispatch.test.ts`**:

1. every name in `MODELS_RUNTIME_SUBCOMMANDS` is routed by `handleModels` to the runtime
   module rather than `handleConfiguredModels` — the general form of the defect, so a future
   subcommand added without touching the dispatch fails here.
2. `new-policy` and `new-arrivals` specifically reach the runtime handler.
3. an unknown subcommand still falls through to `handleConfiguredModels`.

## Verification (C)

- `bun test tests/cli-models-runtime-dispatch.test.ts` focused. No repository-wide suite.
- typecheck and the rest are CI's job, judged at the end of the train.

