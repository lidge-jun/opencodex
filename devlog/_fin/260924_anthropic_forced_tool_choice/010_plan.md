# Anthropic forced tool choice and Opus 5.5

## Scope
One implementation unit: inspect adapter-generated body and live status for required/named/auto tool choices on Opus 5.5 and a control, with and without explicit reasoning. A current token is read only; no proxy starts and no token/body is printed.

## Hypotheses
H1: adaptive thinking and forced any/tool conflict; falsifier is a 2xx live response for the same adapter-produced body.
H2: Opus 5.5 rejects forced any/tool regardless of thinking; falsifier is a 2xx response with thinking omitted or disabled.
H3: proxy/router rather than upstream is responsible; falsifier is the same upstream error from the adapter-produced request.

## Diff-level plan
If live evidence confirms H1, change only src/adapters/anthropic.ts around its reasoning and tool_choice construction, retaining forced any/tool and suppressing or disabling thinking only when live evidence proves the wire shape works. Add a focused test in tests/adapters/anthropic/ proving required/named semantics and unaffected auto/none cases. Update owning structure document if required; test the focused file, typecheck, structure:check, privacy:scan. Obtain gpt-6-sol adversarial review, push one branch and open a template PR to dev. Do not run the full suite, merge, or touch main/preview.

## Audit and outcome

Live adapter-generated probe, 2026-09-24, using the active Anthropic OAuth access token read
in memory from `~/.opencodex/auth.json` (token and response bodies were never printed). The
probe sent 12 small Messages requests through `createAnthropicAdapter(...).buildRequest()`;
the pre-fix wire fields and status were:

| Model | Effort | Choice | Wire choice | Thinking | Status |
|---|---|---|---|---|---:|
| claude-opus-5-5 | medium / omitted | required | any | adaptive / omitted | 400 |
| claude-opus-5-5 | medium / omitted | named | tool | adaptive / omitted | 400 |
| claude-opus-5-5 | medium / omitted | auto | auto | adaptive / omitted | 200 |
| claude-opus-5 | medium / omitted | required | any | adaptive / omitted | 200 |
| claude-opus-5 | medium / omitted | named | tool | adaptive / omitted | 200 |
| claude-opus-5 | medium / omitted | auto | auto | adaptive / omitted | 200 |

After the fix, the same 12 requests returned 200. Opus 5.5 required/named choices are sent
as `auto`; Opus 5 keeps `any`/`tool`. This agrees with Anthropic's published migration guide:
https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5 (forced tool use is
unsupported for Opus 5.5; `auto` and `none` are supported). The compatibility downgrade
preserves a named or allowed tool's candidate set and preserves `disable_parallel_tool_use`,
but it cannot preserve the upstream forced-call guarantee.

For completeness, two supplementary requests manually overrode the adapter body to send
`thinking:{type:"disabled"}` together with `tool_choice` `any` and `tool`. Both returned
HTTP 400. The published guide also states that Opus 5.5 rejects disabled thinking, so there
is no thinking-off wire shape that can retain forced tool use for this model.

## Plan reflection after vendor source check
Official Opus 5.5 change guide (https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5, read 2026-09-24) says thinking cannot be disabled and any/tool forced choices return 400; auto/none are supported. This falsifies a semantics-preserving repair for Opus 5.5. If the adapter-generated live probe agrees, change only Opus 5.5 forced choices to auto and explicitly document that required/named callers lose the guarantee; preserve the choice where upstream accepts it. The guide says the same restriction applies to Fable 5.1, but that model needs separate live or test evidence before expansion.
