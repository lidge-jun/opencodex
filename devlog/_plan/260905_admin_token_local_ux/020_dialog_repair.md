# 020 — Repair the dialog itself

Work-phase `wp2`. Criteria `c-2`, `c-3`, `c-4`. Landed in #3491 and #3493.

Two defects in one surface, deliberately split across two PRs because they have
nothing to do with each other beyond sharing a file.

## #3483 — the empty red notice

`gui/src/admin-token-dialog.ts` builds the error element up front and hides it
with the `hidden` attribute. That works only because the UA stylesheet says
`[hidden] { display: none }`, and `gui/src/styles.css` overrode it:

```css
.notice { ... display: flex; ... }
```

Author origin beats user-agent origin. **Specificity never enters the
comparison** — which is why this looked like a validation false-positive and why
a `.notice[hidden]` fix would have been the wrong shape (it would still lose to
the three-class `.startup-runtime-notice` rule at `0,3,0`).

The repository had already solved this exact problem once, in
`gui/src/styles-combos-workspace.css`, where a bare `display: flex` left both
tab panels painted at once. That comment block is the precedent this fix
follows: move the display onto `:not([hidden])`.

Applied to `.notice`, `.notice-warn` (used without `.notice` in several places),
and `.notice.notice-warn.startup-runtime-notice`.

### Testing this required two tests, not one

happy-dom applies no author stylesheet and performs no layout, so
`expect(alert.hidden).toBe(true)` **passes today, unfixed**, while a real browser
paints the box. A DOM assertion cannot see this class of bug.

So the DOM test asserts the notice is hidden AND empty on open (keeping the two
halves of "no error" from drifting), and a second test reads `styles.css` and
fails any `.notice` rule that sets `display` without the guard. The second was
driven red by reverting the CSS before being accepted.

## #3353 — the box that explained nothing

The dialog's only text was a title naming an environment variable. A user who
had never set one had no way in.

Ground truth, verified in source rather than assumed:

- the proxy writes the token to `getConfigDir()/admin-api-token` on first start
  (`src/lib/admin-secrets.ts`), `0600`, matching `/^ocx_admin_[A-Za-z0-9_-]{43}$/`
- `OPENCODEX_ADMIN_AUTH_TOKEN` replaces it entirely and is not regex-checked
- **no CLI prints it.** `ocx doctor` deliberately reports presence without ever
  returning a value

That last point is worth stating in the docs explicitly rather than omitting:
hunting for `ocx token` is the obvious next move, and silence about it wastes
the user's time.

The dialog now carries a help paragraph plus a link to a new
"Finding the admin token" anchor, styled like the existing in-app docs links
(`target="_blank"`, `rel="noreferrer"`, accent colour) per
`gui/src/pages/dashboard-dialogs.tsx`. Copy landed in all nine locales;
`gui/tests/i18n-locales.test.ts` enforces key parity.
