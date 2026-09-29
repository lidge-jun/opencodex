# 010 Integration (wp1): branch codex/release-2-71-0

Base: dev `37ad7e771b`. Each source diff is `git diff $(git merge-base canon/dev rt/pr-N) rt/pr-N`
applied with `git apply --3way --index`, then committed with the PR author as author. Order is the
conflict-free sequence proven in 000.

## Land commits (author / trailers copied from each PR's commit metadata)

| # | PR (head) | --author | Co-authored-by trailers | subject |
|---|---|---|---|---|
| 1 | #6206 (46bf1c9931) | Ingwannu <ingwannu@users.noreply.github.com> | — | docs(plan): define supported macOS quota admission (#6206) |
| 2 | #6201 (986f9a0c99) | luvs01 <27862058+luvs01@users.noreply.github.com> | Epinephrine <luvs01@hanmail.net>; Devin AI <158243242+devin-ai-integration[bot]@users.noreply.github.com> | fix(claude): validate picker CA scope and require the full minted CA profile (#6201) |
| 3 | #6209 (8fb990dab0) | Jio Kim <merozemory@gmail.com> | Claude Opus 5.5 <noreply@anthropic.com> | fix(windows): run the proxy at ABOVE_NORMAL priority so a saturated host cannot starve /healthz (#6209) |
| 4 | #6094 (de9880f75a) | Brad Hallett <53977268+bradhallett@users.noreply.github.com> | — | feat(gui): expose requestPacing.maxConcurrentRequests in provider settings (#6094) |
| 5 | #5905 (2b3dacdde5) | halysondev <halysoncesar2020@gmail.com> | codingbooo <9621077+codingbooo@users.noreply.github.com>; Claude Opus 5.5 <noreply@anthropic.com> | feat(cursor): surface the Private Inference local-mode installer for regular Cursor (#5905) |
| 6 | #6198 (8dbb264300) | luvs01 <27862058+luvs01@users.noreply.github.com> | Epinephrine <luvs01@hanmail.net> | fix(cli): prove cross-home ownership before deferring to a hinted port (#6198) |

Body of each: "Lands #N at head <sha> on dev through the 2.71.0 integration branch." #6209's body
adds "Closes #6208." Acceptance: `git show --stat` of each commit equals the PR's merge-base..head
stat (same files, same +/- counts).

## Fix commits (coordinator-authored)

F1 `docs(plan): pin full source paths and redirect refusal in the macOS quota design`
MODIFY devlog/_plan/260928_macos_quota_gate/000_design.md:

```diff
- the macOS limitation. `usage-policy.ts:26-48` controls two WHAM booleans, not the
+ the macOS limitation. `src/codex/desktop-compatibility/usage-policy.ts:26-48` controls two WHAM booleans, not the
- recovery is still unverified. `runtime-ownership.ts:15-27` binds exact PAC URL to
+ recovery is still unverified. `src/codex/desktop-compatibility/runtime-ownership.ts:15-27` binds exact PAC URL to
```

and after the sentence ending "even if another member of the closure is independently funded.":

```diff
+
+A 3xx response is terminal for admission: the reservation contract never fetches a
+`Location` and never treats a redirect destination as admitted. If redirects are ever
+supported, each resolved `Location` is a new immutable target that must pass the full
+funding classification, closure, generation, TLS and credential-attachment checks
+before dispatch.
```

Resolves CodeRabbit thread PRRT_kwDOS-0Gi86mz4CC (CWE-862 redirect refusal). Both paths exist on the
#6079 branch only; the doc already names #6079 as their source, so full paths are the accurate form.

F2 `docs(cli): describe the Windows priority boost as best-effort`
MODIFY docs-site/src/content/docs/reference/cli.md — replace the paragraph #6209 added (it claims
the loop never waits past the ceilings, while the PR's own measurement shows p90 3.0s at 100%
saturation) with:

```markdown
On Windows the proxy also raises its own process to ABOVE_NORMAL priority when it starts, which
reduces scheduling delays on a host saturated by other NORMAL-priority work (antivirus scans,
encoders, emulators) without guaranteeing the probe stays under these ceilings at extreme load.
The boost applies to the proxy process only — work it spawns still runs at NORMAL — and a
CPU-heavy proxy can itself delay NORMAL-priority applications. The change is best-effort; set
`OCX_DISABLE_PRIORITY_BOOST=1` in the proxy's environment to leave the priority unchanged.
```

F3 `chore(server): repair mangled punctuation in the proxy liveness comment`
MODIFY src/server/proxy-liveness.ts (~284): `probe uses ??"did not answer"` -> `probe uses — "did not answer"`
(od -c confirmed two literal '?' bytes).

F4 `test(codex): give the 32-profile transaction case the bulk durable-IO budget`
MODIFY tests/codex-integration/native-profile-manager.test.ts:

```diff
-import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
+import { BULK_DURABLE_IO_BUDGET_MS, INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";
...
-  }, 30_000);
+  }, BULK_DURABLE_IO_BUDGET_MS);
```

(Line 938, the closing line of the test "allows 32 profiles and rejects profile 33 without changing
the vault"; the import is line 21.)

Justification per tests/helpers/test-budget.ts: the case performs 32 register transactions, each
several `atomicWriteFileAsync` calls that fsync (src/config/atomic-write.ts:181,245) and, on Windows,
harden the temp file; those writes are the assertion (32 accepted, 33rd refused, vault bytes
unchanged), so the wait is intrinsic, and the ablation still fails because no assertion depends on
the budget. Observed Windows durations: 0.45s (PR runs), 2.7/3.6/6.9s (dev dispatch), 35.0s (run
36499924172). Constant = 180s on win32, 90s elsewhere. No line is added (file-size safe). Sibling
30_000 budgets are left alone; they have not flaked.

## Scope boundary

IN: the six diffs, F1-F4. OUT: optional hardening noted by reviewers (response-size cap and
redirect policy for the Cursor manifest fetch, duplicate [3] TBS field strictness in picker-ca,
extra #6209 subprocess tests, localized copies of the cli.md priority note) — recorded as
follow-ups in 090, not built here.

## Exit (checked in wp1 C)

- `git log --format='%an <%ae>%n%(trailers:key=Co-authored-by)' canon/dev..HEAD` matches the table.
- `git diff canon/dev..HEAD --stat` = union of six PR stats + F1-F4 files.
- typecheck + the focused tests listed in 020 pass in the /private/tmp verification checkout.
