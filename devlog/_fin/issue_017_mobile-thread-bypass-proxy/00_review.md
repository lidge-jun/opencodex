# Issue #17 — Mobile-created Codex threads may bypass local opencodex proxy

- **Reporter:** 0disoft (ZeroDi); maintainer reply by lidge-jun
- **URL:** https://github.com/<repo>/issues/17
- **Type:** Compatibility limitation (Codex platform behavior) / documentation
- **Severity:** Medium — sharp trap (model selectable, then fails on first turn);
  reliable workaround exists.
- **Status:** Likely a Codex mobile/remote-thread platform limitation, not an
  opencodex proxy defect. Pending reporter repro on latest version. Documentation
  + known-limitation note recommended (no code change implied).

## Report summary

Routed models work when the Codex thread is **created on the local desktop**
(then continued from mobile). But when the **thread is first created from mobile**
targeting the laptop/remote host, the first routed-model turn fails before
reaching the local proxy with:

```
400 invalid_request_error:
"The 'umans/umans-glm-5.2' model is not supported when using Codex with a ChatGPT account."
```

Reporter's 4-case matrix (issue comment) shows the determining factor is **which
surface creates the thread first**, not which model:

| First surface | Later surface | Result |
| --- | --- | --- |
| Laptop / routed | Mobile / GPT | Works |
| Laptop / GPT | Mobile / routed | Works |
| Mobile / routed | Laptop / GPT | Fails on mobile; local `read_thread` can't find the thread id |
| Mobile / GPT | Laptop / routed | GPT works; later routed turn fails with same error |

`read_thread` could not find mobile-first thread ids locally, which strongly
suggests those threads never reached the local proxy.

## Analysis

The error string is ChatGPT-account **model-policy validation**, emitted by
Codex / the ChatGPT backend **before** the request is routed to the local
opencodex proxy. When a thread is created on mobile, it appears to be
created/owned in a cloud/remote context that validates the model against the
ChatGPT account's allowed set (which does not include routed/custom models), so
the routed model is rejected up front. Desktop-created threads are pinned to the
local host/provider context, so routed models reach the proxy.

This is consistent with the maintainer's reply (lidge-jun):
- Thread affinity is now explicit — once a thread starts on a specific account it
  stays pinned regardless of where later turns originate.
- The auto-start shim (`ocx codex-shim install`) ensures the proxy is running
  before Codex launches.
- Maintainer cannot reproduce on the current setup and asked for repro details
  (which routed model on mobile, was the proxy confirmed running, was the model
  absent or present-then-failing in the picker, still seen on v2.1.11+).

The opencodex-side touchpoints that bound this behavior:
- Thread/account affinity: `src/codex-routing.ts`, `src/codex-auth-context.ts`
  (`CodexThreadAffinityExpiredError` handling in `server.ts` ~L398).
- Local history visibility: `src/codex-history-provider.ts` (`read_thread`).

## Proposed resolution (no code change required)

Primary: treat as a **documented known limitation** plus a repro request.

1. README / troubleshooting note: routed-model threads should be **created from
   the local desktop Codex session first**, then continued from mobile. Mobile-first
   creation of a routed-model thread is validated by ChatGPT-account model policy
   and is expected to fail before reaching the local proxy. This is a Codex
   mobile/remote-thread limitation, not a proxy bug.
2. Optional diagnostic nicety (only if cheap): when a `... is not supported when
   using Codex with a ChatGPT account` error is observed, surface a hint pointing
   to the desktop-first workaround. Low priority.
3. Keep the issue open pending the reporter's answers on a recent version
   (v2.1.11+). If it no longer reproduces with explicit thread affinity, close
   with the documented limitation.

## Verification approach

- Re-run the 4-case matrix on the latest version with explicit thread affinity.
- Confirm whether mobile-first routed threads ever reach the local proxy
  (`read_thread` / `/api/logs`); if they never do, it is confirmed upstream
  (Codex) behavior and only documentation applies.

## Effort & risk

- Effort: minimal (docs + a repro follow-up). No code fix is warranted unless a
  reproducible case shows the request reaching — and being mishandled by — the
  local proxy.
- Risk: none (documentation).
