# Outcome — Devin ACP adapter retired, Devin adapter given the tool-catalog nudge

Both work phases landed. This unit moves to `_fin` because every change it describes is now
visible in public git history on `dev`.

## What landed

| Work phase | PR | Squash on `dev` | Exact head CI |
|---|---|---|---|
| wp1 — unblock and land the open sync PR | [#4411](https://github.com/lidge-jun/opencodex/pull/4411) | `2d3c05fa9e` | green on `3049b6712e` |
| wp2 — retire ACP, migrate saved rows, add the nudge | [#4415](https://github.com/lidge-jun/opencodex/pull/4415) | `213065e30b` | green on `67fe08b5b2` |

## What the premise turned out to be

The ACP adapter existed because the design assumed OpenCodex could not hold a credential for the
installed Devin CLI, so driving a `devin acp` child was the only way to use it. The CLI's
`windsurf_api_key` is an ordinary `devin-session-token$<JWT>` — the same credential
`RegisterUser` mints for a browser sign-in, and one the cloud-direct client already speaks. Once
the token could simply be imported, the child process bought nothing and cost a placeholder
`buildRequest`, a disabled `parseStream`, an identity-only `baseUrl`, and a subprocess in the
operator's own tree.

Worth recording because the reasoning was inverted twice. The adapter was written on an untested
assumption, and then kept on a second one: that leaving it registered was harmless because
`routedProviderConfig` pinned the registry id away from it. That was true for the registry id and
false for the custom-named row the documentation itself recommended, which is exactly the row
that would have broken on removal.

## Corrections this unit made to its own starting assumptions

- The Devin CLI provider was described in-session as running over ACP. It does not, and has not
  since the account-login unit. The live evidence was already in the request log: a
  `"provider":"devin-cli"` row carries `"adapter":"devin"`.
- Token usage was believed missing for `devin-cli`. It is reported. The cloud-direct client
  decodes Cognition's `UsageStats` at proto field #28, so both provider rows record
  `usageStatus: "reported"` with real input/output/cached counts. What is absent is account
  quota: neither row appears in `supportsPerAccountQuota`, so the dashboard has no balance to
  show, and Cognition exposes ACU consumption only through Enterprise-scoped endpoints.

## Reviewer findings, all folded in

Four independent read-only reviews ran against this work. Each finding was fixed rather than
rebutted:

- the exact-system-content assertion in `tests/providers/devin-adapter.test.ts` that the nudge
  breaks, rewritten to a prefix plus a catalog substring;
- an empty `src/adapters/devin-cli/` directory left behind by the deletion;
- a second hardcoded copy of the Cognition host in the migration, now
  `DEVIN_DEFAULT_API_SERVER`;
- a GUI comment rewrite that was unrelated cleanup and, because the screenshot gate is
  path-based, would have asked a comment-only diff for a screenshot of nothing;
- on wp1, `structure/config.md` still claiming every deterministic preflight refusal leaves the
  catalog untouched, and `refreshOutcome` reaching callers undeclared.

## Known residual

`projectDevinCliAuthMode` matches the retired adapter id by exact string. A hand-edited
`"devin-cli "` or `"Devin-CLI"` would not be rewritten and would fail with
`Unknown adapter`. Left as-is deliberately: config validation already rejects an unknown adapter
id at load, and folding case or whitespace here would hide a typo rather than repair a known
historical value.

Locale `reference/adapters.md` pages still have no `devin-cli` section. That is pre-existing
translation lag, not ACP residue — they never documented the retired adapter, so nothing in them
contradicts the English source.

