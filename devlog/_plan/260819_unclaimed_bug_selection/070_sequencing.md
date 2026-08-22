# 070 — Sequencing against the release roadmap

This unit starts **after stage 3d** of `260819_next_roadmap/070` — that is,
after `#2019` and `#2023` merge, after the first preview soak, and after
`#2036` lands alone.

## Collision analysis — corrected after audit

The first version of this section asked only "does this fix touch a file the
**split** rewrites". That is the wrong question, and it produced a wrong
answer: "only #1587 collides."

The right question is **"does an open PR already own this code"**, regardless of
whether that PR mentions our issue. Re-derived:

| Fix | Files | Collides with |
|---|---|---|
| #2114 | `service-manager-probe.ts` + its test | **PR #2029** — same function, `CHANGES_REQUESTED` |
| #2108 | `server/index.ts`, `codex/auth-context.ts` | **PR #2101** (1397 lines, same two files) |
| #1587 | `types.ts`, `parser.ts`, 3 adapters | **#2019 and #2023** (split), plus #2112/#1934 on types, #2040/#2083 on parser, #2115/#2080/#2075/#2071/#2070 on the adapters |
| #2107 | `service.ts` | clean |
| #1933 | `tray/windows.ts` | clean |

Three corrections fall out of that table:

1. **#2114 is not greenfield.** See `020` — the first action is to extend or
   unblock #2029, not to open a parallel PR.
2. **#1587 is worse than "after WP1b".** WP1 (**#2019**) already rewrites
   `src/types.ts`, and the adapter files it touches are among the most
   contested in the queue. It is the last of the five to start, not merely the
   one that waits for the split.
3. **#2107 and #1933 are the only genuinely clean ones.** That strengthens the
   case for running them in parallel rather than queueing them behind #2114.

### Why still after stage 3d

Unchanged for #1587 (`types.ts` is being replaced by a barrel). For the rest it
is scheduling, not correctness — the split train owns review attention until 3d
closes.

## Order

```
1. #2114  unblock PR #2029 with the containment its reviewer asked for
2. #2107  bake proxy env into service units        (clean, parallel-safe)
3. #1933  tray registry decoding                   (clean, parallel-safe)
4. #2108 phase 1  log the gate reason              (coordinate with #2101)
5. #1527 residual: abort-teardown misclassification (small, independent)
6. #1587  deferred catalog                         (last: most contested files)
7. #2108 phase 2  retryable fence                  (after phase 1 produces data)
```

### Dependencies, stated explicitly

- **#2114 before #2108 phase 2.** They share the `unknown → permanent fence`
  layer. #2114 settles how a probe that cannot answer should be classified at
  the boundary; phase 2 generalizes that into retryability. Designing the
  general rule from #2108 first means deriving it from the instance we
  understand least.
- **#2108 phase 1 before phase 2.** The trigger is not identified and the gate
  reason is not logged. Phase 2 without phase 1 is a fix aimed at one of two
  candidates with no way to confirm which.
- **#1587 after the split AND after the adapter PRs settle.** `#2019` rewrites
  `types.ts`; `parser.ts` and the three adapters each have open PRs. This is the
  one place where starting early guarantees a rewrite.
- **#1527 residual is independent of everything.** It only touches the Cursor
  abort listener. It can slot anywhere, and should not wait for #2054 — the
  teardown misclassification is orthogonal to checkpoint reuse.
- **#2107, #1933 are independent.** They can slot anywhere; they are placed by
  cost, not constraint.

### What can run in parallel

#2107 and #1933 touch nothing the others touch and nothing each other touches.
If there is review capacity, they are the two to run alongside #2114 rather
than after it.

## Relationship to the preview soak

`#2114`, `#2107` and `#2108` are all "the proxy cannot serve a path" bugs, and
all three are hard to catch in CI: they need a container without a user bus, a
shell-only proxy, and a Windows reboot respectively. None of those exist on a
runner.

That makes them **good soak candidates and bad CI candidates**. The 070 roadmap
already establishes a preview window with a named exercise set; these three
should extend it:

- a container run with `systemctl` present and no user bus (#2114)
- a service install where the proxy env lives only in the shell (#2107)
- a Windows reboot with the scheduler backend (#2108)

Adding those three to the soak checklist is cheaper than trying to simulate
them in CI, and it converts the next occurrence into a dated observation
instead of another ambiguous report.

## What this unit does not do

No `src/` changes, no PR merges, no GitHub mutations. The three deferred
candidates keep their disposition from `010`: #1049 waits for a real incident,
#1419 stays upstream-blocked with a separable supervision follow-up, and #1730
is a close-as-withdrawn once someone is authorized to close it.

## Follow-ups this unit identified but does not own

Both were named in passing and would otherwise be lost. Each deserves its own
issue rather than riding a fix:

1. **Unsupervised `ocx gui`** (`src/cli/dispatch.ts:255`) spawns the proxy
   detached while launchd `KeepAlive` covers only `ocx service`. Separable from
   #1419's untestable Bun trap, and unlike it, testable.
2. **Stale tray has no in-product repair path** — GUI hides Install when
   `tray.stale` and Uninstall also refuses on a mismatched parse.
