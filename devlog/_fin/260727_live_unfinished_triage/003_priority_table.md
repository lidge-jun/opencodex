# 003 — priority table

This table is live-state based, not copied from the older owner-decision ledger.

| tier | item | bucket | why now | next PABCD action |
| --- | --- | --- | --- | --- |
| P0 | PR #526 | takeover-fix/rebase+tests | clean/green at old head, but independent review found stale checks and shallow direct write-path coverage | rebase/take over or request author update |
| P0 | PR #528 | needs-human/security + request-changes | credential-origin disclosure risk in image bridge, plus stale checks | request changes; no merge |
| P0 | issue #543 | comment/request-changes | reporter has already answered the control question; debug switch exists | comment with capture instructions |
| P0 | issue #547 | comment/request-changes | new Windows Claude Desktop custom-model visibility bug; likely config/profile evidence gap | comment with exact evidence request |
| P0 | issue #545 | takeover-fix/investigate | user-facing repeated classifier failures; one logging layer fixed but root still open | investigate request token path |
| P1 | issue #521 | comment/request-changes | still `needs-info`; web-search 499 needs reporter/update evidence before another fix claim | request exact reproduction delta if stale |
| P1 | issue #476 | needs-human/security | signal half can be handled by #526, but restart/process-termination half is a human/security boundary | split safe signal work from restart policy |
| P1 | PR #527 | needs-author-rebase | wrong base blocks CI policy and #476 closure | after #526, ask/retarget to `dev` |
| P1 | issue #418 | takeover-fix/investigate | real V2 delegation bug with no linked PR | inspect delegation path and repro |
| P1 | issue #509 | takeover-fix/investigate | concrete JS-heap memory growth gap | inspect watchdog heap/RSS logic |
| P2 | PR #429 | takeover-fix | small Cursor bug but draft/conflicting; user previously deprioritized Cursor-class work | rebase/fix only after P0/P1 |
| P2 | conflicting drafts #429/#461/#491/#493/#498 | dual bucket | conflicts are a prerequisite blocker; each retains its own primary bucket based on surface risk | rebase only inside that item’s PABCD |
| P2 | PR #533 | needs-human/security | install/update ownership boundary with requested changes | security review only |
| P2 | PR #447 | needs-human/security | auth/browser multi-account boundary | security review only |
| P2 | PR #491 | needs-human/security | OAuth/API-key preservation touches credential store | security review only |
| P3 | PR #512/#495/#493 | needs-human/security | account identity/quota policy must be unified | product/security design cycle |
| P3 | PR #424/#355 | later/enhancement / needs-human | competing image-generation routes; UX/backend choice absent | human decision before merge |
| P3 | PR #498/#461 | later/enhancement | draft/conflicting new policy/surface work | wait/replan |
| P3 | roadmap issues #42/#95/#177/#178/#201/#294/#386/#414/#415/#425/#540 | later/enhancement | not immediate bug cleanup | scheduled roadmap cycles |
| P3 | upstream issues #92/#241/#401/#417/#462 | upstream-tracking | external dependency or upstream attribution | keep tracking; do not close without upstream proof |

## Rule for next phases

Each item above gets its own full PABCD cycle before GitHub state changes. The only
exception is read-only live refresh inside the P phase of that same item.
