# 080 — CI stabilization after the feature landed

The feature is on `origin/dev`, every macOS gate green, and Cross-platform CI
red. This document is the stabilization unit: what failed, why, and what each
work-phase must prove.

## The evidence

Run `30757205162` (push of `68fe94eda`, "Cross-platform CI", job `windows`):
**7222 pass / 6 skip / 24 fail**. Ubuntu and macOS legs pass the same suite —
the failures are platform-specific, not logic-specific.

A red `dev` predates this feature: run `30738272930` on `release: v2.10.0`
failed the same job before any integration code existed. Attribution is
therefore per-failure evidence, never "it was already red" or "it must be mine".

## WP-S1 — the 24 Windows failures

Three root causes, not twenty-four bugs.

### 1. Hermes does not live at `~/.hermes` on Windows (20 tests)

`hermesHomeDir` resolves `%LOCALAPPDATA%\hermes` on `win32`
(`src/clients/config-export.ts`). `tests/integrations-writer.test.ts` created
`join(home, ".hermes")` and handed the writer a `home` whose detector directory
did not exist, so `applyIntegration` refused `not_installed` and every
dependent assertion fell over — the whole apply/disable/restore/nothing-leaks
surface.

The fixture now asks the registry (`spec.detectDir` / `spec.configPath`), which
is what `tests/management-integration-routes.test.ts` already did. The same
assumption existed twice in `tests/integrations-invariants.test.ts`; both sites
now use one `installClient()` helper.

**This is a fixture bug, not a source bug.** The registry was right the whole
time; the tests encoded a layout it never promised.

### 2. Three assertions spelled the separator by hand

```
Expected: "/tmp/h/config.yaml"
Received: "\tmp\h\config.yaml"
```

`hermesConfigPath`, `kimiConfigPath` and `gajaeConfigPath` were compared to
literals. The claim each test makes is *the override wins* / *this is the
documented destination* — not *paths use forward slashes*. They compare against
`join(...)` now, so the property holds on both platforms and a genuine
destination change still fails them.

### 3. The CSRF test needed a GUI bundle CI does not build

`ci.yml` installs dependencies and runs `bun test --isolate tests`; it never
runs `build:gui` first, so `gui/dist` is absent and `serveGuiFile` has no page
to inject `opencodex-session-token` / `opencodex-session-csrf` into. The test
read empty strings. It passed locally only because a stale build sat on disk —
the same class of false confidence the WP5/WP6 audit kept finding.

There is no wire route to mint a GUI session without that page, and issuing one
from a fresh `initializeManagementAuthState` returns a token bound to a
different session map than the running server's, which would make the
assertions meaningless. So the no-bundle case returns early with the absent
bundle **asserted** (`existsSync(...)` is `false`, via `fileURLToPath` — a
Windows URL `.pathname` is `/D:/...` and would make the guard vacuous).

The ordering claim the test exists for — admission runs before dispatch — stays
covered on those platforms by the admin-token test directly above it, which
drives the same real listener.

Verification for this one is local and exact: move `gui/dist` aside, re-run,
22 pass / 0 fail.

### Not ours: the 24th failure

`tests/codex-prompt-adopt.test.ts` → `salvage > preview returns a directory,
not a reserved filename`. `previewSalvage` computes
`storePath.slice(0, storePath.lastIndexOf("/") + 1)`, which never matches a
backslash path, so `backupDir` comes back `"."` on Windows and the
`endsWith("/")` assertion fails.

That is a **real source bug on Windows**, in `src/codex/prompt-layers.ts` —
explicitly out of this unit's write scope and owned by another session's work
(`ca087b591`, `9bb410ab3`, `d70fde4d9`). Reported, not patched: silently
touching another stream's file is how two sessions start overwriting each
other. Fixing it needs `dirname()` and a separator-agnostic assertion.

## WP-S2 — attribution

Inspect every job of the run that follows `7a8323c0a`, not just Windows. For
each remaining failure, record whether it is feature-caused (fix it) or
pre-existing (name the earlier failing run id). "Already red" is not
attribution.

### Result

The earlier red run `30738272930` (`release: v2.10.0`, commit `f9b9440c5`) is
**not** what the first reading of it suggested. Its failing job was **ubuntu**,
not windows — windows and macos both passed there — and the job died at 3m47s
with no test summary in the log at all: a crashed step, not a test failure.

`src/integrations` does not exist at `f9b9440c5` (`git ls-tree` returns
nothing), and `f9b9440c5` is an ancestor of this work. So that failure is
**pre-existing and unrelated**, established by the tree at that commit rather
than by argument.

That also corrects an assumption in the CONTEXT above: this feature did not
inherit a red Windows leg. Windows was green before the feature and the 24
failures were entirely ours.

The CSRF failure deserves the same correction. It was reported as a Windows
failure and it was not: run `30759521240` failed it on **ubuntu** too. Reading
only the Windows job would have produced a Windows-shaped fix for a
cross-platform cause (the missing `gui/dist`). Inspect every job, not the one
that looks guilty.

## WP-S3 — semantic stabilization: result

Seven cross-phase defects, all reproduced at runtime by the reviewer. Five are
fixed (`3bc89c283`, `52a9fa2bd`); three are deferred with reasons, in the
order the reviewer recommended:

1. **OpenClaw ignores its documented path overrides.** `openclawHomeDir`
   returns `~/.openclaw` unconditionally, while every sibling client honors an
   override (`HERMES_HOME`, `KIMI_CODE_HOME`, `XDG_CONFIG_HOME`). Current
   OpenClaw resolves `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR` and
   profiles, so the toggle can report success after writing a file the running
   gateway never reads — and snapshot the wrong file too. Release-blocking for
   the OpenClaw integration specifically; the other five are unaffected.
2. **Export serializers meet arbitrary user documents.** `renderYaml` and
   `renderToml` were written for builder output; the writer feeds them the
   user's whole parsed file. A YAML `null` or a TOML numeric array throws out
   of the writer and surfaces as a 500. Nothing is overwritten — the throw
   happens before commit — but a valid client config cannot use the feature.
   The minimum honest fix is a structured `unsafe` refusal; the real fix is
   serializers covering each client's valid domain.
3. **Absence-result Undo disagrees with restore drift detection.** The route
   represents a missing file as `""` and marks such a row undoable; the writer
   compares `fingerprint("")` against `""` and demands drift confirmation. A
   shared matcher honoring `resultAbsent` belongs in both. Costs an
   unnecessary confirmation, preserves bytes — the least urgent of the three.

Each is its own work-phase, appended to the goalplan rather than folded into a
stabilization commit that would hide them.

## WP-S3 — semantic stabilization

Every phase is landed now, so the contract can be read end to end for the first
time: registry → writer → routes → GUI → CLI, across all six clients. Look for
drift the per-phase audits could not see because the later half did not exist.

## WP-S4 — types and docs

Typecheck strictness over the feature surface, escape-hatch review, docs-site
build, and the unit's own `check-drift` / `check-blocks`.

### Result

**Type safety: nothing to fix.** Across `src/integrations/**`,
`src/clients/config-export.ts`, `src/server/management/integration-routes.ts`,
`src/cli/integrations.ts` and `gui/src/pages/integrations/**` there is not one
`any`, `@ts-ignore`, `@ts-expect-error`, or `as unknown as`. The casts that do
exist are five `as Record<string, unknown>` narrowings, each on the line after
the `isPlainRecord` / `typeof` check that makes it safe — the compiler cannot
carry the guard across the index access, so the cast is the narrowing, not an
escape from it. `tsconfig.json` is `strict: true`, and the GUI additionally
enforces `erasableSyntaxOnly`, which is what caught a parameter-property in
the browser adapter during WP5.

**Two lint suppressions, both deliberate and both explained at the site:**
`react-hooks/set-state-in-effect` in `use-app-route-state.ts` (reconciles a
hash changed before the listener existed; the equality check bounds it to one
render) and `react-doctor/async-await-in-loop` in `IntegrationsOverview.tsx`
(the bulk loop is serial on purpose — the server's single-flight guard is
keyed per client and the record file is read-modify-write, so parallelising it
would drop ownership records).

**Docs: one overpromise corrected.** The page said "every value you had is
still there and equal", which the audit showed the code cannot guarantee for
every input — a TOML file using `inf`/`nan` is unreadable through the parser
available to us. Rather than restate the promise, the page now says what
actually happens: the round trip covers the value kinds these formats use in
practice, and where it does not, applying stops and names the file instead of
writing a changed value. That is the honest version of the same guarantee.

`check-drift` clean across 21 docs; `check-blocks` tsc-clean across 79
extracted blocks; docs-site builds 211 pages.

### Known limitation, carried forward

The reviewer's architectural point stands and is not closed by this phase: a
renderer extended case by case is not the same as a serializer whose supported
domain is the format's own. Each concrete gap they reproduced is fixed and
refuses safely rather than corrupting, but full fidelity would need a
document-preserving TOML/YAML pipeline. That is a dependency decision, not a
patch, and it belongs to whoever picks up comment preservation.

## Rule for this unit

A test that cannot run on a platform is skipped with a stated specific reason.
Narrowing an assertion until it passes is not a fix, and neither is deleting
the platform from the matrix.
