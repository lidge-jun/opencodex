# 062 — p3193 landing

- Reimplementation PR: #3205 `fix(server): allow POST /v1/alpha/search on the loopback listener`, branch `codex/260902-p3193-loopback-alpha-search`, head `1b21bd652`.
- Admin squash-merge → `53c09a247` on `dev`; ancestry proven with `git merge-base --is-ancestor 53c09a247 origin/dev`.
- #3193 closed with a credit comment pointing at the landed SHA (author co-credited in the commit). #3192 was already closed.
- Audit: reviewer subagent (xai/grok-4.6) failed the first pass on docs-site allowlist drift (en/fr/zh-tw/tr) and the stale "four allowlisted routes" title; both fixed, second pass passed.
- Check receipt: `.codexclaw/evidence/01a05dad-de70-7522-87a0-b82747a6d34c/test-receipt.json` — 29 pass / 0 fail on the loopback file; typecheck and privacy:scan clean.
- Test note: in the test environment the admitted path answers 503 (native-main maintenance gate) rather than the relay's 401; the assertion accepts either and rejects 404, which is what proves the gate opened.
- Trailing CI on `dev` tracked in the regaudit work-phase.

