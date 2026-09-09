# 002 — Plan audit: what ships, what does not, and how it splits

## The one-sentence diagnosis

Nothing here is missing infrastructure. The server already computes the
authorization URL, the device code, and the manual-paste channel; four GUI
surfaces each render a different subset of it, and one of them renders none of
it at the exact moment the operator has no other option.

## Candidate list, and the cut

Eleven changes were on the table after reading the tree. Four ship in this
unit. The rest are recorded here so a later cycle does not rediscover them.

### Shipping

| WP | Change | Why it is in |
|----|--------|--------------|
| WP2 | One login-hint component: URL + device code + paste on all surfaces | Directly answers pain point 2; every other GUI fix depends on it existing |
| WP3 | The hint renders during a first add | Directly answers pain point 1 |
| WP4 | Operator control over server-side auto-open | The "다른 Chrome 프로필" half of pain point 1, and the whole remote story |
| WP5 | Paste normalization: hash-fragment redirects | A real paste that looks valid and is silently rejected today |

### Deferred, with reasons

- **Expiry countdown / poll interval in the GUI.** The polling math is already
  correct in each provider; showing it is additive UI over a DTO that does not
  carry `expiresAt` yet. Real, but not a pain point that was reported.
- **Kimi allowlisting of `verification_uri_complete`.** Kimi and Nous pass the
  provider-supplied complete URI into `onAuth`. Copilot refuses to
  (`github-copilot.ts:393`). Tightening Kimi/Nous is a **security** change,
  not a UX change, and it does not belong in a PR whose title says "GUI". It
  gets its own issue.
- **`openUrl` returning success/failure.** Attractive, but the spawn is
  detached and a browser that opens then fails is indistinguishable from one
  that never launched. A truthful signal needs more than an exit code.
- **A browser/profile picker in the GUI.** WP4 gives the operator the
  *ability* to not have their default profile hijacked. A full picker is a
  product surface, and the operator asked for control, not a picker.
- **`ocx login` re-prompt loop.** The CLI's one-shot readline is a smaller
  version of the same bug, on a surface nobody reported. Own issue.

## The default-preservation rule

WP4 is the only phase that can change what already happens, so it carries the
strictest constraint in this unit: **auto-open stays the default.** An
operator who upgrades and does nothing must see byte-identical behavior. The
new capability is an explicit choice, never an inferred one.

That rules out the tempting version of this feature — sniffing
`SSH_CONNECTION` or an absent `DISPLAY` and silently declining to open. A
false positive there (X11 forwarding, WSLg, a desktop session that does not
advertise itself) breaks a login that works today, and breaks it silently.
Explicit opt-out first; inference is a separate decision with its own
evidence.

## Security invariants, restated as gates

A PR in this unit fails review if it:

1. Hands a provider-supplied `verification_uri_complete` to `openUrl`.
2. Weakens state enforcement on `url`/`query`-shaped pastes
   (`callback-server.ts:252`, `index.ts:1347-1350`).
3. Accepts `access_token` from a URL fragment — hash parsing in WP5 reads
   `code` and `state` only, never a token.
4. Raises the 4 KiB paste bound or the 4096-char route cap.
5. Logs a URL, a code, a token, or a request body.
6. Passes a shell string where an argv array is required.

## Dependency order and the PR stack

```
WP2 (shared hint component)
 └── WP3 (first-add parity — renders the WP2 component)
WP4 (auto-open control)      ← independent
WP5 (paste normalization)    ← independent
```

WP3 stacks on WP2 because it mounts the component WP2 creates. WP4 and WP5
touch disjoint files and target `dev` directly.

| WP | Issue template | PR base | GUI screenshot |
|----|----------------|---------|----------------|
| WP2 | feature_request | `dev` | required |
| WP3 | bug_report | WP2 head | required |
| WP4 | feature_request | `dev` | required if GUI toggle lands |
| WP5 | bug_report | `dev` | not required |

## Verdict

PASS. Four phases, dependency-ordered, each with a falsifiable test and a
bounded diff. The audit's one binding instruction to later phases: WP4 must
ship the explicit choice and must not ship inference.
