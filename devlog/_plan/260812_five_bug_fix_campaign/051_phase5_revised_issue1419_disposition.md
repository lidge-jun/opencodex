# 051 — Phase 5 REVISED (#1419): audit first, disposition, no duplicate hardening

Supersedes `050`. Written after audit blockers B5, B6, B7.

## Why 050 was wrong

`050` proposed three work items. The audit proved that all three already exist
in the tree, and the main agent confirmed each:

| 050 proposed | Reality |
|---|---|
| add `unhandledRejection` / `uncaughtException` diagnostics | `src/lib/crash-guard.ts:332` `installCrashGuards()` already installs both, records redacted diagnostics, and is invoked at `src/cli/index.ts:265`. It even special-cases the benign Bun abort-teardown rejection at `:156,185`. |
| audit `fetch` sites for unsettled bodies | `cancelBodyOnAbort` is already applied at 8 sites, including the OpenAI Responses path (`src/server/responses/core.ts:3436` and `:3671`), both web-search executors, both vision describers, and `codex/auth-api.ts:1748`. |
| add supervision/restart hardening | launchd `KeepAlive`, systemd `Restart=on-failure`, and Windows restart-on-failure already ship. |

The reviewer's sharpest point: a test written against an already-guarded path
**cannot go red before the fix**. It would be ceremony, not regression coverage,
and landing it under #1419's number would imply the crash was addressed.

There is also a hard ceiling the plan under-weighted: **no in-process handler
survives a native `SIGTRAP`**. `crash-guard` catches JS-level failures; the
reporter explicitly observed *no* JS crash log, which is itself evidence that
the fault did not pass through the JS error path.

## What this phase actually does

### 1. Audit, and record it

Enumerate every `fetch` in the request path and record, per site, whether the
response body is settled on the failure/abort branch.

**Disclosure ordering (audit R2-5).** `AGENTS.md` requires unreleased failure
findings and pre-disclosure patch reasoning to stay in scratch space. So:

- the working audit table lives in `.tmp/` (gitignored), **not** in `devlog/`
  and **not** in a public issue comment;
- the public comment names only protections that already ship and are visible in
  public diffs (`installCrashGuards`, the `cancelBodyOnAbort` sites, service
  supervision);
- any **unguarded** site discovered is named publicly only after its fix is
  merged and therefore already disclosed by the diff.

If — and only if — an unguarded site is found:

- it gets `cancelBodyOnAbort` (reuse the existing helper);
- it gets a regression test that is **red before** the change;
- it ships as its own PR, described as hardening found while investigating
  #1419, not as a fix for the reported crash.

### 2. Post an evidence-backed disposition on #1419

Contents:

- what already exists (`crash-guard`, `cancelBodyOnAbort` site list, service
  supervision) so the reporter and future triagers stop re-proposing it;
- the external finding: current stable Bun is **1.3.14** (2026-05-13), which is
  the version in the report, so **no upstream fix exists to upgrade into**;
  adjacent issues [#31894](https://github.com/oven-sh/bun/issues/31894) (stale
  pooled socket — hang) and [#17325](https://github.com/oven-sh/bun/issues/17325)
  (self-signed CA — error) do **not** establish this abort;
- the discriminator still needed: the full faulting main-thread frame list from
  both `.ips` reports, plus the Bun image UUID and load address, to tell Bun's
  TLS/fetch implementation apart from JavaScriptCore's unhandled-exception path;
- the one thing the reporter can act on now: `ocx gui` starts an **unsupervised**
  background process, so installing the service gives them the restart behavior
  they expected. This is a genuine mitigation for the dashboard-death half of
  the report, and it is honest about not being a fix for the trap.

### 3. Do not close the issue

Terminal outcome for this phase: **NEEDS_HUMAN** on root cause. The issue stays
open awaiting crash frames. Closing a crash report with no reproduction and no
proven cause is exactly the evidence-free closure the repository's triage rules
forbid.

## Explicitly refused

- Weakening or bypassing TLS certificate verification anywhere, under any flag.
  That trades a liveness bug for a security defect.
- A second crash handler alongside `installCrashGuards`.
- Any test that re-proves `cancelBodyOnAbort` on an already-guarded path.

## Accept criteria

1. The complete `fetch`-site audit table exists in `.tmp/` with every site's
   settle path named. It is never committed and never pasted publicly.
2. Any unguarded site found ships with a red-before test, in its own PR.
3. The disposition comment is posted containing a **public shipped-protections
   table** (only protections already visible in public diffs), the Bun evidence
   with URLs, the frame-list request, and the service-install mitigation.
   Unshipped findings stay in `.tmp/` until their fix merges (audit R2-5, R3-3).
4. `bun run privacy:scan` exit 0 if any code lands.
5. #1419 remains open, labeled to reflect that it is awaiting reporter evidence.
