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

## Response Expectations

Maintainers will review reports on a best-effort basis. Triage usually starts with:

- confirming the affected version or commit,
- reproducing the issue locally,
- evaluating impact and safe remediation scope,
- coordinating disclosure timing if a fix is needed.

## Operational Notes

- Remove secrets, tokens, cookies, and personal data from screenshots and logs before sharing them.
- For non-sensitive hardening ideas, public issues and pull requests are welcome after disclosure is
  no longer sensitive.
