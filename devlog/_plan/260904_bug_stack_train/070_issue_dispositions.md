# 070 — Bug-issue dispositions

Six open bug-labelled issues, each root-caused against the current tree. None is
safely fixable from the evidence attached today. Deferring is the disposition, not
an absence of one.

| Issue | Disposition | Why |
|-------|-------------|-----|
| #3352 | NEEDS_REPORTER_EVIDENCE | Mechanism is fully traced, cause is not. Letting `unknown` entitlement through would be a security-policy change, not a bug fix. |
| #3320 | NEEDS_REPORTER_EVIDENCE | Production XML writes a locale-independent SID; exact `<UserId>` matching is deliberate. Needs redacted live XML. |
| #3279 | NEEDS_REPORTER_EVIDENCE | Each page load mints a session from its own Host-derived origin; the exact origin check IS the admission boundary. |
| #3255 | PRODUCT_DECISION | Reasoning and speed are already independent dimensions; there is no Ultra-fast wire tier to pass through. |
| #3245 | NEEDS_REPORTER_EVIDENCE | The reporter saw no POST after the 426, which puts the failure before the Responses bridge. |
| #1527 | NEEDS_REPORTER_EVIDENCE | Every known defect in this path is already fixed; needs a matched current-dev trace. |

## The pattern worth naming

Three of these (#3352, #3320, #3279) have an obvious-looking fix that is the wrong
trade: allow the unconfirmed entitlement, fold non-ASCII identities together, treat
localhost/IPv4/IPv6 as one origin. Each would make the symptom go away by widening a
trust boundary, without a reproduction proving that boundary is what failed. A bug
report is not evidence that the check causing the symptom is the wrong check.

Full mechanism traces with file:line are in `000_research.md`.
