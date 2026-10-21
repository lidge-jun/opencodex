---
title: Windows Code Signing
description: How OpenCodex signs its Windows binaries through SignPath Foundation, how to verify a signature, and the project's code signing policy.
---

OpenCodex is moving its Windows downloads, the standalone `ocx.exe` and the desktop installer
`OpenCodex-<version>-windows-x64.msi`, to Authenticode code signing through
[SignPath Foundation](https://signpath.org). A signed file tells Windows, SmartScreen and antivirus
products who published it and that nobody changed it after the build, which is what stops
unsigned-binary false positives like the one reported in
[#7207](https://github.com/lidge-jun/opencodex/issues/7207).

Signing is rolling out. The release workflow is wired, and SignPath is validating it with a test
certificate. Until the production certificate is issued, Windows release files stay unsigned, and
SmartScreen may ask once (**More info → Run anyway**). Releases published after that switch carry
a signature from **SignPath Foundation**.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by
[SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [lidge-jun](https://github.com/lidge-jun)
- Approvers: [lidge-jun](https://github.com/lidge-jun)

Every signing request for a release is approved by hand in SignPath before the certificate is
used. Only binaries built from this repository's source by GitHub Actions are signed. Third-party
files bundled with a release, such as the prebuilt keyring addons, keep their upstream form; the
SignPath Foundation policy forbids signing them with the project certificate.

### Privacy

This program will not transfer any information to other networked systems unless specifically
requested by the user or the person installing or operating it. In practice, OpenCodex forwards
requests to the providers you configure. To look for new versions it also reads release
metadata from GitHub and the npm registry, and those checks carry none of your prompts,
credentials or usage data.

## Verifying a download

In PowerShell, check the file you downloaded:

```powershell
Get-AuthenticodeSignature .\OpenCodex-<version>-windows-x64.msi | Format-List Status, SignerCertificate
Get-AuthenticodeSignature .\ocx.exe | Format-List Status, SignerCertificate
```

A signed release reports `Status : Valid` and a signer certificate whose subject names
`SignPath Foundation`. In Explorer, the same information is under **Properties → Digital
Signatures**. Every release file also has a `.sha256` next to it on the release page, which you can
compare with `Get-FileHash <file> -Algorithm SHA256`.

## What gets signed

| File | Signed contents |
|---|---|
| `ocx-<version>-bun-windows-x64.zip` | `ocx.exe` inside the archive. The zip and its `.sha256` are built from the signed binary. |
| `OpenCodex-<version>-windows-x64.msi` | The installer, plus every `.exe` it installs (the desktop app and its bundled `ocx.exe`). |

The desktop updater signature (`.msi.sig`) and `latest.json` are produced from the signed
installer, so in-app updates install the same bytes the release page offers.

## For maintainers

The release workflow (`.github/workflows/release.yml`) signs through the official
`signpath/github-action-submit-signing-request` action. It reads one secret and three repository
variables:

| Name | Kind | Value |
|---|---|---|
| `SIGNPATH_API_TOKEN` | secret | API token of the SignPath CI user |
| `SIGNPATH_ORGANIZATION_ID` | variable | SignPath organization ID |
| `SIGNPATH_PROJECT_SLUG` | variable | `opencodex` |
| `SIGNPATH_SIGNING_POLICY_SLUG` | variable | `test-signing` today; `release-signing` once the certificate is issued |

SignPath artifact configurations: `windows-standalone-zip` (one `ocx.exe` at the zip root) and
`windows-msi-zip` (one `.msi` at the zip root, deep-signed).

Signing never blocks a release. What a run does depends on the policy:

| Policy | Dry run | Real release |
|---|---|---|
| No token, or an incomplete configuration | Unsigned | Unsigned, with a notice or warning |
| `test-signing` | Signed with the test certificate, kept only as a workflow artifact | Unsigned, with a notice; a test certificate never ships |
| `release-signing` | Signed and verified as trusted | Signed and verified as trusted |

If a signing request fails, times out or is rejected, or if verification fails, the job logs a
warning and ships the unsigned file together with its original updater signature.

**Switching to the production certificate.** Once SignPath issues it, set the repository variable
`SIGNPATH_SIGNING_POLICY_SLUG` to `release-signing` (Settings → Secrets and variables → Actions →
Variables). No workflow change is needed. From then on, every release, including a dry run, opens
two signing requests (the standalone binary and the installer). An approver must approve both in
[app.signpath.io](https://app.signpath.io) while the run waits. The workflow waits up to an hour
per request before it gives up and ships unsigned.

**Testing without publishing.** The **Windows signing test** workflow
(`.github/workflows/windows-signing-test.yml`, manual dispatch only, no inputs) builds `ocx.exe`
and the MSI on GitHub-hosted Windows runners, signs both with `test-signing`, verifies the
signatures, and keeps the test-signed files as short-lived workflow artifacts. It publishes
nothing and never uses the release policy.
