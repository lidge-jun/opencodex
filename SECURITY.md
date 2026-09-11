# Security Policy

## Supported Versions

opencodex accepts security fixes on a best-effort basis for these lines:

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Latest published npm release | ✅ |
| Older releases | ❌ |

If you report an issue against an older release, maintainers may ask you to reproduce it on `main`
or the latest published package before triage continues.

## Reporting a Vulnerability

Please avoid posting undisclosed vulnerabilities as public GitHub issues.

Report privately through GitHub private vulnerability reporting, which is enabled on this
repository:

**<https://github.com/lidge-jun/opencodex/security/advisories/new>**

The same form is reachable from the repository's **Security** tab under **Report a vulnerability**.
It is private between you and the maintainers, and it is the only channel this project offers for
undisclosed vulnerabilities — there is no dedicated private security email.

Include affected versions, reproduction steps, impact, and any required configuration details.

If the form is ever unreachable for you, open a minimal public issue that asks maintainers for a
safe coordination path. Do not include exploit details, secrets, or live targets in that issue.

### Public or private

Being findable in the source is not disclosure. opencodex is source-available, so nearly every
defect here is in principle "visible in the code" — that is not the test, and it is not a reason
to open a public issue.

The test is whether the weakness is already public: the fix has shipped, or the defect is
already described in a published advisory, issue, or pull request. When that is true, ordinary
public review applies and a normal issue or pull request is the right route. When it is not, the
report is pre-disclosure material and belongs in the private advisory form, whatever its
severity looks like to you.

If you are unsure, file privately. Maintainers can move a report to public review once it is
safe to do so; the reverse is not possible.

## Following Up on a Report You Already Filed

Keep follow-up inside the private report. The advisory thread you opened stays open for
comments, and that is where new evidence, corrected impact, and questions about status belong.
There is no second private route: GitHub private vulnerability reporting is the only technical
channel this project offers, and there is no security email to escalate to.

If the private thread itself is stalled or unreachable, a public issue may carry **coordination
only** — a request for a safe follow-up path, or a note that a filed report is still awaiting a
response. Keep it free of the vulnerability: no reproduction steps, no exploit reasoning, no
logs or attachments, no narrowing of affected versions, and no advisory identifiers or links.
You do not need to say which report you mean; maintainers can match it privately, and naming it
in public is itself a signal.

A maintainer may answer such an issue in public. Read that answer narrowly — it confirms the
route, not the content of anything you reported.

## Response Expectations

Maintainers will review reports on a best-effort basis. Triage usually starts with:

- confirming the affected version or commit,
- reproducing the issue locally,
- evaluating impact and safe remediation scope,
- coordinating disclosure timing if a fix is needed.

Receipt is not triage. An acknowledgment — including a maintainer confirming they can reach the
private reporting queue — means the message arrived. It does not mean the report has been
reproduced, assessed for impact, assigned an owner, or accepted. The private thread is the only
place the technical outcome is recorded.

Public review of a published patch does not close the corresponding private report, and it does
not settle disclosure for anything else you filed. Landing a fix resolves the handling route for
that fix; the private report closes when maintainers close it.

There is no response deadline. Review is best-effort, as stated above, and this project does not
publish a first-response target — please do not read one into an acknowledgment or into the
triage steps listed here.

## Operational Notes

- Remove secrets, tokens, cookies, and personal data from screenshots and logs before sharing them.
- For non-sensitive hardening ideas, public issues and pull requests are welcome after disclosure is
  no longer sensitive.
