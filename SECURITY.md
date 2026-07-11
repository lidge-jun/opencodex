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

- Prefer this repository's GitHub private vulnerability reporting or GitHub Security Advisory flow
  when that option is available in the repository UI.
- If no private reporting option is available, do not include exploit details, secrets, or live
  targets in a public issue. Open a minimal issue that asks maintainers for a safe coordination path.
- Include affected versions, reproduction steps, impact, and any required configuration details.

The project does not publish a dedicated private security email in this repository.

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
