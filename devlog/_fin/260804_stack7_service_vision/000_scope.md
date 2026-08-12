# 000 — Scope: stack layer 7, the two real-but-off-theme contributor bugs

## Objective

Two overnight contributor pull requests describe real defects that the #951–#973
stack does not touch. Both were left open at the end of the overnight triage
(`devlog/_fin/260804_overnight_triage/000_dispositions.md`) with "real,
independent, own review track" as the verdict. This unit turns that verdict into
a seventh stack layer, reconstructed here, and closes the source pull requests
as superseded.

| Source PR | Author | Issue | Defect |
|---|---|---|---|
| #964 | @Yuxin-Qiao | #956 | NVIDIA NIM text-only models never activate the vision sidecar |
| #970 | @stephen-drew | — | `ocx update` re-registers the background service from a non-elevated updater |

A third item was added after the roadmap cycle opened, at the user's request:
renaming `qwen3.8-max-preview` to the now-stable `qwen3.8-max` and replacing its
reseller-proxy price overlay with Alibaba's published $2/$6 rate (`040`).

Layer 7 is the last layer. After it lands the stack merges bottom-up from #952
and every issue a landed layer resolves gets closed with its merge commit named.

## Baseline

Measured 2026-08-04. `origin/dev` at `af3ddedb4` — layer 1 (#951) is **merged**,
so the chain is now six open layers, not six-of-six pending:

| PR | Branch | Base | State |
|---|---|---|---|
| #951 | `codex/bug-stack-plan` | `dev` | **merged** `af3ddedb4` |
| #952 | `codex/908-long-context-pricing` | #951's branch | open |
| #953 | `codex/carry-contributor-bugfixes` | #952 | open |
| #954 | `codex/545-classifier-thinking-disabled` | #953 | open |
| #955 | `codex/915-cooldown-recovery-probe` | #954 | open |
| #973 | `codex/stack6-overnight-triage` | #955 | open |
| **new** | `codex/stack7-service-vision` | #973 | this unit |

Titles currently read `stack N/6` and must be renumbered to `N/7`.

## Why these two are reconstructed rather than carried

The overnight unit carried six contributor fixes verbatim with `git cherry-pick -x`
because the code was right and only the base was wrong. These two are different:
each has a design defect that a straight cherry-pick would import.

**#964** classifies NVIDIA NIM models with a hand-written ~64-entry allowlist, and
**six** entries are backwards: `thinkingmachines/inkling`,
`minimaxai/minimax-m3`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2.5`,
`stepfun-ai/step-3.7-flash`, and `mistralai/mistral-medium-3.5-128b` are natively
image-capable per NVIDIA's own documentation. Listing them makes the proxy
substitute another model's text description for an image the model could have
read — silent quality loss, no error. Issue #956's own body carries two of the
same errors, so reporter and author shared the premise.

A per-id audit of the whole list (`011`) found only 26 of ~64 entries verifiable
as text-only; 32 are absent from NVIDIA's current catalog and are dropped.

Two attempts to replace the list *shape* were then falsified at the audit gate
(`001`, `002`), and the root cause is recorded in `002`: NIM is the first
provider here asked to classify over an unbounded model set, and it publishes no
modality metadata, so an unknown id carries no signal at all. The landed design
fixes the known ids and states the open-world gap as a limitation rather than
claiming a mechanism that does not work.

**#970** switches the post-update service refresh from `install` to `repair`.
`repairService()` and `ocx service repair` **already exist** in this tree
(`src/service.ts:1755`, `src/service.ts:2526`), so the real change is a handful of
call sites and a pile of advice strings — not the 522-line diff the PR carries.
More importantly `repairService()` throws when the service is not installed, and
the update path runs *after* `ocx stop`. Whether that substitution is safe on all
three platforms is a correctness question the PR does not answer, and it is
answered in `020` before any code is written.

## Non-goals

- #961 is an enhancement (provider custom headers via PATCH), already labeled
  `enhancement` by the triage bot and confirmed unchanged. No code, no relabel.
- #966 stays open with its two surviving falsifications; the author may push
  corrections.
- #907 stays blocked on `lidge-jun/jawcode`; nothing in this unit touches it.
- No push to `dev`, `preview`, or `main`. Layer 7 is a `codex/` branch like the
  rest of the stack.

## Documents

| Doc | Contents |
|---|---|
| `001_audit_response.md` | A-gate FAIL — five blockers, synthesis, and what changed |
| `002_audit_response_r2.md` | A-gate FAIL round 2 — root cause and the design that follows |
| `003_audit_response_r3.md` | A-gate FAIL round 3 — a sixth false positive changes the method |
| `010_nim_vision_classification.md` | #964 reconstruction — the classification design and its diff |
| `011_nim_id_audit.md` | per-id verification of #964's list: 26 ship, 6 reversed, 32 dropped |
| `020_service_repair_path.md` | #970 reconstruction — call-site inventory and the after-stop safety proof |
| `030_merge_and_close_sequence.md` | bottom-up merge order, retargeting, and issue closure evidence |
