# Local dcinside-cleaner v2.4 compatibility plan

## Loop specification

- Class: C4, because local code handles credentials and enables irreversible bulk deletion.
- Trigger: the user-selected GitHub v2.4 GUI fails current DCInside login; the user then explicitly replaced that approach with `agbrowse` browser automation and human-supervised login.
- Goal: use the dedicated `agbrowse` profile, verify the authenticated gallog account/counts, then run the already-confirmed all-post and all-comment deletions through the real DCInside web surface.
- Non-goals: Chrome-cookie extraction, credential persistence/logging, CAPTCHA bypass, proxy acceleration, upstream push, or publishing.
- Verifier: fresh interactive snapshots before/after every action, human-supervised login, pre-delete account/count gate, deletion response/DOM observation, and post-delete count refresh.
- Stop: DONE after both counts reach zero or BLOCKED on a surfaced CAPTCHA/IP/site-contract boundary.
- Memory: this unit plus the target clone's matching `devlog/_plan/260728_dcinside_login_compat/` evidence.
- Escalation: stop on account mismatch, missing target enumeration, or any need to bypass authentication/abuse controls.

## Threat model and RCA

- Assets: password, session cookies, account identity, and authored posts/comments.
- Boundaries: local PyQt/Requests process to official DCInside HTTPS endpoints; authenticated session to destructive gallog POSTs.
- Main risks: a wrong authenticated account would suffer irreversible deletion; automation could overrun rate limits or miss CAPTCHA; browser-evaluated scripts could mutate more than intended.
- Controls: user performs login, no credential/cookie extraction, pin the expected gallog path `energy6435` and nickname `ㅇㅇ`, verify counts before mutation, use only live-discovered same-origin DCInside requests, limit concurrency to the user-authorized 5-item batches, stop on CAPTCHA/IP errors, and refresh counts after each content class.
- H1 confirmed: `dcinside_cleaner.py:112-119` expects the form on `/`, but the current homepage has none and official JS fetches `/main/login_box`.
- H2 rejected: current official JS still posts to `https://sign.dcinside.com/login/member_check`.
- H3 open until smoke: credential validity; resolve only through human-supervised post-fix login, never by logging the secret.
- H4 rejected: disabled TLS already receives 200 and cannot explain the absent form.

## Scope

- No source changes.
- Operate only the `agbrowse` Chrome profile at `~/.browser-agent` and official `*.dcinside.com` pages.
- User enters credentials directly; the agent never reads, stores, exports, or retypes them.
- Stop if the account differs from `https://gallog.dcinside.com/energy6435/`, visible counts differ unexpectedly, or a CAPTCHA/IP block appears.
