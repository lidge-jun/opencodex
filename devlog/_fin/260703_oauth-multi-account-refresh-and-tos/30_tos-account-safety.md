# ToS / account-safety of multi-account pooling (Thread B)

Date: 2026-07-03
Owner: Boss (main session), PABCD Phase 0 build output.
Status: DONE (design pass). Grades on the MLB 20-80 scale (20 = highest ban risk, 80 = lowest).

Scope of the question (user's words): "이런걸로 tos 잡는 애들도 있잖아" — which providers catch/ban
you for pooling multiple accounts through a proxy, and does keeping tokens warm make it worse.

## The cross-cutting finding

Every consumer-subscription provider's terms bar the SAME three things: (1) sharing credentials /
routing others' requests through your seat, (2) circumventing or aggregating rate limits across
accounts, (3) programmatic/automated access to consumer-subscription endpoints (as opposed to the
sanctioned API-key path). **Proactive background refresh touches all three risk signals** because
it generates authenticated traffic with no user in the loop — the exact "automated access to a
consumer subscription" pattern. This is why `00_plan.md` gates the guardian per provider and
defaults it off.

The clean dividing line across all providers: **sanctioned API-key usage is fine; reusing
consumer-subscription OAuth tokens outside the vendor's own client is the risky part.** opencodex's
`authMode: "key"` providers are low risk; its `authMode: "oauth"` / `"forward"` consumer paths are
where this matters.

## Per-provider risk table

| Provider | Grade | Enforcement reality | Clause it rests on |
|---|---|---|---|
| **Anthropic (Claude Pro/Max OAuth)** | **20** | LIVE, server-side enforced | Consumer OAuth "intended exclusively for Claude Code and claude.ai"; use in any other tool/SDK "not permitted … violation of Consumer ToS". |
| **OpenAI (ChatGPT/Codex OAuth)** | **35** | Policy + flag/ban risk | "May not share account credentials"; may not "circumvent any rate limits"; multi-account to bypass limits → flag/ban. |
| **Cursor** | **35** | Behavioral detection | Account-bound usage; behavior monitoring forces logout on overlapping sessions / rapid location switch. |
| **Google (Antigravity/Gemini)** | **45** | Uncertain | General ToS bars automated abuse / limit circumvention; no pooling-specific clause verified. |
| **xAI (Grok)** | **50** | Uncertain | No citable pooling-specific clause found — unknown, not safe. |
| **AWS Kiro / CodeWhisperer** | **50** | Uncertain | AWS service terms bar circumvention; no pooling-specific clause verified. |
| **Moonshot Kimi** | **55** | Uncertain, lowest observed | More API-oriented; least evidence of consumer-subscription pooling enforcement. |

## Anthropic — grade 20 (headline)

In **February 2026** Anthropic added an explicit "Authentication and credential use" policy: OAuth
credentials from Free/Pro/Max plans are for Claude Code and claude.ai only; using those OAuth tokens
"in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes
a violation of the Consumer Terms of Service." Anthropic then deployed **server-side enforcement**
(reported Jan–Mar 2026): consumer-plan OAuth tokens now error outside Claude Code / claude.ai. The
stated motive was stopping "subscription arbitrage" by third-party harnesses (e.g. OpenClaw).

Implication for opencodex: routing Claude Pro/Max OAuth through the proxy is a *live, enforced*
violation today, independent of pooling. Proactive refresh would additionally generate exactly the
non-official-client traffic the server-side block looks for. → Default `refreshPolicy: "disabled"`,
plus a login-time ToS warning.

> 출처: [Anthropic bans subscription OAuth in third-party apps (WinBuzzer, 2026-02-19)](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
> 출처: [Anthropic "Authentication and credential use" policy — issue analysis (AndyMik90/Aperant #1871)](https://github.com/AndyMik90/Aperant/issues/1871)
> 출처: [Anthropic ends paid access for Claude in third-party tools (MLQ News)](https://mlq.ai/news/anthropic-ends-paid-access-for-claude-in-third-party-tools-like-openclaw/)

## OpenAI (ChatGPT/Codex) — grade 35

OpenAI's terms and account-sharing policy: "You may not share your account credentials or make your
account available to anyone else" and you may not "circumvent any rate limits or restrictions."
Using more than one account is not automatically banned, but switching accounts to bypass usage
limits risks getting accounts flagged/banned. Pooling many accounts through one proxy to aggregate
quota is squarely in the "circumvent usage limits" zone; one-real-human-per-account is greyer.
Proactive refresh of idle pool accounts raises the automated-access signal.

→ Default `lazy-only`; `proactive` is the explicit opt-in for users who accept this risk (this is
where the reported Codex-pool bug fix lives).

> 출처: [OpenAI Account Sharing Policy (Help Center)](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy)
> 출처: [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
> 출처: [OpenAI Services Agreement — usage limits](https://openai.com/policies/services-agreement/)

## Cursor — grade 35

Cursor subscriptions are account-bound with usage pooled across the machines you sign into, and
enforced via usage credits + account binding + behavior monitoring. Overlapping sessions from
different locations and rapid location switching trigger abuse checks — Cursor may force logout,
require identity verification, or restrict the newer device. Many pooled accounts behind one proxy
IP is a strong detection signal. The public ToS excerpt did not spell out a pooling clause verbatim,
so this grade rests partly on documented enforcement behavior.

→ Default `lazy-only`.

> 출처: [Cursor — Terms of Service](https://cursor.com/terms-of-service)
> 출처: [Cursor forum — simultaneous sessions trigger abuse checks / logout](https://forum.cursor.com/t/can-a-cursor-subscription-be-used-on-two-devices-simultaneously/91203)

## Google / xAI / Kiro / Kimi — grades 45–55 (uncertain, NOT cleared)

I could not verify a pooling-specific clause for these with 2 independent sources. General service
terms (Google, AWS) bar automated abuse and limit circumvention, so pooling is plausibly disallowed
even without a named clause. **Uncertain is treated as risky, not safe** → all default `lazy-only`,
proactive opt-in only. Filling these to citable certainty is a follow-up research item.

> 출처: [Google APIs Terms of Service](https://developers.google.com/terms) (general automated-abuse bar; no pooling-specific clause cited)
> 출처: [AWS Service Terms](https://aws.amazon.com/service-terms/) (general circumvention bar; Kiro/CodeWhisperer specifics not verified)

## Does proactive refresh itself look like abuse? (direct answer to the user)

Yes, at the margin. A background scheduler that re-authenticates idle consumer-subscription tokens
on a timer produces server-visible token traffic with no correlated product usage — the signature
vendors use to distinguish a human on the official client from an automated harness. That is the
core reason the guardian is **off by default and per-provider gated**: the survival benefit is only
worth the added detection surface for pools the user knowingly accepts (the Codex case), and is
never worth it for Anthropic given active enforcement.
