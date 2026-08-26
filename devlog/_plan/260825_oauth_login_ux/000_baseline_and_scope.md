# 000 — OAuth login UX: baseline, pain points, and work-phase map

Unit opened 2026-08-25. Session `01a036cb-4f1c-7b81-8c8d-277f92c914a7`.
Goalplan slug `fix-oauth-login-remote-headless-ux-in-opencodex`.

## Baseline

| Ref | SHA |
|-----|-----|
| `origin/dev` | `bb89eafbe` |
| `origin/main` | `71c57ea64` |

## The pain points, as reported

These are the operator's own words, recorded before any code was read. Every
work-phase in this unit traces back to one of them.

> 지금 oauth 로그인 + 원격 지원이 너무 불편하다
>
> 1. 이미 프로바이더가 추가된 상태에서는 링크를 복사할 수 있지만 → 첫 추가 때 못함
>    → 링크 복사 못함, 크롬 다른 프로필 못함
> 2. 프로바이더 추가도 링크는 보이지만 device 로그인을 하기가 좀 불편함. GUI에서
>    코드 붙여넣기가 있는 그록이나 claude 쪽도 약간 불편함

In English, for the issue tracker:

1. **The first add is the worst experience.** Once a provider exists, its
   workspace panel shows the authorization URL with a copy button. During the
   very first login — the one where the operator has no other way in — that
   affordance is not there. No copyable link means no way to open the URL in a
   *different* Chrome profile, and no way to finish the login from another
   machine.
2. **Device login is awkward in the GUI**, and the paste-a-code providers
   (xAI Grok, Anthropic Claude) are awkward too.

## What the code says

The report is accurate, and the cause is a split that nobody planned. Two
login surfaces exist and each one has exactly the half the other is missing.

| Affordance | Workspace panel (existing provider) | Add-provider modal (first add) |
|------------|-------------------------------------|--------------------------------|
| Authorization URL + copy | yes | **no** |
| Device / user code + copy | yes | **no** |
| Paste redirect URL or code | **no** | yes |
| Cancel | yes | no |

- `gui/src/components/provider-workspace/ProviderAuthPanel.tsx` renders the
  URL and the device code, and has no paste input anywhere in its 568 lines.
- `gui/src/components/add-provider-oauth-pane.tsx` renders the paste input,
  and its `LoginUrlBlock` is fed by a hook that never reads `deviceCode`.
- `gui/src/components/use-add-provider-oauth.ts` parses the login response as
  `{ url, instructions, error }`. The server returns `deviceCode` as well
  (`src/server/management/oauth-account-routes.ts`); the modal discards it.
- The Accounts tab of the add-provider modal
  (`gui/src/components/provider-catalog/ProviderCatalog.tsx`) starts a login
  through `Providers.tsx`, which stores the hint in `loginInfo` — read only
  by `ProviderAuthPanel`. During a first add the modal is on screen and the
  panel is not, so the hint is computed, stored, and never displayed.

That is the whole of pain point 1: not a missing feature, a hint with no
renderer.

## The remote half

`POST /api/oauth/login` calls `openUrl(authUrl)` unconditionally whenever a
browser flow returns a URL. `src/lib/open-url.ts` shells out to `open` /
`xdg-open` / `rundll32`, which means the **OS default browser profile** —
the operator cannot send it to a second Chrome profile, and on a headless or
SSH host the spawn is simply lost. There is no opt-out today: not a request
field, not a config key, not an environment variable.

## Work-phase map

| Phase | Doc | Deliverable |
|-------|-----|-------------|
| WP1 | this unit | Docs-only roadmap at diff-level precision |
| WP2 | `010` | One login-hint component: URL + device code + paste, on all three surfaces |
| WP3 | `020` | First-add parity: the hint renders inside the add-provider modal |
| WP4 | `030` | Operator control over server-side browser auto-open |
| WP5 | `040` | Paste normalization and survivable failures |

One work-phase is one full PABCD cycle, one decade doc, one issue, one PR
against `dev`.

## Scope boundary

Out of scope, stated once:

- Token storage format, credential refresh, and the account store schema.
- New providers or adapters, account-pool routing, quota surfaces.
- `src/lab/` — the core-lab boundary test exists for a reason.
- Publishing, releasing, or merging anything.

## Security invariants this unit must not break

These are already load-bearing in the code and a UX change is not permitted to
soften them:

- `src/oauth/github-copilot.ts` constructs its verification URL locally and
  refuses a non-allowlisted one; a server-supplied `verification_uri_complete`
  is never handed to `openUrl`.
- `src/oauth/callback-server.ts` enforces state on `url`/`query`-shaped
  pastes and exempts only a syntactically raw in-session code.
- `src/oauth/index.ts` bounds a pasted payload at 4 KiB and validates it
  synchronously before it reaches the flow.
- No token, authorization code, or request body may be logged.

## Evidence rule

A remembered pass is not evidence. Every completion claim carries exact command
output, the issue and PR numbers, the head SHA, and the CI conclusion on it.
