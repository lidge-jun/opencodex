# 006 — Shared macOS recovery-test verification debt

> Historical record imported from `9c0952e482b1586c0dc62d5c536698fe5578cf28`. Historical investigation or process record; not current execution authority. Old verification debt and diagnoses are not current failure claims or permission for new diagnostics.
> Operational instructions and verification recipes below are superseded by800_closeout.md,801_closeout_regression_matrix.md,810_first_rebase_regression.md and820_second_regression_delivery.md. Peer coordination is closed. Historical checks certify only their recorded heads; this document authorizes no new debt implementation or execution.

## Observed failure, not established cause

Read-only RCA by Copernicus (01a06fc1-504a-7b81-b3b0-760ab93c8788, explicitly gpt-6-astra high). No code edits, tests, SSH, workflow reruns or PR mutations in that lane.

| PR/head | Run/job | Observation |
|---|---|---|
| #3590 / 82e069c9fe59b9660bee7964cd58c0141687267b | 33940504774 / 101237519332 | recovery assertion after92.178s;9244pass/3skip/1fail |
| #3594 / 0c914bf265ce38c57498c21ccf81f0202b9c133c | 33941274745 / 101239095583 | same assertion after92.801s;9244pass/3skip/1fail |

Both used Bun1.4.0 (34cbb9a40), macOS26.6.2 ARM64, runner image20260831.0337.3. The reviewer verified checked-out merge trees matched the pinned PR-head trees. No uploaded artifacts were available.

## Confirmed observability gap

At the pinned versions, tests/update/update-stop-first.test.ts:227-240 verifies update exit1 and recovery announcements, then waitForProxy returnsfalse. bin/ocx.mjs:266-281 announces recovery before launching a detached child with stdio ignore and unref. tests/update/update-stop-first.test.ts:48-63 discards probe exceptions and non-success response details. Its cleanup at244-279 discards stop output and removes the fixture. Main spot-checked these excerpts with git show82e069c9.

The logs do not retain the detached child's stderr/exit status, listener identity or probe-error history. A startup announcement is not startup proof. The root cause remains unknown; neither a flake nor an environmental exemption has been established.

## Competing hypotheses and falsifiers

| Hypothesis | Falsifier | Status |
|---|---|---|
| Child exits/stalls before bind | Identified child serves successful health during failure interval | unresolved |
| Shard process history/resource interference | Same failure in matched clean singleton | unresolved |
| Live child, unsuccessful transport or HTTP probe | Child conclusively exits before listening | unresolved |

The outer165s test budget was not exhausted: this was an assertion failure. An interactive prompt is inconsistent with the detached child's ignored/non-TTY stdio and the prompt's TTY gate.

Linux4/4 batch21/23 passes the case in2.298s/2.313s, but its <=12-file fresh-process batches differ from the macOS536-file shard. scripts/test.ts:327 assigns the case a dedicated serial full-suite lane; those CI paths bypass that wrapper. Prior15→45→90s increases are not causal evidence for today's failure.

## Next diagnostic, not an approved implementation

Collect test-owned failure evidence before teardown: detached Node/Bun PID and exit/signal, sanitized stderr, allowlisted runtime state, listener ownership and timestamped probe outcomes. Preserve assertions, cleanup and existing budgets. Compare the instrumented same-image macOS shard against a singleton, changing only isolation, before choosing a startup/harness fix. No blind retry, timeout increase or production patch is justified by current evidence.

This diagnostic is outside WP400's source/test write set and has not been implemented. The train's fresh verification criterion c-5 keeps these failures open; historical workphase-done/c-3-met flags do not close them.
