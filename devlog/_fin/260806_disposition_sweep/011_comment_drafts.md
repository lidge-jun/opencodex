# 011 — wp1 comment drafts (to be audited before posting)

All comments post as the maintainer. English, per repo review policy.

## 1. PR #1036 — review (REQUEST_CHANGES)

> Thanks — the structured `edit_file`/`multi_edit` + server-side translation
> approach is the right direction for #1017, and we want to land it. Two
> gaps block it today:
>
> 1. **Synthetic-tool provenance.** Conversion keys on the bare tool name.
>    If a client already exposes its own `edit_file`, its calls would be
>    translated too. Track the synthetic names injected for *this request*
>    (a per-request set threaded from tool-catalog construction to the
>    conversion site in `src/adapters/cursor/protobuf-events.ts` /
>    `live-transport.ts`) and convert only those.
> 2. **Final-catalog derivation.** Structured-edit availability is derived
>    from the original request rather than the final prompt-filtered tool
>    catalog; when filtering drops the tools the flag is stale.
>
> A regression test for each (client-owned `edit_file` passes through
> untouched; filtered catalog disables translation) and we can re-review it.

## 2. Issue #919 — close (not planned)

> Closing after a policy review. What the report shows is real and was
> reproduced, but the behavior is the intended account-health policy:
> post-200 transport failures count against the account so that persistent
> upstream trouble rotates traffic away. Treating a mid-stream socket reset
> as never-account-attributable would mask genuinely unhealthy accounts,
> and `terminalSource="synthetic"` alone does not establish that the reset
> was network-local — especially on the eager relay path.
>
> The right evolution here is a transport-attribution policy (classifying
> post-200 failures before they touch affinity), which is an enhancement,
> not a defect fix. Happy to reopen against a concrete attribution
> proposal, or a repro isolating a non-network cause for the resets.

## 3b. Issue #1091 — status comment (keep open)

> This is a legitimate request and we want to support it; flagging why it
> is not a quick change. The pool-eligibility gate that rejects non-default
> base URLs (`src/config.ts` provider validation) is deliberate: OAuth
> tokens for chatgpt.com must not be sendable to an arbitrary URL by a
> config edit, so lifting the restriction needs an explicit trust design
> (allowlist semantics, SSRF/private-network policy, and tests for header
> and account-selection behavior against a custom upstream). Keeping this
> open as a design-needed enhancement.

## 4. PR #1068 — comment (stays open)

> The registry slice looks right: the missing `opencode-zen` metadata is
> exactly what breaks reasoning replay there, and the focused tests cover
> it. Two things before this can land: (1) the branch is currently
> conflicting with `dev` — please rebase; (2) the tests exercise a
> synthesized adapter context only — an end-to-end regression for a real
> Claude Messages continuation (thinking block replayed on the second
> request) would prove the fix where users hit it. Note #994 stays open
> either way: the Claude `/v1/messages` replay path dropping thinking is a
> separate gap from the Zen registry fix.

## 6. Issue #1059 — status comment (keep open)

> Status: the Windows leg stays dispatch-only. Plan of record: burn down
> the ~207 failures shard by shard (management/server fixtures first, then
> platform process semantics), restore the gate only after a full green
> Windows run on `dev`. Shard-scoped PRs welcome; each should name the
> shard and the failure class it eliminates.

## 8. PR #1019 — comment (stays open)

> Thanks for keeping this current against `dev`. As one PR this is not
> reviewable to the standard account-lifecycle code needs: 106 files /
> +4,786 lines touching account routing and credential lifecycle. Please
> split into slices, roughly: (1) settings schema + defaults, (2) selector
> initialization, (3) catalog convergence handling, (4) management API +
> GUI. Each slice with its own tests and green hygiene gate. The feature
> itself is wanted; the shape is the blocker.

## 9. agentHits PR closes (5)

### PR #1084 — close

> Closing this draft for now — the direction (Antigravity account pool) is
> wanted, but the current cut implements configuration without the runtime
> that would use it: (1) no pool-routing consumer reads the added config;
> (2) the cooldown endpoint accepts `google-antigravity` but calls
> `clearAnthropicAccountCooldown`, which only clears the Anthropic health
> map (`src/server/management/oauth-account-routes.ts` →
> `src/oauth/anthropic-routing.ts`) — a functional no-op for the new
> provider; (3) quota parsing duplicates existing logic. Please reopen (or
> open fresh) with a slice that wires a real consumer first — a generic
> pool-routing path for Google accounts — and we will review it properly.

### PR #1083 — close

> Closing this draft — the account filter currently changes the badge
> only; every metric underneath remains provider-aggregated, so the
> feature it advertises (#1063, per-account usage) is not delivered by
> this diff. The missing piece is the data path: per-account usage
> attribution at write time, then a filtered read. Please reopen once the
> selector actually filters the aggregation; the UI shell here can come
> along with it.

### PR #1081 — close

> Closing this draft — it does not compile: all six locale files gained a
> bare string literal after a value (`"prov.expiresAt": "...",
> "Accounts ({n})",`), which is invalid TypeScript. Separately, the value
> shown is the OAuth token expiry, which renews — labeling it
> "subscription/plan expiration" (#1060) is misleading; plan expiry needs
> a real subscription source. Please reopen with compiling locales and a
> data source that actually reflects plan expiration.

### PR #1079 — close

> Closing this draft — the six locale files have the same invalid-syntax
> issue as #1081 (bare string after a value), so it does not compile. The
> server-side range extension is plausible and worth salvaging, but the
> promised daily model breakdown (#1058) is absent, and "yesterday" is a
> rolling 24h window rather than a calendar day. Please reopen with
> compiling locales, the breakdown implemented, and calendar-day
> semantics (or a documented choice).

### PR #1077 — close

> Closing this draft — closest of the batch to landing, and the token
> refresh validation is done right. Blockers: (1) refresh tokens are
> accepted via argv, which leaks into shell history and process listings —
> take them via file path or stdin only; (2) the GUI change ships without
> the required screenshot evidence; (3) credential import is a
> security-sensitive surface and needs a maintainer-sponsored review
> pass. Please reopen with file/stdin-only input and the GUI evidence;
> this one we would like to take.

## 9b. agentHits issue comments (6 — same text, issue-adjusted)

For #1062/#1063/#1060/#1058:

> Keeping this open — the idea is wanted. The draft PR attached to this
> campaign was closed with specific technical feedback (see the PR
> thread); the ideas stay tracked here. What gets a fast review: small,
> rebased, independently testable slices that wire the runtime/data path
> first and the UI second, one concern per PR.

For #1076:

> Keeping this open — Cockpit Tools import is the piece of this campaign
> we most want to take. PR #1077 was closed with specific feedback: accept
> refresh tokens via file path or stdin only (argv leaks into shell
> history and process listings), include the required GUI screenshot
> evidence, and expect a maintainer-sponsored security review on the
> credential-import surface. A reopened PR addressing those three lands on
> a fast review track.

For #1082:

> Keeping this open — quota/reset-time display is a good fit once the
> per-account data path exists. The related campaign PRs were closed with
> technical feedback (see #1084/#1083 threads): the blocker is that
> current drafts render UI over provider-aggregated data with no
> per-account runtime consumer. A slice that wires the quota probe data
> path first, then the display, is welcome.

## 10a. PR #1085 — comment

> Verdict from triage: READY pending a credential-destination security
> pass, since the change affects which loopback destinations models stay
> visible for without an env export. No code defects found; the branch is
> current against `dev`, so after the security pass and a green rerun it
> is ready for final review.

## 10b. PR #997 — comment

> Still wanted — the fixture isolation is correct and the setup/teardown
> restores the environment properly. It has drifted far behind `dev`
> (~142 commits); please rebase so CI can rerun on current code. Low
> conflict risk expected; after a green run it is ready for maintainer
> review.
