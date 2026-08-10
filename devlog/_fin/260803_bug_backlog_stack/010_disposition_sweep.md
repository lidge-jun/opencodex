# 010 — Phase 1: disposition sweep

Label work only. No code lands in this phase.

## Method

Every open issue was read with its full comment history and compared against the
repository's live label semantics. A change is recommended only where the
issue's own content or a maintainer comment justifies it.

## Changes to apply

### Awaiting reporter → `needs-info`

Five issues have a maintainer comment naming a specific capture that would
settle them, but no label saying so. Without the label they read as unowned
work.

| Issue | The capture that would settle it | Age |
|---|---|---|
| #904 | failing `OCX_LIVE_FRAME_LOG` capture of the Korean corruption | ~20h |
| #796 | live Volcengine Ark result + regional hostname + redacted error shape | ~3.5d |
| #695 | exact switch triggers, affinity rules, unknown-quota behavior | ~5.2d |
| #561 | four concrete provider-evidence items for the Modelsell preset | ~7d |
| #418 | one current custom-parent → custom-child three-boundary trace | ~10.1d |

None warrants `stale` yet — each has recent substantive activity or a fresh
maintainer request. `stale` is for silence, not for age.

### #919 is not a bug

`bug` → `enhancement`. The maintainer confirmed the routing effect is real but
recorded that it was introduced deliberately:
`devlog/_fin/260722_issue_bug_sweep/030_patch_s_sticky_502.md` states the
expected outcome as `transient 실패 기록, affinity 해제` so account health treats
a mid-stream reset as transient. Reversing it is a policy decision, so the
issue is a behavior-change request. It keeps `proxy`, `streaming`, `tools`.

### Accepted long-term work → `roadmap`

`#820`, `#657`, `#656`, `#572`. Each has a maintainer comment accepting the
direction while splitting delivery across multiple phases or PRs — which is
exactly what `roadmap` means in this repository.

### Missing compatibility and area labels

| Issue | Add | Why |
|---|---|---|
| #938 | `provider-compatibility`, `provider` | non-canonical provider item IDs, called a compatibility defect by the reviewer |
| #893 | `provider-compatibility`, `provider` | opt-in repair for sparse gateway snapshots |
| #875 | `provider-compatibility`, `provider`, `streaming` | DeepSeek-specific lifecycle defect after a successful stream |
| #796 | `provider-compatibility` | Ark-specific, alongside `needs-info` |
| #586 | `gui` | the backend exists; the defect is entirely a missing dashboard control |
| #806 | `gui`, `cli` | the correction spans dashboard copy, CLI text, and docs |
| #92 | `tools` | the blocked flow is cross-provider sub-agent delegation |
| #425 | `catalog` | account-qualified namespaces change catalog generation |
| #414, #415 | `provider` | both evaluate external search providers |
| #177, #178 | `platform`, `tools` | Warp/Factory need agent-execution backends, not model presets |
| #95 | `platform`, `proxy` | multi-user hosting, tenant isolation, authorization |

### Maintainer-sponsored surfaces

`#656` and `#386` change auth lifecycle and release packaging respectively;
both have maintainer sponsorship on record. `#809` gets `maintainer-sponsored`
and loses `streaming` — it is an authentication route split and has nothing to
do with stream processing.

## Deliberately unchanged

`#92`, `#241`, `#417` keep `upstream-tracking`. They are the only three that
meet the definition: blocked on a Codex CLI/Desktop fix. Others block on
provider vendors (#540 on Automattic, #201 on a sanctioned contract) or on
source data, which is a different kind of external and must not be conflated.

`#908` keeps `bug` + `gui`. The reviewer already re-classified it from a GUI
enhancement to a real cost-estimation defect and kept `gui` as the visible
surface.

## No closures

Zero issues qualify for closure. Several carry landed partial fixes — #796,
#875, #904, #545 — but each has an unverified or still-reproducing residual.
Closing on a partial fix is how a defect gets buried.
