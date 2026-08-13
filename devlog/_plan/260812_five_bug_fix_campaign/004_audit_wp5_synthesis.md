# 004 — WP5 audit: my fetch-site audit was wrong

Independent reviewer verdict on the `051` audit deliverable: **FAIL**. The claim
it falsified was mine, and the falsification is correct.

## What I claimed, and why it was wrong

I enumerated the request-path fetch sites, found `cancelBodyOnAbort` at eight of
them, and concluded there was no unguarded site. Two errors:

**1. I checked whether a guard exists in the function, not whether it covers the
branch.** At `src/server/responses/core.ts` the guard is installed at `:3436`,
but the non-2xx branch runs at `:3387-3394` and does
`await upstreamResponse.text()` **before** it. Same shape in
`src/web-search/executor.ts:85-90` and `anthropic-executor.ts:169-175`: the
failure branch reads the body, then the guard is attached for the success path.
So the error path reopens exactly the fetch-resolution-to-reader-attach race the
guard exists to close. Verified both by reading the code.

**2. I enumerated from a grep of files that already imported the helper.** That
is a survivorship filter: it can only ever find sites that already have a guard.
`/v1/live` (`src/server/live.ts:554-570`) has no guard at all, passes no signal
to `readBodyCapped`, and releases its reader lock without cancelling on read
failure. It never appeared in my table because it never imported the helper.

The reviewer also found request-time OAuth refresh (`src/oauth/index.ts` dispatch
reached from `core.ts:1799`), the CCA image fallback, the MiMo JWT bootstrap, and
the xAI image/video clients — all model-turn paths, none in my table.

## Consequence for the disposition

`051` acceptance criterion 1 is **unmet**, and the disposition must not say "no
unguarded request-path site found". That sentence would have been a false
all-clear on the exact question the issue is about.

What stays true and was independently confirmed:

- `installCrashGuards` does install both handlers, redacts, persists best-effort,
  and keeps the process alive for JS-level failures — with bounded gaps
  (best-effort persistence, a five-minute fold for known native teardown
  rejections, installation after listener startup). None of that explains a
  native `SIGTRAP`.
- Bun's fetch/TLS teardown is the only in-tree mechanism that fits the reported
  sequence. Keyring N-API, `bun:sqlite`, Workers, and subprocesses exist but have
  no temporal or causal link to TLS verification failure; the FFI sites are
  Windows-gated and cannot explain a macOS crash.
- Supervision exists (launchd `KeepAlive`, systemd `Restart=on-failure`, WinSW
  restart-on-failure) but **does not cover an `ocx gui`-started process**:
  `src/cli/dispatch.ts:240-248` calls a detached spawn directly, and the child at
  `src/cli/index.ts:924-931` is not adopted by any supervisor. That is precisely
  why the reporter saw the dashboard die and stay dead.
- #1419 stays open pending the `.ips` frames.

## Amendment: hardening lands, framed honestly

The unguarded sites are real defects worth fixing on their own merits. They are
**not** a fix for the reported crash, and the PR and issue comment must say so:
this is hardening discovered while investigating #1419, not proof the trap is
resolved.

Scope for this work-phase, ordered by how directly the path serves a user turn:

1. `src/server/responses/core.ts` — guard the non-2xx branches (initial and
   continuation) before reading the error body.
2. `src/server/live.ts` — guard the call-create response and cancel on read
   failure.
3. `src/web-search/executor.ts`, `anthropic-executor.ts` — move the guard above
   the failure branch.

Deferred, with reasons recorded rather than silently dropped: request-time OAuth
refresh (`oauth/*` token endpoints) is a broad surface touching credential
handling and wants its own change with security review; CCA image fallback, MiMo
bootstrap, and the xAI clients have a narrower pre-attach interval; quota and
model discovery are not turn-body paths. Each is named in the follow-up so the
list is not lost.

Disclosure ordering (`AGENTS.md`): the working table stays in `.tmp/`. The public
comment names a finding only once its fix is merged and therefore already
disclosed by the diff.
