# Plan-credential feasibility — research

Research doc. No diffs here (LEXICO-SPLIT-01); the implementation shape lives in the
decade docs.

> **Outcome: this research closed wp2 as a `NOOP` negative (see `020`), and is now
> superseded by `003`.** At the time of writing no login had completed and no credential
> existed on this machine. The owner has since logged in and authorized the work; `003`
> records what became measurable, including the finding that the OAuth access token does
> NOT authenticate the Model API while a sibling API key does.

## The docs were not the whole truth

`001` §G recorded that no third-party OAuth flow is published, sourced from a docs-site
search returning *No matching results for "OAuth"* and from Authentication's flat
"Every request to Meta Model API needs an API key". Both readings were accurate.

**The conclusion drawn from them was wrong.** A browser-approval login does exist; Meta
just does not document it. Measured on 2026-09-03 by installing the CLI and running it:

```
$ muse login
Open this page to sign in:
  https://auth.meta.com/oauth/device/?code=<expired-code>
confirm this code matches:
  <expired-code>

Waiting for approval…
```

That is **device-code-shaped**: a user code approved in a browser against
`auth.meta.com/oauth/device`. It is deliberately not called RFC 8628 here. A user-code
URL does not establish the token endpoint, scopes, rotation, expiry semantics, or — the
part that actually matters — that any client other than Muse Code may hold the result.
`muse login --help` says only: "Log in with your Meta account: approve a code in your
browser. META_API_KEY always takes priority over the account login."

The lesson worth keeping: **absence from a vendor's docs is not absence from the
product.** A docs search proved what Meta publishes, and I let it stand for what Meta
implements. One `--help` disproved it. The opposite error was available too, and the
A-gate caught it: finding an undocumented flow is not the same as being allowed to use
it.

## What the CLI actually is

`muse --version` → `Muse Code 1.0.2 (1.0.2-R2040.1)`, installed to `~/.local/bin/muse`
by `https://dev.meta.ai/install.sh` (which fetches a launcher from
`https://api.meta.ai/muse-launcher.sh` and verifies a sha256).

Subcommands relevant here: `login`, `logout`, `auth set --api-key-stdin`, `serve`,
`exec`, `schema`.

Its own reasoning ladder, from `muse --help`:

> `--reasoning-effort <EFFORT>`  Meta reasoning effort: none|minimal|low|medium|high|xhigh|ultra (default: high)

Note `ultra`, which the public `/docs/reasoning` page does not list. Another instance of
the same gap. The registry ladder in `010` stays with the twice-corroborated
`minimal..xhigh` set, because `ultra` here is a CLI flag rather than a proven Model API
wire value, and Zen's probe rejected it.

## `muse serve` is not an OpenAI-compatible endpoint

The A-gate reviewer raised the published SDK
([meta-models/muse-code-sdk](https://github.com/meta-models/muse-code-sdk), HTTP 200) as
a route the categorical negative overlooked. It is a real route, and it is not the route
we want.

`muse serve --help`: "serve an MSP session host over **stdio**. The client owns this
process's stdin and stdout and is its only connection."

MSP is a JSON-RPC **agent session** protocol — `session/start`, `turn/start`,
`approval/decide`, `item/delta`, `subagent/*`, `view/page`. It owns the tool loop,
approvals, sandbox posture, and session durability. opencodex is a **model proxy**: it
forwards Responses/Chat requests and returns completions. Bridging MSP to
`/v1/responses` would mean re-hosting an entire agent runtime inside the proxy and
then discarding the half that makes it an agent.

So the SDK is correctly out of scope — but for an architectural reason, not the licence
reason `020` originally gave. The reviewer was right that the stated ground was wrong.

## The three routes, ranked

| Route | Mechanism | Status |
|---|---|---|
| Direct API key | `MODEL_API_KEY` on `https://api.meta.ai/v1` | Implementable now, spec-only. **wp1.** |
| Device-code-shaped login | `auth.meta.com/oauth/device`, as `muse login` uses | Exists but undocumented; **wp2 closed `NOOP`** — the credential is licensed to Muse Code only. |
| MSP host bridge | `muse serve` over stdio | Out of scope: wrong protocol class. |

## Why the investigation stopped here

No login was ever approved. Both attempts were terminated with the grant pending, and a
targeted check for a Muse credential on this machine found none.

The original next step was to complete a login and measure where the credential lands,
what it is, and whether it authenticates `https://api.meta.ai/v1`. That plan was
abandoned on review, and the reason is worth stating plainly: **it was a test for
whether enforcement is absent, not for whether use is permitted.** Meta answered the
second question in writing before anyone asked (`001` §E). Discovering that a
restriction is unenforced does not lift it, so completing the measurement could not have
produced a result that licensed shipping.

A third-party report (Threads, 2026-09-03) claims the stored key is plaintext in the
macOS Keychain and that the endpoints are not separated. Both remain **unverified**, and
neither changes the outcome: the second, if true, is precisely the enforcement-absence
observation above.

## The licence question is the whole answer

`/docs/muse-code/subscriptions` says the subscription credential is "for use with Muse
Code only". Whether the artifact `muse login` stores **is** that credential was never
measured — no login completed — so the link is inferred from Meta's own description of
the CLI onboarding, not proven here. It does not need to be proven: `muse login` is the
Muse Code CLI's own sign-in, so any credential it yields is at best that credential and
at worst something with even less claim to third-party use. Either way the restriction
binds.

Mechanism and entitlement are separable questions, and only entitlement decides whether
anything ships. The vendor has answered it.

`src/oauth/index.ts` already carries the adjacent precedent on Anthropic —
`defaultRefreshPolicy: "disabled"`, with a comment recording that the vendor
server-side-blocks subscription OAuth outside its own clients. That posture mitigates a
risk on a flow that already exists; it does not authorize creating a new one against a
published prohibition.
