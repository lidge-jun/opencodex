---
name: verify-droid-integration
description: Verify the Factory Droid CLI outbound integration against a live OpenCodex proxy, including every active model, streaming, reasoning, tools, images, and long context.
---

# Verify Factory Droid integration

Use this skill after changing Droid export, client integration ownership, model metadata, or the
OpenAI-compatible chat path. It drives the real `droid exec` CLI with a process-only settings file.
It never writes `~/.factory/settings.json`.

## Launch

Use the user's existing signed-in OpenCodex instance when `curl -fsS
http://127.0.0.1:10100/healthz` succeeds. The provider credentials live in that instance's
`OPENCODEX_HOME`, so do not start a second proxy against the same home.

If no proxy is running, start this checkout and keep its PID:

```bash
bun run src/cli/index.ts start --port 10100
```

Wait for `http://127.0.0.1:10100/healthz`. Stop only the PID you started.

## Doctor

Run the no-inference pass first:

```bash
bun .agents/skills/verify-droid-integration/scripts/run.ts --dry-run
```

It exports the live active catalog through `ocx export --client droid`, checks proxy health and
Droid version, validates unique generic-provider rows, and asks Droid to resolve every custom model
ID with `--list-tools`. A failure makes the instance unfit for the paid live pass.

## Drive

Run the full matrix:

```bash
bun .agents/skills/verify-droid-integration/scripts/run.ts \
  --concurrency 3 \
  --timeout-ms 180000 \
  --long-words 20000
```

The active model set is frozen from the exported config at run start. Each model gets catalog,
normal text, stream JSON, reasoning when advertised, Read tool call/result, image Read/OCR when
advertised, and long-context coverage. Use `--models <csv>` or `--cases <csv>` only for diagnosis;
the PR proof is the unfiltered run.

## Evidence

Each run writes `.tmp/verify-droid-integration/<timestamp>/`. The directory contains the generated
settings, export and health evidence, one command/result JSON per model and case, `summary.json`,
and `failures.json`. The command, exit code, stdout, stderr, timeout state, and duration preserve
both the action and result. Keep the full directory through review.

Passing means no `fail` or `error` result. `fail` records a completed assertion mismatch; `error`
records a timeout, nonzero exit, or caught execution exception. `unsupported` is accepted only when
the exported model lacks the corresponding reasoning or image capability. The generated settings
must remain free of real keys.

## Cleanup

The helper starts no proxy and changes no persistent Factory settings. Delete diagnostic prompt and
marker files only by deleting a run directory after its evidence is no longer needed. Do not remove
the proof directory during verification. If this skill started a proxy, stop that exact PID after
the final drive. Droid records its own exec sessions in the signed-in user's normal history; the
helper records their IDs in command output and does not delete unrelated history.

## Helpers

`scripts/run.ts` is executable and self-documenting:

```bash
bun .agents/skills/verify-droid-integration/scripts/run.ts --help
```

## Failure recovery

Read `failures.json`, rerun only the affected model and case, and preserve the new run beside the
original. After a timeout or transport failure, repeat the Doctor pass before another paid request.
If health is green but Droid remains wedged, end that `droid exec` process and start a fresh run;
never reuse a failed session.

## Feature map

Read [features/README.md](features/README.md), then maintain it with
`/maintain-verification-skill` after user-facing integration changes.
