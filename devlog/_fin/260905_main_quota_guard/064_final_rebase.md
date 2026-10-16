# Final Reserve rebase onto published dev

The owner requested rebase and admin landing of PR3578, then verification on dev, without
local suites. Original head ae3e1aea8 and its12 commits remain preserved in the original
managed worktree. A separate delivery branch rebases them onto ba9a45570 in the bound
delivery checkout; no installed application, service, account or credential is modified.

The three conflict owners are responses/core.ts, fetch-helpers.ts and ws-upstream.ts.
Every send keeps the selected-account WS quota observer AND Reserve's beforeDispatch guard.
The existing public observer stays the fifth optional WS argument; admission is sixth.
Local refusal occurs before dialing and again before send, cleans up metadata/listeners,
and cannot enter HTTP fallback. Current metadata prelude and no-post-send-resend behavior
remain intact. No connection pooling or new Reserve grant semantics are introduced.

The existing Reserve WS fixture now emits response.created for successful canonical WS
requests, matching the already-landed metadata prelude contract. Its call sites use the
sixth guard argument; positive coverage verifies both handshake checks and separate quota
observations before/after Response commit. Original refusal, zero-send, no-fallback and
listener-detachment assertions remain. These changes are authored for CI, not run locally.

The two outstanding public Reserve findings are checked against latest source: canonical
provider/adapter references already document the account-only contract; ae3's terminal
vision helper fence remains present at Chat ingress and final dispatch. Final independent
review must verify these dispositions and the rebase delta before SHA-pinned admin merge.
Actual upstream Reserve availability was not manufactured or tested with a live account.
