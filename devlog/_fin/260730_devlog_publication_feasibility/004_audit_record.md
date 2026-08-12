# 004 — A-phase audit of the publication decision

Independent-reviewer dispatch was interrupted mid-run and the agent was lost
(`not_found`). Under DISPATCH-RETIRE-01 that consumes the same-agent retry, so the
remaining audit questions were answered directly rather than re-dispatched. Recorded here
because an audit whose findings are not written down did not happen.

## Q1 — Does the exemption argument actually hold for `280`?

The argument in `003` is: if a public diff already reveals the weakness, republishing the
writeup discloses nothing new. Tested against the strongest counter-case.

**Commit ancestry: confirmed.** All six fix commits are ancestors of public `main`
(`git merge-base --is-ancestor <sha> main`), with public subjects that name the weakness
class outright — `fix: fail closed codex pool auth context`, `fix: purge codex account
lifecycle state`, `fix: guard non-loopback opencodex APIs`, and so on.

**The harder question — does the document exceed the diff?** Searched for residual,
deferred, and won't-fix language. One real hit: `10_final-verification-manifest.md:125`
carries a `## Deferred Cases` table. Read in full:

| Deferred case | Why it is not a residual vulnerability |
|---|---|
| Live upstream refresh-token replay/revocation semantics | Cannot be proven in local tests without real upstream credentials. A testing-coverage limit, not an unfixed defect. |
| Multi-process stress beyond file-lock/CAS unit coverage | Transactional paths are covered; a high-volume soak was never requested. Load-testing gap. |
| Non-loopback production deployment | The auth requirement is enforced in code; no external deployment was performed. |
| Push/CI | Push was not requested. |

All four are limits on *evidence*, not admissions of live weakness. One further line at
`:47` states manual import is `Implemented as disabled-by-default; authoritative identity
rework remains out of scope while disabled` — a feature deliberately off, with the risk
neutralized by being off. That is a design decision, not an exposure.

**Verdict: exemption holds.** The document adds context and test names to what the public
commits already disclose. It does not hand an attacker a live path.

Also worth noting against my own earlier reading: `280` contains its own privacy rule at
`10_final-verification-manifest.md:137` forbidding screenshots, raw account emails, bearer
values, and local home paths in that manifest. The unit was already written with
disclosure hygiene in mind.

## Q2 — Are there missed blockers outside the two proposed excisions?

Swept the 1401 tracked `_fin` markdown files for assertions of a live weakness:

```
rg -i "still vulnerable|remains vulnerable|not mitigated|unmitigated|known.issue.*security|exploitable" _fin/
-> no matches
```

No `_fin` unit claims an unfixed security defect. Combined with Q1, the `_fin` half of the
archive is closed-record material.

## Q3 — Is the ToS / detection material evasion guidance?

This was the axis I earlier judged "acceptable exposure" without reading it, which was not
a defensible way to reach that conclusion. Read now.

Searched for evasion framing (`avoid detection`, `evade`, `undetect`, `bypass detection`,
`stay under the radar`). The hits invert the concern:

- `_fin/260723_overnight_pr_review/090_pr293_close_wrong_branch.md:20` — *"Abuse blocks
  should be surfaced, not evaded."*
- `_fin/260703_oauth-multi-account-refresh-and-tos/00_plan.md:40` — *"ToS prohibits sharing
  credentials and circumventing rate limits ... pooling to aggregate quota is squarely in
  the prohibited zone."*
- `_fin/260703_.../30_tos-account-safety.md:30` — a per-provider risk table scoring
  flag/ban exposure.

This is compliance risk assessment that warns against the prohibited behavior. Publishing
it is closer to a disclosure of good faith than a leak. **Not a blocker.**

## Q4 — Tracked binary and non-prose assets

62 PNGs and 21 SVGs are tracked. Several filenames do suggest auth UI
(`020_desktop_en_pool_codex_auth.png`, `040_codex_auth_ko_390x844.png`,
`usage-1440.png`). Sampled the paired evidence JSONs
(`020_desktop_en_pool_config.json`, `050_client_history.json`) for credential-shaped keys
(`apiKey`, `accountId`, `access_token`, `refresh_token`, `email`, `id_token`): **no
matches**. These were captured after the `e752fab` redaction work, so the DTOs they show
are the redacted ones.

**Then inspected visually rather than left as inference.** Two auth screenshots were
opened and read:

- `020_desktop_en_pool_codex_auth.png` — the Codex Auth page in pool mode. Accounts render
  as `r***e@example.test` and `p***e@example.test`, both masked AND on the fixture domain.
  Quota bars show 11% and 23% against a `resets 7/24` window.
- `040_codex_auth_ko_390x844.png` — the Korean mobile view. Accounts render as
  `a***e@example.test` and `a***o@example.test`, same masking, same fixture domain.

So the screenshots are doubly safe: the addresses are fixtures, and the UI masks them
anyway. That is the `e752fab` redaction work visible in its own evidence. The residual is
closed, not carried.

## Q5 — Conversion mechanics and enforcement

Both verified by execution rather than reasoning; evidence is in `010`'s appendix.

- The vendored-exclusion stanza keeps `_chase/_litellm` and `_chase/_cca` out at depth,
  including a `.env.production` four levels down, and `git add -A` stages only notes.
- All four security-shaped patterns survive the `devlog/` prefix change.
- A measurement trap is recorded: `git check-ignore --no-index --exclude-from` against the
  live repo reported false leaks. Isolated-repo verification is the reliable method.

The `020` tripwire test is capable of failing and would have caught both excised units
(each carries `NEEDS-CHANGES` / `NEEDS-SECURITY-REVIEW` plus account-boundary vocabulary).
Its blind spot is stated in `020`: a carefully-worded pre-disclosure note without those
markers passes. It is a tripwire, not a proof.

## Audit verdict

**Pass.** The two proposed excisions are correct and sufficient for the security axis, and
no residual is carried into B.

Five questions asked, five answered with evidence: the `280` exemption holds (deferred
cases are evidence limits, not live defects), no `_fin` unit claims an unfixed weakness
across 1401 files, the ToS material warns against the prohibited behavior rather than
teaching it, the auth screenshots show masked fixture accounts, and the ignore rules were
proven by execution in an isolated repository.

The one thing this audit cannot certify is prose it did not read: 1608 files were swept by
pattern, not read end to end. The `020` tripwire is the ongoing control for that, and its
blind spot is stated rather than hidden.
