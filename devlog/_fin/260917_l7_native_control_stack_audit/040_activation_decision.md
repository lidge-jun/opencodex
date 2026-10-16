# 040 — stack hygiene, upstream evidence, and what to do next

## No repository CI has run on any of the four heads

Read on 2026-09-17, every one of the four pull requests shows the same five
checks and no others: `enforce-target`, `hygiene`, `label`, `resolve-pr` and
CodeRabbit. The repository's own typecheck and test matrix has not run at any of
these heads. The verification tables in the pull request descriptions are real
but they are fork runs under `luvs01/opencodex`, not this repository's CI.

```bash
for n in 4782 4858 4861 4864; do gh pr checks "$n"; done
```

This lane therefore cannot report exact-head CI evidence for the stack, and
neither can the PR authors: contributor pull requests cannot start repository CI,
so a maintainer dispatch is required. Three of the four (#4858, #4861, #4864) are
still drafts, and CodeRabbit skips drafts, so even the automated review only
covers #4782 and #4864.

## The stack is five deep, not four

`#4868` (`codex/steering-completion-20260917`, head `15a8e715851d`, draft) is a
child of #4864 and adds "safe steering settings overrides, public API transport
and executable probes". It declares base `dev` like the rest. Any decision about
activation scope has to account for it, because it widens the settings a
continuation may change — which is the pin C1 currently relies on.

All five should use the stacked-child workflow from `AGENTS.md`: target the
parent's head branch while the parent is open, and retarget to `dev` once it
lands. `enforce-target` skips the wrong-base gate for those children. Doing that
would also make each PR's GitHub diff show only its own stage.

## No available source proves the wire exists

At the pinned openai/codex checkout (`095da4b7e`), the client-to-server WebSocket
request enum has exactly one variant:

```rust
// codex-rs/codex-api/src/common.rs
pub enum ResponsesWsRequest<'a> {
    #[serde(rename = "response.create")]
    ResponseCreate(ResponseCreateWsRequest<'a>),
}
```

There is no `response.steer` and no `response.inject` frame. Upstream steering is
a local mechanism — `codex-rs/core/src/session/input_queue.rs` queues pending
steers into the next turn's input — and `Feature::Steer` is registered
`Stage::Removed` with `default_enabled: true`, meaning always-on locally rather
than negotiated on the wire. `session/inject.rs` likewise injects into local
session state, not upstream. Nothing in the pinned tree sends
`responses_multi_agent=v1`.

The pull requests are honest about their source: both cite public
`developers.openai.com` guides, and #4858 states plainly that public API
documentation is not evidence that a ChatGPT subscription backend or a Codex
App/CLI build implements the same execution mode. That is the right caveat, and
it has a consequence the stack's framing should carry: on the canonical
ChatGPT forward route, no known client sends these frames and no captured wire
shows the backend answering them. The public API route in #4858 is the only leg
with published documentation behind it.

This does not argue against the code. It argues against enabling the canonical
route first, and for treating a captured wire exchange as the gate.

## Recommended order

1. Rebase #4864 onto #4861's head so the two corrections in `4670525d48` and
   `59a1d6357e` are inside the tested combination, and restack all five on their
   parents' head branches.
2. Maintainer-dispatch repository CI at each exact head, bottom-up. Until that
   exists there is no evidence this repository can cite.
3. Land #4782 → #4858 → #4861 → #4864 with both flags off. Every clause in 020
   holds at the tip, and default-off means landing them changes no behavior for
   any existing user.
4. Resolve #4850 before recommending `codexNativeInjection: true` to an operator
   (030).
5. Decide activation scope last, and decide the public API injection route and
   the canonical ChatGPT route separately. The first has documentation behind it;
   the second needs a captured wire.

Turning steering on first and finishing in production is the one order to avoid.
The steering channel is the layer whose waits were unbounded until #4864, whose
settings pin #4868 proposes to relax, and whose canonical route has the least
evidence. It is the last thing that should be enabled, not the first.

## Review comments filed

| PR | Point |
|---|---|
| #4782 | Stack topology and restacking; no repository CI at the exact head; upstream wire evidence gap on the canonical route |
| #4858 | `attach()` failure shares the `sseFallback` path with a send failure, permanently disabling injection for the turn |
| #4861 | Its two corrections are not in #4864's base; ask for a rebase rather than a carry |
| #4864 | Base divergence from #4861's head; per-stage deadlines are bounded but the owned connection's lifetime is not |
